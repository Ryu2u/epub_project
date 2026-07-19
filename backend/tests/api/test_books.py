"""API 路由测试：httpx AsyncClient 跑 7 个端点 + 错误码。"""

import io
from pathlib import Path


def _upload(name: str, data: bytes):
    return {"file": (name, io.BytesIO(data), "application/octet-stream")}


async def test_health(client) -> None:
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_list_empty(client) -> None:
    r = await client.get("/api/books")
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert body["total"] == 0


async def test_upload_and_list_and_detail(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()

    # 上传
    r = await client.post("/api/books", files=_upload("test.epub", data))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "book" in body
    assert "warnings" in body
    book_id = body["book"]["id"]
    assert body["book"]["title"] == "Test Book"
    assert len(body["book"]["chapters"]) == 2
    assert len(body["book"]["assets"]) == 1

    # 列表
    r = await client.get("/api/books")
    assert r.status_code == 200
    listing = r.json()
    assert listing["total"] == 1
    assert listing["items"][0]["title"] == "Test Book"
    assert listing["items"][0]["chapter_count"] == 2
    assert listing["items"][0]["has_cover"] is True

    # 详情
    r = await client.get(f"/api/books/{book_id}")
    assert r.status_code == 200
    detail = r.json()
    assert detail["id"] == book_id
    assert detail["identifier"].startswith("urn:uuid:")


async def test_upload_unsupported_extension(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("test.txt", data))
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "UNSUPPORTED_MEDIA"


async def test_upload_corrupt_returns_422(client, corrupt_epub: Path) -> None:
    data = corrupt_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("bad.epub", data))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "CORRUPT_EPUB"


async def test_upload_drm_returns_422(client, with_drm_epub: Path) -> None:
    data = with_drm_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("drm.epub", data))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "DRM_DETECTED"


async def test_upload_incomplete_metadata_returns_422(
    client, missing_identifier_epub: Path
) -> None:
    data = missing_identifier_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("x.epub", data))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "INCOMPLETE_METADATA"


