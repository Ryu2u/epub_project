"""Books API 路由。

这个文件定义了所有和书籍相关的 API 端点（CRUD + 上传 + 导出）。
每个端点是一个 async 函数，通过装饰器绑定到 URL 路径。
"""

# __future__ 的 annotations 使类型标注在旧 Python 版本也能工作
from __future__ import annotations

# AsyncIterator 是异步迭代器的类型标注，用于 async for 循环
from collections.abc import AsyncIterator
from pathlib import Path

# APIRouter：路由组，把相关的端点组织在一起，最后挂载到主应用
# Depends：FastAPI 的依赖注入系统，自动解析和注入函数参数
# HTTPException：手动抛出 HTTP 错误
# Query：声明 URL 查询参数（如 ?q=xxx&page=1）
# UploadFile：处理文件上传
# status：包含 HTTP 状态码常量（如 413 = 文件太大）
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, status
from fastapi.responses import Response

# AsyncSession 是 SQLAlchemy 的异步数据库会话
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

# BookORM 是数据库中的书籍表模型（ORM = 对象关系映射，把数据库表映射为 Python 类）
from epub_backend.db.models import Book as BookORM

# get_session 是一个依赖函数，提供数据库会话
from epub_backend.db.session import get_session
from epub_backend.reader.errors import (
    EpubReaderError,
)
from epub_backend.services.book_service import BookService

# 创建路由实例：prefix 表示所有端点的 URL 前缀都是 /api/books
# tags 用于 API 文档分组，Swagger UI 中会按标签分类显示
router = APIRouter(prefix="/api/books", tags=["books"])


async def _service(session: AsyncSession = Depends(get_session)) -> BookService:
    """依赖注入函数：创建 BookService 实例。

    Depends(get_session) 让 FastAPI 自动：
    1. 调用 get_session() 获取数据库会话
    2. 把会话作为 session 参数传入
    3. 请求结束后自动关闭会话

    这样每个端点不需要手动创建数据库连接，FastAPI 统一管理生命周期。
    """
    settings = get_settings()
    return BookService(session, settings.storage_dir)


# ---------- helpers（辅助函数，供端点调用） ----------

# 允许上传的文件扩展名集合
_ALLOWED_EXT = {".epub", ".epb"}


async def _read_upload_chunks(upload: UploadFile, max_bytes: int) -> AsyncIterator[bytes]:
    """异步流式读上传文件，限制最大字节数（超过抛 HTTPException）。

    使用异步生成器（yield）按 1MB 分块读取文件，而不是一次性全部读入内存。
    这样即使上传很大的文件，内存占用也不会暴涨。
    yield 关键字使这个函数变成「生成器」：每次产出一块数据，调用方用 async for 逐块消费。
    """
    total = 0
    while True:
        # 每次读取 1MB（1024 * 1024 字节）
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break  # 读取完毕
        total += len(chunk)
        if total > max_bytes:
            # 413 = HTTP 状态码「请求实体过大」
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "FILE_TOO_LARGE",
                    "message": f"文件超过 {max_bytes} 字节上限",
                },
            )
        # yield 把数据「产出」给调用方，而不是 return（return 会结束函数）
        yield chunk


def _book_to_detail(book: BookORM) -> BookDetail:
    """将数据库 ORM 对象转换为 API 响应模型（详情版）。

    ORM 对象是 SQLAlchemy 从数据库读出来的 Python 对象，包含数据库所有字段。
    这里把它转换成 pydantic 模型，FastAPI 会自动序列化为 JSON 返回给前端。
    """
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
        # 章节列表：先按阅读顺序排序，再逐个转换为 pydantic 模型
        # model_validate() 是 pydantic v2 的方法，从 ORM 对象创建模型实例
        # sorted() 接收一个 key 函数，lambda x: x.spine_order 提取排序字段
        chapters=[
            ChapterOut.model_validate(c)
            for c in sorted(book.chapters, key=lambda x: x.spine_order)
        ],
        # 列表推导式（list comprehension）：[表达式 for 变量 in 可迭代对象]
        # 这是 Python 特有的简洁写法，等价于用 for 循环逐个转换并追加到列表
        assets=[AssetOut.model_validate(a) for a in book.assets],
    )


