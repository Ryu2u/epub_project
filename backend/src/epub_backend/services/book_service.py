"""BookService：业务层，粘合 reader / db / fs。

所有对外公开的 async 方法。

设计要点：
- reader 是同步 IO 重操作，调用时用 asyncio.to_thread 跑在线程池里，不阻塞事件循环
- DB 写入用单个 session（add_book 不用事务分段，简单可靠）
- 删除靠 ORM cascade + 手动删文件

async def：异步函数，只能在事件循环中调用（如 FastAPI 的路由），
可以在内部使用 await 暂停等待（如等数据库响应），期间不阻塞其他请求。
"""

from __future__ import annotations

import asyncio  # Python 异步编程核心库
import shutil  # 高级文件操作（如 move 跨文件系统）
import uuid  # 生成 UUID（通用唯一标识符）
from collections.abc import AsyncIterator, Iterator  # 异步/同步迭代器类型
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select  # func：SQL 函数（如 COUNT）；select：构建 SELECT 查询
from sqlalchemy.ext.asyncio import AsyncSession

# ORM 别名：把 ORM 模型重命名为 XxxORM 便于区分领域模型和 ORM 模型
from epub_backend.db.models import Asset as AssetORM
from epub_backend.db.models import Book as BookORM
from epub_backend.db.models import Chapter as ChapterORM
from epub_backend.reader.epub_reader import open_epub
from epub_backend.reader.errors import EpubReaderError
from epub_backend.reader.models import Book as BookDomain  # 领域模型 Book
from epub_backend.storage import filesystem as fs