async def test_upload_duplicate_returns_409(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r1 = await client.post("/api/books", files=_upload("a.epub", data))
    assert r1.status_code == 200
    r2 = await client.post("/api/books", files=_upload("b.epub", data))
    assert r2.status_code == 409
    err = r2.json()["error"]
    assert err["code"] == "DUPLICATE_FILE"
    assert err.get("existing_book_id")


async def test_get_chapter_text(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]
    r = await client.get(f"/api/books/{book_id}/chapters/ch1")
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "text"
    assert "第一段" in body["content"]


async def test_get_chapter_html(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]
    r = await client.get(f"/api/books/{book_id}/chapters/ch1?format=html")
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "html"
    assert "<p>" in body["content"]


async def test_get_chapter_unknown_returns_404(client) -> None:
    r = await client.get("/api/books/nonexistent/chapters/nope")
    assert r.status_code == 404


async def test_get_asset_returns_jpeg(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]
    r = await client.get(f"/api/books/{book_id}/assets/cover-img")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/jpeg")
    assert r.content[:3] == b"\xff\xd8\xff"


async def test_delete_book(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.delete(f"/api/books/{book_id}")
    assert r.status_code == 204

    # 二次删 → 404
    r = await client.delete(f"/api/books/{book_id}")
    assert r.status_code == 404

    # 列表应该是空的
    r = await client.get("/api/books")
    assert r.json()["total"] == 0


async def test_list_includes_cover_id(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    assert r.status_code == 200

    r = await client.get("/api/books")
    items = r.json()["items"]
    assert items[0]["has_cover"] is True
    assert items[0]["cover_id"] == "cover-img"


async def test_get_chapter_html_rewrites_img_src(client, valid_epub: Path) -> None:
    """章节 HTML 中的 <img src="..."> 应被重写为 /api/books/{id}/assets/{asset_id} URL。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    # valid.epub 的 ch1.xhtml 不含图片，但 html 里有 <img> 解析流程要鲁棒（不应崩）
    r = await client.get(f"/api/books/{book_id}/chapters/ch1?format=html")
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "html"
    # 我们的 valid EPUB 没有内嵌图片；断言不含未替换的占位 src
    assert "/api/books/" in body["content"] or "<img" not in body["content"]


async def test_get_chapter_html_rewrites_real_images(client) -> None:
    """用一个含内嵌 <img> 的章节验证 src 重写。"""
    import zipfile

    from tests.fixtures.build_fixtures import (
        CH1 as BASE_CH1,
    )
    from tests.fixtures.build_fixtures import (
        CONTAINER_XML,
        MIMETYPE,
        NAV_VALID,
        OPF_VALID,
    )

    # 构造一个含 <img src="image.jpg"> 的章节
    ch_with_img = """<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Img</title></head>
<body>
  <h1>含图章节</h1>
  <p>看下面这张图：</p>
  <img src="../images/cover.jpg" alt="cover"/>
  <p>结束。</p>
</body>
</html>
"""
    # 一个极小的 JPEG 字节（足够识别为 JPEG）
    tiny_jpg = b"\xff\xd8\xff\xe0" + b"\x00" * 100 + b"\xff\xd9"

    opf_with_img = OPF_VALID.replace(
        '"OEBPS/ch1.xhtml"',
        '"ch1.xhtml"',
    ).replace(
        '"OEBPS/ch2.xhtml"',
        '"ch2.xhtml"',
    ).replace(
        '"OEBPS/cover.jpg"',
        '"images/cover.jpg"',
    )
    # 简化：直接构造简单 OPF
    opf_simple = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:test-img-book</dc:identifier>
    <dc:title>Img Book</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>
"""

    import tempfile
    from pathlib import Path

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        path = Path(tmp.name)
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
            zf.writestr("META-INF/container.xml", CONTAINER_XML)
            zf.writestr("OEBPS/content.opf", opf_simple)
            zf.writestr("OEBPS/nav.xhtml", NAV_VALID)
            zf.writestr("OEBPS/ch1.xhtml", ch_with_img)
            zf.writestr("OEBPS/images/cover.jpg", tiny_jpg)

    try:
        data = path.read_bytes()
        r = await client.post("/api/books", files=_upload("img.epub", data))
        assert r.status_code == 200, r.text
        book_id = r.json()["book"]["id"]

        r = await client.get(f"/api/books/{book_id}/chapters/ch1?format=html")
        assert r.status_code == 200
        body = r.json()
        # 重写后 src 应包含 /api/books/{book_id}/assets/
        assert "/api/books/" in body["content"]
        assert "cover-img" in body["content"]
        # 不应再含 ../images/cover.jpg 这种相对路径
        assert "../images/cover.jpg" not in body["content"]
    finally:
        path.unlink()


async def test_get_chapter_html_rewrites_svg_image(client) -> None:
    """calibre 用 <svg><image xlink:href="..."/> 嵌图，应被识别并重写为 assets URL。"""
    import zipfile
    import tempfile

    from tests.fixtures.build_fixtures import (
        CONTAINER_XML,
        MIMETYPE,
        NAV_VALID,
    )

    ch_with_svg_image = """<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>SVG Cover</title></head>
<body>
  <figure>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
         width="400" height="600" viewBox="0 0 400 600">
      <image width="400" height="600" xlink:href="../images/pic.jpg"></image>
    </svg>
  </figure>
</body>
</html>
"""
    opf = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:test-svg-image</dc:identifier>
    <dc:title>SVG Img</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Tester</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/pic.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>
"""
    tiny_jpg = b"\xff\xd8\xff\xe0" + b"\x00" * 100 + b"\xff\xd9"
    from pathlib import Path

    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        path = Path(tmp.name)
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
            zf.writestr("META-INF/container.xml", CONTAINER_XML)
            zf.writestr("OEBPS/content.opf", opf)
            zf.writestr("OEBPS/nav.xhtml", NAV_VALID)
            zf.writestr("OEBPS/ch1.xhtml", ch_with_svg_image)
            zf.writestr("OEBPS/images/pic.jpg", tiny_jpg)

    try:
        data = path.read_bytes()
        r = await client.post("/api/books", files=_upload("svg.epub", data))
        assert r.status_code == 200, r.text
        book_id = r.json()["book"]["id"]

        r = await client.get(f"/api/books/{book_id}/chapters/ch1?format=html")
        assert r.status_code == 200
        content = r.json()["content"]
        # SVG <image> 的 xlink:href 应被重写为 /api/books/{id}/assets/cover-img
        assert "/api/books/" in content
        assert "cover-img" in content
        # 原始相对路径不应再出现
        assert "../images/pic.jpg" not in content
    finally:
        path.unlink()


async def test_search(client, valid_epub: Path) -> None:
    data = valid_epub.read_bytes()
    await client.post("/api/books", files=_upload("a.epub", data))

    r = await client.get("/api/books?q=Test")
    assert r.json()["total"] == 1

    r = await client.get("/api/books?q=NonExist")
    assert r.json()["total"] == 0


# ---------- 编辑端点测试 ----------


async def test_update_book_title(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id} 修改标题。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.patch(
        f"/api/books/{book_id}",
        json={"title": "新标题"},
    )
    assert r.status_code == 200
    assert r.json()["title"] == "新标题"
    # 其他字段不变
    assert r.json()["language"] == "en"


async def test_update_book_multiple_fields(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id} 同时修改多个字段。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.patch(
        f"/api/books/{book_id}",
        json={"title": "多字段测试", "authors": ["新作者"], "publisher": "新出版社"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "多字段测试"
    assert body["authors"] == ["新作者"]
    assert body["publisher"] == "新出版社"


async def test_update_book_empty_body_returns_400(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id} 空请求体返回 400。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.patch(f"/api/books/{book_id}", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "EMPTY_UPDATE"


async def test_update_book_not_found(client) -> None:
    """PATCH /api/books/{id} 不存在的书返回 404。"""
    r = await client.patch("/api/books/nonexistent", json={"title": "x"})
    assert r.status_code == 404


async def test_update_chapter_title(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id}/chapters/{cid} 修改章节标题。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.patch(
        f"/api/books/{book_id}/chapters/ch1",
        json={"title": "新章节标题"},
    )
    assert r.status_code == 200
    assert r.json()["title"] == "新章节标题"


async def test_update_chapter_html(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id}/chapters/{cid} 修改正文 HTML。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    new_html = "<html><body><p>修改后的内容</p></body></html>"
    r = await client.patch(
        f"/api/books/{book_id}/chapters/ch1",
        json={"html": new_html},
    )
    assert r.status_code == 200
    body = r.json()
    assert "修改后的内容" in body["content"]
    assert body["format"] == "html"

    # 验证字数也更新了
    r2 = await client.get(f"/api/books/{book_id}")
    ch1 = next(c for c in r2.json()["chapters"] if c["id"] == "ch1")
    assert ch1["word_count"] > 0


async def test_update_chapter_not_found(client, valid_epub: Path) -> None:
    """PATCH 章节不存在返回 404。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.patch(
        f"/api/books/{book_id}/chapters/nonexist",
        json={"title": "x"},
    )
    assert r.status_code == 404


async def test_reorder_chapters(client, valid_epub: Path) -> None:
    """PATCH /api/books/{id}/chapters/reorder 重排章节顺序。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    # 原始顺序: ch1(spine_order=0), ch2(spine_order=1)
    # 翻转: ch2 先, ch1 后
    r = await client.patch(
        f"/api/books/{book_id}/chapters/reorder",
        json={"chapter_ids": ["ch2", "ch1"]},
    )
    assert r.status_code == 204

    # 验证新顺序
    r = await client.get(f"/api/books/{book_id}")
    chapters = r.json()["chapters"]
    assert chapters[0]["id"] == "ch2"
    assert chapters[1]["id"] == "ch1"


async def test_update_book_reflected_in_export(client, valid_epub: Path) -> None:
    """编辑后导出的 EPUB 应反映新标题。"""
    import zipfile

    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    # 修改标题
    await client.patch(f"/api/books/{book_id}", json={"title": "导出测试标题"})

    # 导出
    r = await client.get(f"/api/books/{book_id}/export")
    assert r.status_code == 200
    assert len(r.content) > 0

    # EPUB 是 ZIP 格式，需要解压 content.opf 才能检查标题
    import io

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        opf = zf.read("OEBPS/content.opf").decode("utf-8")
        assert "导出测试标题" in opf


# ---------- 内容搜索测试 ----------


async def test_search_in_book(client, valid_epub: Path) -> None:
    """搜索书籍正文内容。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    # valid.epub 的 ch1 包含 "第一段"
    r = await client.get(f"/api/books/{book_id}/search?q=第一段")
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "第一段"
    assert body["total"] >= 1
    assert len(body["items"]) >= 1
    # 第一条结果应包含高亮标记
    assert "<mark>" in body["items"][0]["snippet"]
    assert body["items"][0]["chapter_id"]


async def test_search_in_book_no_match(client, valid_epub: Path) -> None:
    """搜索不存在的关键词返回空结果。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.get(f"/api/books/{book_id}/search?q=不存在的关键词xyz")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 0
    assert body["items"] == []


async def test_search_in_book_too_short(client, valid_epub: Path) -> None:
    """搜索词太短（<2字）返回空。"""
    data = valid_epub.read_bytes()
    r = await client.post("/api/books", files=_upload("a.epub", data))
    book_id = r.json()["book"]["id"]

    r = await client.get(f"/api/books/{book_id}/search?q=a")
    assert r.status_code == 200
    assert r.json()["total"] == 0


async def test_search_in_book_not_found(client) -> None:
    """搜索不存在的书返回 404。"""
    r = await client.get("/api/books/nonexistent/search?q=test")
    assert r.status_code == 404


# ---------- 批量上传测试 ----------


async def test_batch_upload_all_success(client, valid_epub: Path) -> None:
    """批量上传：全部成功。"""
    data1 = valid_epub.read_bytes()
    # 第二个字节流相同，会触发去重 → 故此处只造一本有效的查成功路径
    r = await client.post(
        "/api/books/batch",
        files=[
            ("files", ("a.epub", io.BytesIO(data1), "application/octet-stream")),
        ],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["succeeded"] == 1
    assert body["skipped"] == 0
    assert body["failed"] == 0
    assert body["items"][0]["status"] == "success"
    assert body["items"][0]["book_id"]


async def test_batch_upload_mixed_results(
    client, valid_epub: Path, corrupt_epub: Path
) -> None:
    """批量上传：成功 + 损坏 + 重复 三种结果混合。

    用一个先构建好的临时小文件当作「新增」项，避开与 valid 文件的 sha256 重复，
    让三种状态各出现一次。
    """
    import zipfile
    import tempfile

    from tests.fixtures.build_fixtures import (
        CONTAINER_XML,
        MIMETYPE,
        NAV_VALID,
        OPF_VALID,
        CH1,
    )

    # 构造第二个独一无二的合法 EPUB（内容与 valid 完全不同）
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as f:
        path = Path(f.name)
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
            zf.writestr("META-INF/container.xml", CONTAINER_XML)
            zf.writestr("OEBPS/content.opf", OPF_VALID.replace("00000001", "DEADBEEF"))
            zf.writestr("OEBPS/nav.xhtml", NAV_VALID)
            # 内容跟 valid.epub 完全不同（CH2 vs CH1）
            from tests.fixtures.build_fixtures import CH2
            zf.writestr("OEBPS/ch1.xhtml", CH2)
    second_data = path.read_bytes()
    valid_data = valid_epub.read_bytes()
    corrupt_data = corrupt_epub.read_bytes()
    try:
        r = await client.post(
            "/api/books/batch",
            files=[
                ("files", ("new1.epub", io.BytesIO(valid_data), "application/octet-stream")),
                ("files", ("new2.epub", io.BytesIO(second_data), "application/octet-stream")),
                ("files", ("first.epub", io.BytesIO(valid_data), "application/octet-stream")),  # 与第一个同名重复
                ("files", ("bad.epub", io.BytesIO(corrupt_data), "application/octet-stream")),
            ],
        )
        assert r.status_code == 200
        body = r.json()
        # 第一个 new1 成功，第二个 new2 成功，第三个与 first 同 sha=duplicate，最后损坏
        assert body["total"] == 4
        assert body["succeeded"] == 2
        assert body["skipped"] == 1
        assert body["failed"] == 1
        statuses = [i["status"] for i in body["items"]]
        assert statuses.count("success") == 2
        assert statuses.count("duplicate") == 1
        assert statuses.count("error") == 1

        duplicate = next(i for i in body["items"] if i["status"] == "duplicate")
        assert duplicate["book_id"]
        duplicate_first = next(i for i in body["items"] if i["status"] == "duplicate")
        assert duplicate_first["filename"] == "first.epub"
        failed = next(i for i in body["items"] if i["status"] == "error")
        assert failed["error_code"] == "CORRUPT_EPUB"
    finally:
        path.unlink()


async def test_batch_upload_unsupported_extension(client) -> None:
    """批量上传中包含非 .epub/.epb 后缀 → 该项标记为 UNSUPPORTED_MEDIA。"""
    r = await client.post(
        "/api/books/batch",
        files=[
            ("files", ("a.txt", io.BytesIO(b"not an epub"), "application/octet-stream")),
        ],
    )
    assert r.status_code == 200
    body = r.json()
    assert body["failed"] == 1
    assert body["items"][0]["error_code"] == "UNSUPPORTED_MEDIA"


async def test_batch_upload_empty_list(client) -> None:
    """批量上传空列表 → 200 + 全部 0。"""
    r = await client.post("/api/books/batch", files=[])
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 0
    assert body["succeeded"] == 0