def _book_to_summary(
    book: BookORM,
    chapter_count: int = 0,
    asset_count: int = 0,
    cover_id: str | None = None,
) -> BookSummary:
    """将 ORM 对象转换为列表摘要模型（不含 chapters/assets 列表）。"""
    return BookSummary(
        id=book.id,
        title=book.title,
        authors=book.authors,
        language=book.language,
        chapter_count=chapter_count,
        asset_count=asset_count,
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

    为什么需要重写？EPUB 内部的图片路径是相对路径（如 ../images/cover.png），
    但前端无法直接访问 EPUB 压缩包内的文件。
    所以需要把这些路径替换为后端提供的 API 地址，前端才能加载图片。

    asset_map: {zip 内绝对 href: asset_id}，由 service 层提供
    找不到对应 asset 时，移除该元素（避免前端破图）。

    真实 EPUB 里常见做法是把图放在 <svg><image> 里，calibre / Sigil 都这么出；
    我们同时处理两种情况。
    """
    # lxml 是 Python 的高性能 XML/HTML 解析库（底层用 C 语言实现）
    from lxml import etree

    try:
        # 将 HTML 字符串解析为 XML 树结构（Element 树）
        # encode("utf-8") 因为 etree.fromstring 需要字节流
        root = etree.fromstring(html.encode("utf-8"))
    except etree.XMLSyntaxError:
        return html  # 解析失败，原样返回（容错处理）

    # 提取章节文件所在的目录路径，用于解析相对路径
    # rsplit("/", 1) 从右边分割一次，例如 "OEBPS/ch1.xhtml" -> ["OEBPS", "ch1.xhtml"]
    chapter_dir = chapter_href.rsplit("/", 1)[0] if "/" in chapter_href else ""

    # XML 命名空间（namespace）：HTML 和 SVG 用不同的命名空间区分标签
    # 在 lxml 中，带命名空间的标签格式是 {命名空间URI}标签名
    XHTML_NS = "http://www.w3.org/1999/xhtml"
    XLINK_NS = "http://www.w3.org/1999/xlink"

    img_tag = f"{{{XHTML_NS}}}img"
    svg_image_tag = "{http://www.w3.org/2000/svg}image"

    # 1) 处理常规 <img src="...">
    # list(root.iter(...)) 收集所有匹配标签（转为 list 是因为下面会修改树结构）
    for img in list(root.iter(img_tag)):
        # 解析图片的 src 为 zip 内的绝对路径
        url = _resolve_image_url(img.get("src", ""), chapter_dir)
        if url is None:
            # 无法处理的 URL（如外部链接、data: URI），直接移除该 <img> 标签
            img.getparent().remove(img)
            continue
        # 在 asset_map 中查找对应的资源 ID
        asset_id = _match_asset(url, asset_map)
        if asset_id is None:
            img.getparent().remove(img)
            continue
        # 将 src 替换为后端 API 地址
        img.set("src", f"/api/books/{book_id}/assets/{asset_id}")

    # 2) 处理 SVG <image xlink:href="..."> 或 href="..."
    for image in list(root.iter(svg_image_tag)):
        # 先尝试普通 href，再尝试 xlink:href（兼容不同 EPUB 版本）
        href = image.get("href", "") or image.get(f"{{{XLINK_NS}}}href", "")
        url = _resolve_image_url(href, chapter_dir)
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

    # 将修改后的 XML 树重新序列化为 HTML 字符串返回
    return etree.tostring(root, encoding="unicode", method="html")


def _resolve_image_url(src: str, chapter_dir: str) -> str | None:
    """解析 <img src> 或 <image href> 为 zip 内绝对路径，返回 None 表示不可处理。

    例如：
    - "../images/cover.png" -> "OEBPS/images/cover.png"（相对路径拼接）
    - "/OEBPS/images/cover.png" -> "OEBPS/images/cover.png"（绝对路径去掉前导 /）
    - "https://example.com/img.png" -> None（外部链接不处理）
    - "data:image/png;base64,..." -> None（内嵌数据不处理）
    """
    if not src:
        return None
    src = src.strip()
    # 去掉 URL 中的锚点部分（如 image.png#id -> image.png）
    if "#" in src:
        src = src.split("#", 1)[0]
    if not src:
        return None
    # 以 / 开头的是 EPUB 包内的绝对路径，去掉前导 /
    if src.startswith("/"):
        return src.lstrip("/")
    # 外部链接和 data URI 不处理（返回 None 会触发调用方删除该元素）
    if src.startswith(("http://", "https://", "data:")):
        return None
    # 相对路径：和章节目录拼接后规范化
    return _normalize_path(f"{chapter_dir}/{src}") if chapter_dir else src


def _match_asset(abs_href: str, asset_map: dict[str, str]) -> str | None:
    """按精确 href 找 asset id，失败按 basename 兜底。

    asset_map 的键是 zip 内绝对路径，值是资源 ID。
    先精确匹配路径，找不到的话用文件名兜底匹配
    （有些 EPUB 文件的路径写法不一致，但文件名相同）。
    """
    aid = asset_map.get(abs_href)
    if aid is not None:
        return aid
    # 兜底：只用文件名匹配（如 "images/cover.png" 和 "OEBPS/images/cover.png" 都取 "cover.png"）
    # rsplit("/", 1)[-1] 取路径最后一段作为文件名
    base = abs_href.rsplit("/", 1)[-1]
    for k, v in asset_map.items():
        if k.rsplit("/", 1)[-1] == base:
            return v
    return None


def _normalize_path(path: str) -> str:
    """规范化文件路径：去掉多余的 "." 和 ".."，类似于 Linux 的 realpath。

    例如 "OEBPS/../images/./cover.png" -> "images/cover.png"
    """
    parts: list[str] = []
    for p in path.split("/"):
        if p in ("", "."):
            continue  # 跳过空段和当前目录标记 "."
        if p == "..":
            if parts:
                parts.pop()  # ".." 表示返回上级目录，弹出最后一段
            continue
        parts.append(p)
    return "/".join(parts)


def _to_http_error(e: EpubReaderError) -> HTTPException:
    """领域错误 -> HTTP 异常。

    将业务层（BookService/Reader）抛出的领域错误转换为 FastAPI 能理解的 HTTP 异常。
    这样错误响应的格式与全局异常处理器保持一致。
    """
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
        # getattr 安全地获取属性，如果对象没有这个属性就返回默认值 None
        existing_book_id=getattr(e, "existing_book_id", None) or None,
    )
    return HTTPException(
        status_code=status_code,
        # model_dump() 将 pydantic 模型转为字典，exclude_none=True 表示不包含 None 值的字段
        detail=body.model_dump(exclude_none=True),
    )


# ---------- 端点（API 路由处理函数） ----------


# @router.get("") 注册一个 GET 请求处理函数
# 空路径 "" 加上 router 的 prefix "/api/books" 就是 GET /api/books
# response_model 指定响应的 pydantic 模型，FastAPI 会自动验证和序列化输出
@router.get("", response_model=BookListResponse)
# async def 表示这是一个异步函数，可以使用 await 等待异步操作（如数据库查询）
# 参数中的类型标注会被 FastAPI 用来做参数校验和文档生成
async def list_books(
    # Query() 声明 URL 查询参数：q 是搜索关键字，空字符串表示默认不搜索
    q: str = Query("", description="搜索关键字（title）"),
    # ge=1 表示 page 必须 >= 1（greater or equal）
    page: int = Query(1, ge=1),
    # le=100 表示 size 必须 <= 100（less or equal）
    size: int = Query(20, ge=1, le=100),
    # Depends(_service) 让 FastAPI 自动调用 _service() 注入 BookService 实例
    svc: BookService = Depends(_service),
) -> BookListResponse:
    """获取书籍列表（支持搜索和分页）。"""
    # svc.list_books 返回五个值，Python 称为「元组解包」
    books, total, ch_counts, as_counts, cover_ids = await svc.list_books(q=q, page=page, size=size)
    return BookListResponse(
        # 列表推导式：对每一本书调用 _book_to_summary 转换为摘要模型
        # .get(key, default) 是字典的安全取值方法，key 不存在时返回默认值
        items=[
            _book_to_summary(
                b,
                chapter_count=ch_counts.get(b.id, 0),
                asset_count=as_counts.get(b.id, 0),
                cover_id=cover_ids.get(b.id),
            )
            for b in books
        ],
        total=total,
        page=page,
        size=size,
    )


# POST /api/books — 上传 EPUB 文件
# response_model=UploadResult 表示返回上传结果（包含书籍详情和警告信息）
@router.post("", response_model=UploadResult)
# file: UploadFile 是 FastAPI 的文件上传类型，自动解析 multipart/form-data 请求体
async def upload_book(
    file: UploadFile,
    svc: BookService = Depends(_service),
) -> UploadResult:
    """上传并导入 EPUB 文件到书库。"""
    settings = get_settings()

    # 扩展名校验：只允许 .epub 和 .epb 文件
    # Path(file.filename).suffix 获取文件扩展名（如 ".epub"）
    # file.filename 可能为 None（没有文件名），所以用 "" 做后备
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_EXT:
        # 415 = HTTP 状态码「不支持的媒体类型」
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={
                "code": "UNSUPPORTED_MEDIA",
                "message": f"仅支持扩展名 {sorted(_ALLOWED_EXT)}，收到 {suffix!r}",
            },
        )

    try:
        # 获取文件内容的异步迭代器（分块读取）
        chunks = _read_upload_chunks(file, settings.max_upload_bytes)
        # 调用 service 层处理 EPUB 解析和入库，返回书籍对象和警告列表
        book, warnings = await svc.add_book(chunks, filename=file.filename or "unknown.epub")
        # refresh 关系以便详情返回
        # SQLAlchemy 默认不会加载关联数据（如 chapters、assets），需要显式刷新
        await svc.session.refresh(book, ["chapters", "assets"])
        return UploadResult(book=_book_to_detail(book), warnings=warnings)
    except EpubReaderError as e:
        # 如果是 EPUB 解析错误，转换为 HTTP 异常抛出
        raise _to_http_error(e) from e  # from e 保留原始异常链，便于调试


# GET /api/books/{book_id} — 获取单本书籍详情
# {book_id} 是路径参数，FastAPI 会自动从 URL 中提取并传给函数
@router.get("/{book_id}", response_model=BookDetail)
async def get_book(
    book_id: str,
    svc: BookService = Depends(_service),
) -> BookDetail:
    """获取单本书籍的详细信息（含章节和资源列表）。"""
    book = await svc.get_book(book_id)
    if book is None:
        # 404 = 未找到，手动抛出 HTTPException
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"})
    # 刷新关联数据（章节和资源列表）
    await svc.session.refresh(book, ["chapters", "assets"])
    return _book_to_detail(book)


# GET /api/books/{book_id}/chapters/{chapter_id} — 获取章节内容
@router.get("/{book_id}/chapters/{chapter_id}", response_model=ChapterContent)
async def get_chapter(
    book_id: str,
    chapter_id: str,
    # format 查询参数：只允许 "text" 或 "html" 两个值
    # pattern 是正则表达式校验，^(text|html)$ 确保完全匹配
    format: str = Query("text", pattern="^(text|html)$"),
    svc: BookService = Depends(_service),
) -> ChapterContent:
    """获取指定章节的内容（纯文本或 HTML 格式）。"""
    ch = await svc.get_chapter(book_id, chapter_id)
    if ch is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "章节不存在"}
        )
    if format == "text":
        # 纯文本模式：直接返回解析后的文本内容
        return ChapterContent(title=ch.title, content=ch.text, format="text")
    # html 模式：重写 <img src> 为可访问的 assets API URL
    # 因为 EPUB 内部的图片路径是相对于 EPUB 包的，前端无法直接加载
    asset_map = await svc.get_asset_map(book_id)
    rewritten = _rewrite_chapter_html(ch.html, ch.href, asset_map, book_id)
    return ChapterContent(title=ch.title, content=rewritten, format="html")


# GET /api/books/{book_id}/assets/{asset_id} — 获取资源文件（图片、样式等）
# 注意：没有 response_model，因为返回的是二进制文件（图片等），不是 JSON
@router.get("/{book_id}/assets/{asset_id}")
async def get_asset(
    book_id: str,
    asset_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    """返回资源文件的原始二进制内容（如图片、CSS）。"""
    result = await svc.get_asset(book_id, asset_id)
    if result is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "资源不存在"}
        )
    # 解包：result 是 (asset元数据, 二进制数据) 的元组
    asset, data = result
    # Response 直接返回二进制数据，media_type 告诉浏览器这是什么类型（如 image/png）
    return Response(content=data, media_type=asset.media_type)


# DELETE /api/books/{book_id} — 删除书籍
# status_code=204 表示成功时返回 204 No Content（删除成功，没有返回体）
@router.delete("/{book_id}", status_code=204)
async def delete_book(
    book_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    """删除指定书籍及其所有文件。"""
    ok = await svc.delete_book(book_id)
    if not ok:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"}
        )
    return Response(status_code=204)


# ---------- 封面管理 ----------

# 允许的封面图片 MIME 类型集合
_ALLOWED_COVER_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
# 封面单文件上限 5 MB（5 * 1024 * 1024 字节）
_MAX_COVER_BYTES = 5 * 1024 * 1024


# POST /api/books/{book_id}/cover — 上传封面图片
@router.post("/{book_id}/cover", response_model=BookDetail)
async def upload_cover(
    book_id: str,
    file: UploadFile,
    svc: BookService = Depends(_service),
) -> BookDetail:
    """为指定书籍上传自定义封面图片。"""
    # file.content_type 是浏览器告诉服务器的文件 MIME 类型
    media_type = (file.content_type or "").lower()
    if media_type not in _ALLOWED_COVER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={
                "code": "UNSUPPORTED_MEDIA",
                "message": f"封面仅支持图片 {sorted(_ALLOWED_COVER_TYPES)}，收到 {media_type!r}",
            },
        )

    # 读字节（带大小限制）
    # _read_upload_chunks 返回异步迭代器，用 async for 逐块读取
    # b"".join([...]) 将所有块拼接为一个完整的字节串
    chunks = _read_upload_chunks(file, _MAX_COVER_BYTES)
    image_bytes = b"".join([c async for c in chunks])

    # 调用 service 层保存封面
    asset = await svc.set_cover(book_id, image_bytes, media_type)
    if asset is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"}
        )

    # 重新获取书籍信息并刷新关联数据，返回更新后的详情
    book = await svc.get_book(book_id)
    await svc.session.refresh(book, ["chapters", "assets"])
    return _book_to_detail(book)


# DELETE /api/books/{book_id}/cover — 删除封面
@router.delete("/{book_id}/cover", status_code=204)
async def delete_cover(
    book_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    """删除指定书籍的自定义封面（恢复为 EPUB 原始封面或无封面）。"""
    ok = await svc.delete_cover(book_id)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail={"code": "NOT_FOUND", "message": "书不存在或无上传封面"},
        )
    return Response(status_code=204)


# ---------- 导出 EPUB ----------

# noqa: E402 表示忽略 PEP8 的 E402 规则（模块级导入应放在文件顶部）
# 这里把 re 和 urllib.parse 的导入放后面，是因为上面都是端点定义，逻辑上更紧凑
import re  # noqa: E402
from urllib.parse import quote  # noqa: E402

# 用于清理文件名中不允许的字符（Windows 不允许 \ / : * ? " < > |）
_FILENAME_INVALID = re.compile(r'[\\/:*?"<>|]')


# GET /api/books/{book_id}/export — 导出书籍为 EPUB 文件
@router.get("/{book_id}/export")
async def export_book(
    book_id: str,
    svc: BookService = Depends(_service),
) -> Response:
    """将书籍导出为 EPUB 文件供下载。"""
    result = await svc.export_epub(book_id)
    if result is None:
        raise HTTPException(
            status_code=404, detail={"code": "NOT_FOUND", "message": "书不存在"}
        )
    book, epub_bytes = result

    # --- 文件名处理 ---
    # HTTP Content-Disposition header 中的 filename 限制为 ASCII（latin-1 编码），
    # 非 ASCII 字符（如中文书名）会导致乱码或错误。
    # 解决方案：用 filename= 提供 ASCII 后备名，用 filename*=UTF-8'' 提供真正的 UTF-8 文件名。
    # 现代浏览器会优先使用 filename*，旧浏览器降级使用 filename。

    # _FILENAME_INVALID.sub("_", ...) 将文件名中的非法字符替换为下划线
    safe = _FILENAME_INVALID.sub("_", book.title).strip() or "book"
    # encode("ascii", "ignore") 去掉非 ASCII 字符（如中文），作为后备文件名
    ascii_fallback = safe.encode("ascii", "ignore").decode("ascii").strip() or "book"
    # quote(safe) 对 UTF-8 文件名进行 URL 编码（RFC 5987 格式）
    disposition = (
        f"attachment; filename=\"{ascii_fallback}.epub\"; "
        f"filename*=UTF-8''{quote(safe)}.epub"
    )
    # 返回 EPUB 文件的二进制内容
    return Response(
        content=epub_bytes,
        media_type="application/epub+zip",
        headers={"Content-Disposition": disposition},
    )


# DuplicateFileError 已在 errors.py 继承 EpubReaderError，
# 但需要在 upload 路由捕获时返回 409 + 已有 book id。
# _to_http_error 已经处理这个分支。
