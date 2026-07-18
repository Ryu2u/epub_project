"""BookService：业务层，粘合 reader / db / fs。

所有对外公开的 async 方法。

设计要点：
- reader 是同步 IO 重操作，调用时用 asyncio.to_thread 跑在线程池里，不阻塞事件循环
- DB 写入用单个 session（add_book 不用事务分段，简单可靠）
- 删除靠 ORM cascade + 手动删文件
"""

from __future__ import annotations

import asyncio
import shutil
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from epub_backend.db.models import Asset as AssetORM
from epub_backend.db.models import Book as BookORM
from epub_backend.db.models import Chapter as ChapterORM
from epub_backend.reader.epub_reader import open_epub
from epub_backend.reader.errors import EpubReaderError
from epub_backend.reader.models import Book as BookDomain
from epub_backend.storage import filesystem as fs


class BookService:
    """业务层入口。所有方法 async，接收 AsyncSession。"""

    def __init__(self, session: AsyncSession, storage_dir: Path) -> None:
        self.session = session
        self.storage_dir = storage_dir

    # ---------- 上传 ----------

    async def add_book(
        self,
        upload_chunks: AsyncIterator[bytes],
        filename: str,
    ) -> tuple[BookORM, list[str]]:
        """上传并入库。

        upload_chunks 必须是 async iterator（FastAPI UploadFile 自然产生）。

        流程：
        1. 流式写临时文件（原子）
        2. 算 sha256
        3. 查重（sha256 已存在 → 抛 DuplicateFileError，含已有 book）
        4. 跑 reader 解析（在线程池里，不阻塞事件循环）
        5. 写 DB（三张表）
        6. 把临时文件 rename 到 storage
        7. 任何 reader 错误 → 删临时文件 → 抛领域错误

        Returns: (BookORM, warnings list)
        """
        book_id = uuid.uuid4().hex
        # 临时文件先放 storage_dir 下，保证后续 rename 是同 fs
        tmp_dest = fs.generate_book_path(self.storage_dir, book_id=f".tmp_{book_id}")
        final_dest = fs.generate_book_path(self.storage_dir, book_id=book_id)

        try:
            # 1. 流式写
            await self._stream_to_file(upload_chunks, tmp_dest)

            # 2. sha256
            sha256 = await asyncio.to_thread(fs.compute_sha256, tmp_dest)
            file_size = fs.file_size(tmp_dest)

            # 3. 查重
            from epub_backend.reader.errors import DuplicateFileError

            existing = await self._find_by_sha(sha256)
            if existing is not None:
                # 删临时文件，抛错（带已有 book）
                fs.delete_file(tmp_dest)
                raise DuplicateFileError(
                    f"文件已存在 (id={existing.id}, title={existing.title!r})",
                    existing_book_id=existing.id,
                )

            # 4. reader（同步，跑线程池）
            domain = await asyncio.to_thread(open_epub, tmp_dest)

            # 5. 写 DB
            book_orm = self._domain_to_orm(domain, book_id, sha256, file_size, filename)
            self.session.add(book_orm)
            await self.session.commit()

            # 6. rename 临时文件到正式位置
            shutil.move(str(tmp_dest), str(final_dest))

            # 7. refresh from db
            await self.session.refresh(book_orm)
            return book_orm, domain.warnings

        except EpubReaderError:
            # reader 错误：删临时文件后重抛
            fs.delete_file(tmp_dest)
            raise
        except Exception:
            # 其他错误（DB 等）：也清理
            fs.delete_file(tmp_dest)
            raise
        finally:
            # 临时文件如果还存在（异常路径未删），兜底
            fs.delete_file(tmp_dest)

    # ---------- 列表 / 搜索 ----------

    async def list_books(
        self, q: str = "", page: int = 1, size: int = 20
    ) -> tuple[list[BookORM], int, dict, dict, dict]:
        """分页 + 搜索（title 或 authors like q）。

        返回 (books, total, chapter_counts, asset_counts, cover_ids)：
        不再 selectinload 整张 chapters/assets（会拉取全量 text/html 致列表巨慢），
        改用聚合 COUNT + 单独取封面 asset id。
        """
        stmt = select(BookORM)
        count_stmt = select(func.count()).select_from(BookORM)

        if q.strip():
            pattern = f"%{q.strip()}%"
            # SQLite 的 JSON 数组 LIKE 不友好；用纯 title 搜索足够 MVP
            stmt = stmt.where(BookORM.title.like(pattern))
            count_stmt = count_stmt.where(BookORM.title.like(pattern))

        offset = max(0, (page - 1) * size)
        stmt = stmt.order_by(BookORM.created_at.desc()).offset(offset).limit(size)

        books = list((await self.session.execute(stmt)).scalars().all())
        total = (await self.session.execute(count_stmt)).scalar_one()
        if not books:
            return books, total, {}, {}, {}

        ids = [b.id for b in books]

        chapter_counts = dict(
            (await self.session.execute(
                select(ChapterORM.book_id, func.count(ChapterORM.id))
                .where(ChapterORM.book_id.in_(ids))
                .group_by(ChapterORM.book_id)
            )).all()
        )
        asset_counts = dict(
            (await self.session.execute(
                select(AssetORM.book_id, func.count(AssetORM.id))
                .where(AssetORM.book_id.in_(ids))
                .group_by(AssetORM.book_id)
            )).all()
        )
        cover_ids = dict(
            (await self.session.execute(
                select(AssetORM.book_id, AssetORM.id)
                .where(AssetORM.book_id.in_(ids), AssetORM.is_cover == 1)
            )).all()
        )

        return books, total, chapter_counts, asset_counts, cover_ids

    # ---------- 详情 ----------

    async def get_book(self, book_id: str) -> BookORM | None:
        return await self.session.get(BookORM, book_id)

    async def get_chapter(self, book_id: str, chapter_id: str) -> ChapterORM | None:
        stmt = select(ChapterORM).where(
            ChapterORM.book_id == book_id, ChapterORM.id == chapter_id
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_asset(self, book_id: str, asset_id: str) -> tuple[AssetORM, bytes] | None:
        stmt = select(AssetORM).where(
            AssetORM.book_id == book_id, AssetORM.id == asset_id
        )
        asset = (await self.session.execute(stmt)).scalar_one_or_none()
        if asset is None:
            return None

        # 上传的封面：字节存在磁盘 {storage_dir}/covers/{asset_id}，不进 zip
        if asset.href.startswith("cover:"):
            cover_path = self.storage_dir / "covers" / asset.id
            if not cover_path.exists():
                return None
            return asset, cover_path.read_bytes()

        # 其它资源：从书的 .epb zip 内读
        book = await self.get_book(book_id)
        if book is None:
            return None
        file_path = self.storage_dir / Path(book.file_path).name
        if not file_path.exists():
            return None
        import zipfile

        with zipfile.ZipFile(file_path) as zf:
            try:
                data = zf.read(asset.href)
            except KeyError:
                return None
        return asset, data

    async def get_asset_map(self, book_id: str) -> dict[str, str]:
        """返回 {zip 内绝对 href: asset_id} 字典，供 API 层重写章节 HTML 的 <img src>。"""
        stmt = select(AssetORM.href, AssetORM.id).where(AssetORM.book_id == book_id)
        rows = (await self.session.execute(stmt)).all()
        return {href: aid for href, aid in rows}

    # ---------- 删除 ----------

    async def delete_book(self, book_id: str) -> bool:
        """删除书 + 级联清 chapters/assets + 文件。"""
        book = await self.session.get(BookORM, book_id)
        if book is None:
            return False
        file_path = self.storage_dir / Path(book.file_path).name

        # 先删 DB（cascade 会清子表）
        await self.session.delete(book)
        await self.session.commit()

        # 再删文件
        fs.delete_file(file_path)
        return True

    # ---------- 封面 ----------

    async def set_cover(
        self, book_id: str, image_bytes: bytes, media_type: str
    ) -> AssetORM | None:
        """为书籍设置（上传）封面。

        - image_bytes / media_type：封面图片字节与 MIME
        - 若该书已有封面资源：
            * 上传的旧封面（href 以 cover: 开头）：删磁盘文件 + 删 asset 行
            * EPUB 自带封面（在 zip 内）：只把 is_cover 置 0，不动 zip
        - 新封面字节写 {storage_dir}/covers/{asset_id}，插入 AssetORM(is_cover=1)
        - 书不存在返回 None
        """
        book = await self.get_book(book_id)
        if book is None:
            return None

        # 清理旧封面
        await self._clear_existing_cover(book_id)

        # 写新封面
        asset_id = uuid.uuid4().hex
        covers_dir = self.storage_dir / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)
        (covers_dir / asset_id).write_bytes(image_bytes)

        asset = AssetORM(
            id=asset_id,
            book_id=book_id,
            href=f"cover:{asset_id}",
            media_type=media_type,
            size=len(image_bytes),
            is_cover=1,
        )
        self.session.add(asset)
        await self.session.commit()
        await self.session.refresh(asset)
        return asset

    async def delete_cover(self, book_id: str) -> bool:
        """删除上传的封面。仅删除上传的（cover:）封面；EPUB 自带封面不动。
        无书或无上传封面返回 False。
        """
        book = await self.get_book(book_id)
        if book is None:
            return False

        stmt = select(AssetORM).where(
            AssetORM.book_id == book_id, AssetORM.is_cover == 1
        )
        asset = (await self.session.execute(stmt)).scalar_one_or_none()
        if asset is None or not asset.href.startswith("cover:"):
            return False

        cover_path = self.storage_dir / "covers" / asset.id
        if cover_path.exists():
            cover_path.unlink()
        await self.session.delete(asset)
        await self.session.commit()
        return True

    async def _clear_existing_cover(self, book_id: str) -> None:
        """清除当前封面标记：上传封面连文件+行一起删，EPUB 封面只置 0。"""
        stmt = select(AssetORM).where(
            AssetORM.book_id == book_id, AssetORM.is_cover == 1
        )
        asset = (await self.session.execute(stmt)).scalar_one_or_none()
        if asset is None:
            return
        if asset.href.startswith("cover:"):
            cover_path = self.storage_dir / "covers" / asset.id
            if cover_path.exists():
                cover_path.unlink()
            await self.session.delete(asset)
        else:
            asset.is_cover = 0
        await self.session.flush()

    # ---------- 内部辅助 ----------

    async def _find_by_sha(self, sha256: str) -> BookORM | None:
        stmt = select(BookORM).where(BookORM.file_sha256 == sha256)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def _stream_to_file(self, chunks: AsyncIterator[bytes], dest: Path) -> int:
        """流式写入：原子写、失败清理。"""
        import os
        import tempfile

        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_path: Path | None = None
        total = 0
        try:
            with tempfile.NamedTemporaryFile(
                dir=dest.parent,
                prefix=".tmp_",
                suffix=".epb",
                delete=False,
            ) as tmp:
                tmp_path = Path(tmp.name)
                async for chunk in chunks:
                    if chunk:
                        tmp.write(chunk)
                        total += len(chunk)
                tmp.flush()
                os.fsync(tmp.fileno())
            import shutil

            shutil.move(str(tmp_path), str(dest))
            tmp_path = None
        finally:
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink()
        return total

    def _domain_to_orm(
        self,
        domain: BookDomain,
        book_id: str,
        sha256: str,
        file_size: int,
        filename: str,
    ) -> BookORM:
        """domain Book → ORM Book（带 chapters + assets）。

        注意：必须用直接赋值而不是 .append()，避免 relationship 的 lazy load
        （新对象刚 add 还没在 DB，访问 chapters 会触发错误查询）。
        """
        chapters = [
            ChapterORM(
                id=ch.id,
                title=ch.title,
                spine_order=ch.order,
                href=ch.href,
                text=ch.text,
                html=ch.html,
                word_count=ch.word_count,
            )
            for ch in domain.chapters
        ]
        assets = [
            AssetORM(
                id=a.id,
                href=a.href,
                media_type=a.media_type,
                size=a.size,
                is_cover=1 if a.is_cover else 0,
            )
            for a in domain.assets
        ]

        book = BookORM(
            id=book_id,
            title=domain.title,
            authors=domain.authors,
            language=domain.language,
            publisher=domain.publisher,
            description=domain.description,
            pub_date=domain.pub_date,
            identifier=domain.identifier,
            file_path=f"{book_id}.epb",
            file_size=file_size,
            file_sha256=sha256,
            created_at=datetime.now(),
            chapters=chapters,
            assets=assets,
        )
        return book


async def stream_upload_chunks(upload_file) -> AsyncIterator[bytes]:
    """把 starlette UploadFile 转成异步分块迭代器。

    FastAPI 的 UploadFile 是异步读，service 层接受 async iterator。
    """
    while True:
        chunk = await upload_file.read(1024 * 1024)
        if not chunk:
            break
        yield chunk
