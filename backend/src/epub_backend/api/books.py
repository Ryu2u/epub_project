"""Books API 路由。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from epub_backend.api.schemas import (
    AssetOut,
    BookDetail,
    BookListResponse,
    BookSummary,
    ChapterContent,
    ChapterOut,
    ErrorBody,
    UploadResult,
)
from epub_backend.config import get_settings
from epub_backend.db.models import Book as BookORM
from epub_backend.db.session import get_session
from epub_backend.reader.errors import (
    EpubReaderError,
)
from epub_backend.services.book_service import BookService

router = APIRouter(prefix="/api/books", tags=["books"])


async def _service(session: AsyncSession = Depends(get_session)) -> BookService:
    settings = get_settings()
    return BookService(session, settings.storage_dir)


# ---------- helpers ----------

_ALLOWED_EXT = {".epub", ".epb"}


async def _read_upload_chunks(upload: UploadFile, max_bytes: int) -> AsyncIterator[bytes]:
    """异步流式读上传文件，限制最大字节数（超过抛 HTTPException）。"""
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "FILE_TOO_LARGE",
                    "message": f"文件超过 {max_bytes} 字节上限",
                },
            )
        yield chunk


def _book_to_detail(book: BookORM) -> BookDetail:
    return BookDetail(
        id=book.id,
        title=book.title,
        authors=book.authors,
        language=book.language,
        publisher=book.publisher,
        description=book.description,
        pub_date=book.pub_date,
        identifier=book.identifier,
        file_size=book.file_size,
        created_at=book.created_at,
        chapters=[
            ChapterOut.model_validate(c)
            for c in sorted(book.chapters, key=lambda x: x.spine_order)
        ],
        assets=[AssetOut.model_validate(a) for a in book.assets],
    )


def _book_to_summary(book: BookORM) -> BookSummary:
    cover_id = next((a.id for a in book.assets if a.is_cover), None)
    return BookSummary(
        id=book.id,
        title=book.title,
        authors=book.authors,
        language=book.language,
        chapter_count=len(book.chapters),
        asset_count=len(book.assets),
        file_size=book.file_size,
        has_cover=cover_id is not None,
        cover_id=cover_id,
        created_at=book.created_at,
    )


def _rewrite_chapter_html(
    html: str, chapter_href: str, asset_map: dict[str, str], book_id: str
) -> str:
    """把章节 HTML 中 <img src="..."> 和 SVG <image xlink:href="..."> 重写
    为 /api/books/{book_id}/assets/{asset_id} URL。

    asset_map: {zip 内绝对 href: asset_id}，由 service 层提供
    找不到对应 asset 时，移除该元素（避免前端破图）。

    真实 EPUB 里常见做法是把图放在 <svg><image> 里，calibre / Sigil 都这么出；
    我们同时处理两种情况。
    """
    from lxml import etree

    try:
        root = etree.fromstring(html.encode("utf-8"))
    except etree.XMLSyntaxError:
        return html  # 解析失败，原样返回

    chapter_dir = chapter_href.rsplit("/", 1)[0] if "/" in chapter_href else ""

    XHTML_NS = "http://www.w3.org/1999/xhtml"
    XLINK_NS = "http://www.w3.org/1999/xlink"

    img_tag = f"{{{XHTML_NS}}}img"
    svg_image_tag = "{http://www.w3.org/2000/svg}image"

    # 1) 常规 <img src="...">
    for img in list(root.iter(img_tag)):
        url = _resolve_image_url(img.get("src", ""), chapter_dir)
        if url is None:
            img.getparent().remove(img)
            continue
        asset_id = _match_asset(url, asset_map)
        if asset_id is None:
            img.getparent().remove(img)
            continue
        img.set("src", f"/api/books/{book_id}/assets/{asset_id}")

    # 2) SVG <image xlink:href="..."> 或 href="..."
    for image in list(root.iter(svg_image_tag)):
        url = _resolve_image_url(image.get("href", "") or image.get(f"{{{XLINK_NS}}}href", ""), chapter_dir)
        if url is None:
            image.getparent().remove(image)
            continue
        asset_id = _match_asset(url, asset_map)
        if asset_id is None:
            image.getparent().remove(image)
            continue
        image.set("href", f"/api/books/{book_id}/assets/{asset_id}")
        # 保留 xlink:href 也同步（部分老浏览器读 xlink）
        image.set(f"{{{XLINK_NS}}}href", f"/api/books/{book_id}/assets/{asset_id}")

    return etree.tostring(root, encoding="unicode", method="html")


def _resolve_image_url(src: str, chapter_dir: str) -> str | None:
    """解析 <img src> 或 <image href> 为 zip 内绝对路径，返回 None 表示不可处理。"""
    if not src:
        return None
    src = src.strip()
    if "#" in src:
        src = src.split("#", 1)[0]
    if not src:
        return None
    if src.startswith("/"):
        return src.lstrip("/")
    if src.startswith(("http://", "https://", "data:")):
        return None
    return _normalize_path(f"{chapter_dir}/{src}") if chapter_dir else src


def _match_asset(abs_href: str, asset_map: dict[str, str]) -> str | None:
    """按精确 href 找 asset id，失败按 basename 兜底。"""
    aid = asset_map.get(abs_href)
    if aid is not None:
        return aid
    base = abs_href.rsplit("/", 1)[-1]
    for k, v in asset_map.items():
        if k.rsplit("/", 1)[-1] == base:
            return v
    return None


def _normalize_path(path: str) -> str:
    parts: list[str] = []
    for p in path.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            if parts:
                parts.pop()
            continue
        parts.append(p)
    return "/".join(parts)


def _to_http_error(e: EpubReaderError) -> HTTPException:
    """领域错误 → HTTP 异常。"""
    code_to_status = {
        "INVALID_CONTAINER": 422,
        "INCOMPLETE_METADATA": 422,
        "DRM_DETECTED": 422,
        "CORRUPT_EPUB": 422,
        "DUPLICATE_FILE": 409,
    }
    status_code = code_to_status.get(e.code, 422)
    body = ErrorBody(
        code=e.code,
        message=str(e),
        phase=e.phase,
        existing_book_id=getattr(e, "existing_book_id", None) or None,
    )
    return HTTPException(
        status_code=status_code,
        detail=body.model_dump(exclude_none=True),
    )


# ---------- 端点 ----------


@router.get("", response_model=BookListResponse)
async def list_books(
    q: str = Query("", description="搜索关键字（title）"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    svc: BookService = Depends(_service),
) -> BookListResponse:
    items, total = await svc.list_books(q=q, page=page, size=size)
    # 列表不需要 chapters 详细
    return BookListResponse(
        items=[_book_to_summary(b) for b in items],
        total=total,
        page=page,
        size=size,
    )


@router.post("", response_model=UploadResult)
async def upload_book(
    file: UploadFile,
    svc: BookService = Depends(_service),
) -> UploadResult:
    settings = get_settings()

    # 扩展名校验
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={
                "code": "UNSUPPORTED_MEDIA",
                "message": f"仅支持扩展名 {sorted(_ALLOWED_EXT)}，收到 {suffix!r}",
            },
        )

    try:
        chunks = _read_upload_chunks(file, settings.max_upload_bytes)
        book, warnings = await svc.add_book(chunks, filename=file.filename or "unknown.epub")
        # refresh 关系以便详情返回
        await svc.session.refresh(book, ["chapters", "assets"])
        return UploadResult(book=_book_to_detail(book), warnings=warnings)
    except EpubReaderError as e:
        raise _to_http_error(e) from e


@router.get("/{book_id}", response_model=BookDetail)
async def get_book(
    book_id: str,
    svc: BookService = Depends(_service),
) -> BookDetail:
    book = await svc.get_book(book_id)
    if book is None:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"})
    await svc.session.refresh(book, ["chapters", "assets"])
    return _book_to_detail(book)


@router.get("/{book_id}/chapters/{chapter_id}", response_model=ChapterContent)
async def get_chapter(
    book_id: str,
    chapter_id: str,
    format: str = Query("text", pattern="^(text|html)$"),
    svc: BookService = Depends(_service),
) -> ChapterContent:
    ch = await svc.get_chapter(book_id, chapter_id)
    if ch is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "章节不存在"}
        )
    if format == "text":
        return ChapterContent(title=ch.title, content=ch.text, format="text")
    # html：重写 <img src> 为可访问的 assets API URL
    asset_map = await svc.get_asset_map(book_id)
    rewritten = _rewrite_chapter_html(ch.html, ch.href, asset_map, book_id)
    return ChapterContent(title=ch.title, content=rewritten, format="html")


@router.get("/{book_id}/assets/{asset_id}")
async def get_asset(
    book_id: str,
    asset_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    result = await svc.get_asset(book_id, asset_id)
    if result is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "资源不存在"}
        )
    asset, data = result
    return Response(content=data, media_type=asset.media_type)


@router.delete("/{book_id}", status_code=204)
async def delete_book(
    book_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    ok = await svc.delete_book(book_id)
    if not ok:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"}
        )
    return Response(status_code=204)


# DuplicateFileError 已在 errors.py 继承 EpubReaderError，
# 但需要在 upload 路由捕获时返回 409 + 已有 book id。
# _to_http_error 已经处理这个分支。