class BookService:
    """业务层入口。所有方法 async，接收 AsyncSession。"""

    def __init__(self, session: AsyncSession, storage_dir: Path) -> None:
        # __init__：构造函数，创建 BookService 实例时传入数据库会话和文件存储目录
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
        AsyncIterator[bytes]：异步迭代器，每次 yield 一块字节数据。

        流程：
        1. 流式写临时文件（原子）
        2. 算 sha256
        3. 查重（sha256 已存在 -> 抛 DuplicateFileError，含已有 book）
        4. 跑 reader 解析（在线程池里，不阻塞事件循环）
        5. 写 DB（三张表）
        6. 把临时文件 rename 到 storage
        7. 任何 reader 错误 -> 删临时文件 -> 抛领域错误

        Returns: (BookORM, warnings list) -- ORM 对象和解析警告列表
        """
        book_id = uuid.uuid4().hex  # 生成 32 位十六进制 UUID 字符串作为书籍 ID
        # 临时文件先放 storage_dir 下，保证后续 rename 是同文件系统（rename 要求同一文件系统才原子）
        tmp_dest = fs.generate_book_path(self.storage_dir, book_id=f".tmp_{book_id}")
        final_dest = fs.generate_book_path(self.storage_dir, book_id=book_id)

        try:
            # 1. 流式写：把上传的数据块写入临时文件
            await self._stream_to_file(upload_chunks, tmp_dest)

            # 2. sha256：计算文件哈希，用于去重
            # to_thread：把同步函数放到线程池执行，避免阻塞异步事件循环
            sha256 = await asyncio.to_thread(fs.compute_sha256, tmp_dest)
            file_size = fs.file_size(tmp_dest)

            # 3. 查重：检查数据库中是否已有相同文件
            from epub_backend.reader.errors import DuplicateFileError

            existing = await self._find_by_sha(sha256)
            if existing is not None:
                # 删临时文件，抛错（带已有 book 的信息）
                fs.delete_file(tmp_dest)
                raise DuplicateFileError(
                    f"文件已存在 (id={existing.id}, title={existing.title!r})",
                    existing_book_id=existing.id,
                )

            # 4. reader（同步，跑线程池）：解析 EPUB 文件
            domain = await asyncio.to_thread(open_epub, tmp_dest)

            # 5. 写 DB：把领域模型转成 ORM 对象，写入数据库
            book_orm = self._domain_to_orm(domain, book_id, sha256, file_size, filename)
            self.session.add(book_orm)      # 把 ORM 对象添加到 session（准备写入）
            await self.session.commit()     # 提交事务（实际写入数据库）

            # 6. rename 临时文件到正式位置（原子操作）
            shutil.move(str(tmp_dest), str(final_dest))

            # 7. refresh from db：从数据库重新加载对象，确保所有字段（如自动生成的值）是最新的
            await self.session.refresh(book_orm)
            return book_orm, domain.warnings

        except EpubReaderError:
            # reader 错误：删临时文件后重抛给上层处理
            fs.delete_file(tmp_dest)
            raise
        except Exception:
            # 其他错误（DB 等）：也清理临时文件
            fs.delete_file(tmp_dest)
            raise
        finally:
            # finally 块：无论成功还是异常都会执行
            # 临时文件如果还存在（异常路径未删），兜底清理
            fs.delete_file(tmp_dest)

    # ---------- 列表 / 搜索 ----------

    async def list_books(
        self, q: str = "", page: int = 1, size: int = 20
    ) -> tuple[list[BookORM], int, dict, dict, dict]:
        """分页 + 搜索（title or authors like q）。

        返回 (books, total, chapter_counts, asset_counts, cover_ids)：
        不再 selectinload 整张 chapters/assets（会拉取全量 text/html 致列表巨慢），
        改用聚合 COUNT + 单独取封面 asset id。

        为什么要这样优化？因为每本书的章节可能有几十个，每个章节的 text/html 字段
        可能有几十 KB，如果用 ORM 的 relationship 自动加载（selectinload），
        列表页会把所有章节和资源都加载到内存，非常慢。
        所以改为：只加载 Book 本身，章节数量用 COUNT 聚合查询，封面 ID 单独查。
        """
        # 构建基础查询
        stmt = select(BookORM)                                    # SELECT * FROM books
        count_stmt = select(func.count()).select_from(BookORM)    # SELECT COUNT(*) FROM books

        if q.strip():
            pattern = f"%{q.strip()}%"  # SQL LIKE 模式：前后加 % 表示模糊匹配
            # SQLite 的 JSON 数组 LIKE 不友好；用纯 title 搜索足够 MVP
            stmt = stmt.where(BookORM.title.like(pattern))
            count_stmt = count_stmt.where(BookORM.title.like(pattern))

        # 分页计算
        offset = max(0, (page - 1) * size)  # 跳过前面的记录数
        stmt = stmt.order_by(BookORM.created_at.desc()).offset(offset).limit(size)
        # desc()：降序排列（最新的书排最前面）

        books = list((await self.session.execute(stmt)).scalars().all())
        # execute：执行查询；scalars()：提取第一列结果；all()：转为列表
        total = (await self.session.execute(count_stmt)).scalar_one()
        # scalar_one()：确保结果只有一行一列，取出那个标量值
        if not books:
            return books, total, {}, {}, {}

        ids = [b.id for b in books]  # 取出当前页所有书的 ID

        # 批量查询章节/资源数量和封面 ID，用 IN 子句一次查完
        chapter_counts = dict(
            (await self.session.execute(
                select(ChapterORM.book_id, func.count(ChapterORM.id))
                .where(ChapterORM.book_id.in_(ids))    # IN (id1, id2, ...) 只查当前页
                .group_by(ChapterORM.book_id)           # GROUP BY 按书分组计数
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
        """按 ID 获取一本书。session.get() 是主键查询。"""
        return await self.session.get(BookORM, book_id)

    async def get_chapter(self, book_id: str, chapter_id: str) -> ChapterORM | None:
        """按书 ID + 章节 ID 获取章节。"""
        stmt = select(ChapterORM).where(
            ChapterORM.book_id == book_id, ChapterORM.id == chapter_id
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()
        # scalar_one_or_none()：结果为空返回 None，有一行返回对象，多行抛异常

    async def get_asset(self, book_id: str, asset_id: str) -> tuple[AssetORM, bytes] | None:
        """获取资源及字节数据。

        资源的存储有两种情况：
        1. 上传的封面（href 以 "cover:" 开头）：字节存在磁盘 covers/ 目录
        2. EPUB 自带的资源：字节存在 .epb ZIP 文件中
        """
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
            return asset, cover_path.read_bytes()  # read_bytes() 一次读取全部内容

        # 其它资源：从书的 .epb zip 内读
        book = await self.get_book(book_id)
        if book is None:
            return None
        file_path = self.storage_dir / Path(book.file_path).name
        if not file_path.exists():
            return None
        import zipfile

        with zipfile.ZipFile(file_path) as zf:  # 打开 .epb 文件（本质是 ZIP）
            try:
                data = zf.read(asset.href)  # 按资源在 ZIP 内的路径读取
            except KeyError:
                return None  # ZIP 内没有这个文件
        return asset, data

    async def get_asset_map(self, book_id: str) -> dict[str, str]:
        """返回 {zip 内绝对 href: asset_id} 字典，供 API 层重写章节 HTML 的 <img src>。

        前端渲染章节时，需要把章节 HTML 中的图片路径替换为 API 的资源下载 URL。
        这个字典提供"原始路径 -> asset ID"的映射。
        """
        stmt = select(AssetORM.href, AssetORM.id).where(AssetORM.book_id == book_id)
        rows = (await self.session.execute(stmt)).all()
        return {href: aid for href, aid in rows}  # 字典推导式

    # ---------- 删除 ----------

    async def delete_book(self, book_id: str) -> bool:
        """删除书 + 级联清 chapters/assets + 文件。

        先删数据库（ORM cascade 自动删关联的章节和资源行），
        再删磁盘上的文件。
        """
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

        # 清理旧封面标记
        await self._clear_existing_cover(book_id)

        # 写新封面到磁盘
        asset_id = uuid.uuid4().hex  # 给新封面生成唯一 ID
        covers_dir = self.storage_dir / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)  # 确保目录存在
        (covers_dir / asset_id).write_bytes(image_bytes)

        # 创建 ORM 对象并写入数据库
        asset = AssetORM(
            id=asset_id,
            book_id=book_id,
            href=f"cover:{asset_id}",  # 用 "cover:" 前缀标记这是上传的封面（非 EPUB 自带）
            media_type=media_type,
            size=len(image_bytes),
            is_cover=1,  # 1 表示是封面
        )
        self.session.add(asset)
        await self.session.commit()
        await self.session.refresh(asset)  # 刷新获取数据库生成的值
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
            return False  # 没有封面，或封面不是上传的（是 EPUB 自带的）

        # 删除磁盘文件和数据库记录
        cover_path = self.storage_dir / "covers" / asset.id
        if cover_path.exists():
            cover_path.unlink()
        await self.session.delete(asset)
        await self.session.commit()
        return True

    # ---------- 编辑 ----------

    async def update_book(self, book_id: str, data: dict) -> BookORM | None:
        """部分更新书籍元数据。只修改 data 中传入的非 None 字段。

        data 是 BookUpdate.model_dump(exclude_none=True) 的结果，
        已经过滤掉 None 值，只包含用户真正想修改的字段。
        """
        book = await self.get_book(book_id)
        if book is None:
            return None

        # pub_date 需要特殊处理：字符串 → date 对象
        if "pub_date" in data and data["pub_date"] is not None:
            from datetime import date as date_type
            try:
                data["pub_date"] = date_type.fromisoformat(data["pub_date"])
            except ValueError:
                # 格式不对就跳过这个字段
                del data["pub_date"]

        for key, value in data.items():
            if hasattr(book, key):
                setattr(book, key, value)

        await self.session.commit()
        # 刷新关系（chapters / assets），确保返回的 ORM 对象包含完整数据
        await self.session.refresh(book, ["chapters", "assets"])
        return book

    async def update_chapter(
        self, book_id: str, chapter_id: str, data: dict
    ) -> ChapterORM | None:
        """更新章节标题和/或正文。

        如果 html 变了，自动重算 text（纯文本）和 word_count。
        data 是 ChapterUpdate.model_dump(exclude_none=True) 的结果。
        """
        chapter = await self.get_chapter(book_id, chapter_id)
        if chapter is None:
            return None

        if "title" in data and data["title"] is not None:
            chapter.title = data["title"]

        if "html" in data and data["html"] is not None:
            chapter.html = data["html"]
            # 从新 HTML 重算纯文本和字数
            from epub_backend.reader.chapter import parse_chapter
            plain_text, _, word_count, _ = parse_chapter(
                data["html"].encode("utf-8")
            )
            chapter.text = plain_text
            chapter.word_count = word_count

        await self.session.commit()
        return chapter

    async def reorder_chapters(self, book_id: str, chapter_ids: list[str]) -> bool:
        """按给定的 chapter id 列表重新排列章节顺序。

        chapter_ids 的索引就是新的 spine_order（index 0 = 第一章）。
        只更新属于这本书的章节，忽略无效 id。
        """
        # 批量查询这本书的所有章节
        stmt = select(ChapterORM).where(ChapterORM.book_id == book_id)
        chapters = (await self.session.execute(stmt)).scalars().all()
        chapter_map = {ch.id: ch for ch in chapters}

        # 按新顺序分配 spine_order
        for new_order, ch_id in enumerate(chapter_ids):
            ch = chapter_map.get(ch_id)
            if ch is not None:
                ch.spine_order = new_order

        # 不在 chapter_ids 中的章节放到末尾（保持原有相对顺序）
        remaining = [ch for ch in chapters if ch.id not in chapter_ids]
        remaining.sort(key=lambda c: c.spine_order)
        base = len(chapter_ids)
        for i, ch in enumerate(remaining):
            ch.spine_order = base + i

        await self.session.commit()
        return True

    async def _clear_existing_cover(self, book_id: str) -> None:
        """清除当前封面标记：上传封面连文件+行一起删，EPUB 封面只置 0。

        这是一个内部辅助方法，在设置新封前台调用，确保一本书只有一个封面。
        """
        stmt = select(AssetORM).where(
            AssetORM.book_id == book_id, AssetORM.is_cover == 1
        )
        asset = (await self.session.execute(stmt)).scalar_one_or_none()
        if asset is None:
            return
        if asset.href.startswith("cover:"):
            # 上传的封面：删除文件和数据库记录
            cover_path = self.storage_dir / "covers" / asset.id
            if cover_path.exists():
                cover_path.unlink()
            await self.session.delete(asset)
        else:
            # EPUB 自带的封面：只取消封面标记（不删除 ZIP 内的文件）
            asset.is_cover = 0
        await self.session.flush()  # flush：把修改发送到数据库，但不提交事务

    # ---------- 导出 ----------

    async def export_epub(self, book_id: str) -> tuple[BookORM, bytes] | None:
        """把书籍当前状态导出为标准 EPUB 3 字节。

        返回 (book_orm, epub_bytes)，书不存在返回 None。
        资源：上传封面读磁盘 covers/，其余读 .epb zip（一次打开）。
        """
        book = await self.get_book(book_id)
        if book is None:
            return None
        # refresh：加载关联的 chapters 和 assets（默认不自动加载 relationship）
        await self.session.refresh(book, ["chapters", "assets"])

        chapters = sorted(book.chapters, key=lambda c: c.spine_order)
        # sorted + lambda：按 spine_order 排序章节
        # lambda c: c.spine_order 是匿名函数，取每个章节的 spine_order 作为排序键
        assets = list(book.assets)

        # 批量读取资源字节
        import zipfile as zf_mod

        zip_path = self.storage_dir / Path(book.file_path).name
        zip_file = zf_mod.ZipFile(zip_path) if zip_path.exists() else None
        asset_bytes: dict[str, bytes] = {}  # {asset_id: 字节内容}
        try:
            for a in assets:
                if a.href.startswith("cover:"):
                    # 上传的封面：从磁盘读
                    p = self.storage_dir / "covers" / a.id
                    if p.exists():
                        asset_bytes[a.id] = p.read_bytes()
                elif zip_file is not None:
                    # EPUB 自带的资源：从 ZIP 内读
                    try:
                        asset_bytes[a.id] = zip_file.read(a.href)
                    except KeyError:
                        pass  # 资源缺失则跳过，不阻断导出
        finally:
            if zip_file is not None:
                zip_file.close()  # 确保 ZIP 文件关闭

        from epub_backend.services.epub_writer import build_epub_bytes

        epub_bytes = build_epub_bytes(book, chapters, assets, asset_bytes)
        return book, epub_bytes

    # ---------- 内部辅助 ----------

    async def _find_by_sha(self, sha256: str) -> BookORM | None:
        """按 SHA-256 哈希查找已有书籍（查重用）。"""
        stmt = select(BookORM).where(BookORM.file_sha256 == sha256)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def _stream_to_file(self, chunks: AsyncIterator[bytes], dest: Path) -> int:
        """流式写入：先写临时文件，完成后原子 rename 到目标路径。

        原子写入的好处：如果中途出错，目标文件不会被"半写"破坏。
        """
        import os
        import tempfile

        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_path: Path | None = None
        total = 0
        try:
            # NamedTemporaryFile：创建临时文件
            # dir=dest.parent：与目标同目录，确保 rename 是同文件系统（原子操作的前提）
            # delete=False：不自动删除（我们要手动 rename）
            with tempfile.NamedTemporaryFile(
                dir=dest.parent,
                prefix=".tmp_",
                suffix=".epb",
                delete=False,
            ) as tmp:
                tmp_path = Path(tmp.name)
                async for chunk in chunks:  # 异步迭代上传的数据块
                    if chunk:
                        tmp.write(chunk)
                        total += len(chunk)
                tmp.flush()
                os.fsync(tmp.fileno())  # fsync：强制把缓冲区数据写入磁盘，防止断电丢失
            import shutil

            shutil.move(str(tmp_path), str(dest))  # 原子 rename
            tmp_path = None  # 已移动，标记不需要清理
        finally:
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink()  # 出错时清理临时文件
        return total

    def _domain_to_orm(
        self,
        domain: BookDomain,
        book_id: str,
        sha256: str,
        file_size: int,
        filename: str,
    ) -> BookORM:
        """domain Book -> ORM Book（带 chapters + assets）。

        把 reader 解析出的领域模型（BookDomain）转换成 ORM 模型（BookORM），
        准备写入数据库。

        注意：必须用直接赋值而不是 .append()，避免 relationship 的 lazy load
        （新对象刚 add 还没在 DB，访问 chapters 会触发错误查询）。
        """
        # 列表推导式：把领域 Chapter 转成 ORM Chapter
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
            for ch in domain.chapters  # for ... in：遍历领域章节列表
        ]
        # 把领域 Asset 转成 ORM Asset
        assets = [
            AssetORM(
                id=a.id,
                href=a.href,
                media_type=a.media_type,
                size=a.size,
                is_cover=1 if a.is_cover else 0,  # Python 三元表达式：条件 ? 真值 : 假值
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
            file_path=f"{book_id}.epb",  # 文件名用 book_id + .epb 后缀
            file_size=file_size,
            file_sha256=sha256,
            created_at=datetime.now(),    # 当前时间作为入库时间
            chapters=chapters,            # 直接赋值（不用 .append()，见上面说明）
            assets=assets,
        )
        return book


async def stream_upload_chunks(upload_file) -> AsyncIterator[bytes]:
    """把 starlette UploadFile 转成异步分块迭代器。

    FastAPI 的 UploadFile 是异步读，service 层接受 async iterator。
    这个函数是"异步生成器"：每次 yield 一块数据，调用方用 async for 消费。
    """
    while True:
        chunk = await upload_file.read(1024 * 1024)  # 每次读 1 MB
        if not chunk:
            break  # 读完则退出循环
        yield chunk  # yield：把数据"交出去"给调用方，函数暂停在此处等待下次调用
