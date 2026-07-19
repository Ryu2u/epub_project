"""构造测试用的 EPUB fixture。

只构造最小可被我们 reader 解析的 EPUB（不含图片/字体，避免外链资源依赖）。
所有 fixture 由 tests/conftest.py 调用以保证 build 顺序。
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterable
from pathlib import Path


def _write_epub(path: Path, members: Iterable[tuple[str, bytes | str]]) -> None:
    """写一个 EPUB。第一个 entry 必须是 mimetype（未压缩）。"""
    members_list = list(members)
    # EPUB 规范：mimetype 必须是第一个 entry，且用 STORED（不压缩）
    mimetype_idx = next(i for i, (n, _) in enumerate(members_list) if n == "mimetype")
    if mimetype_idx != 0:
        raise ValueError("mimetype 必须是第一个 entry")

    with zipfile.ZipFile(path, "w") as zf:
        # mimetype 必须未压缩
        zf.write(
            path,
            arcname="_tmp",  # 占位，下面直接 writestr
        )
    path.unlink()  # 清掉刚才的占位
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in members_list:
            if name == "mimetype":
                zf.writestr(name, data, compress_type=zipfile.ZIP_STORED)
            else:
                if isinstance(data, str):
                    data = data.encode("utf-8")
                zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)


MIMETYPE = "application/epub+zip"

CONTAINER_XML = """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

# 最小合规的 OPF：1 个章节、1 张封面图片（用 jpeg 字节序列的假二进制）
OPF_VALID = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:00000000-0000-0000-0000-000000000001</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test Author</dc:creator>
    <dc:publisher>Test Publisher</dc:publisher>
    <dc:description>A test book for reader validation.</dc:description>
    <dc:date>2024-01-15</dc:date>
    <meta property="dcterms:modified">2024-01-15T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

# 缺 dc:title 的 OPF（仍能触发 IncompleteMetadataError，因为 title 没 fallback）
OPF_MISSING_IDENTIFIER = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title></dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test</dc:creator>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>
"""

# 仅缺 dc:identifier（应被 parse_opf 的 fallback 接住，正常解析）
OPF_MISSING_IDENTIFIER_ONLY = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Has All Except Identifier</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test</dc:creator>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>
"""

NAV_VALID = """<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="ch1.xhtml">第一章 开始</a></li>
      <li><a href="ch2.xhtml">第二章 继续</a></li>
    </ol>
  </nav>
</body>
</html>
"""

CH1 = """<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>第一章 开始</h1>
  <p>这是第一段，包含一些文字。This is some English text.</p>
  <p>第二段用于测试多段落切分。</p>
</body>
</html>
"""

CH2 = """<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h1>第二章 继续</h1>
  <p>Hello world.</p>
</body>
</html>
"""

# 极小的 JPEG 字节（实际是合法 JPEG 头，但解析器只读长度，不会真去解析图像）
COVER_JPG = bytes.fromhex(
    "ffd8ffe000104a46494600010101006000600000"
    "ffdb004300080606070605080707070909080a0c"
    "140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c"
    "20242e2720222c231c1c2837292c30313434341f"
    "27393d38323c2e333432ffdb0043010909090c"
    "0b0c180d0d1832211c21323232323232323232"
    "32323232323232323232323232323232323232"
    "32323232323232323232323232323232323232"
    "323232323232ffc00011080001000103012200"
    "021101031101ffc4001f000001050101010101"
    "0100000000000000000102030405060708090a"
    "0bffc400b51000020103030204030505040400"
    "0000017d010203000411051221314106135161"
    "07227114328191a1082342b1c11552d1f02433"
    "62728282030f0a0b0c0d0e0f10111213141516"
    "1718191a1b1c1d1e1f20212223242526272829"
    "2a2b2c2d2e2f303132333435363738393a4344"
    "45464748494a535455565758595a6364656667"
    "68696a737475767778797a838485868788898a"
    "92939495969798999aa2a3a4a5a6a7a8a9aab2"
    "b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3"
    "d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2"
    "f3f4f5f6f7f8f9faffc4001f01000301010101"
    "01010101010100000000000001020304050607"
    "08090a0bffc400b51100020102040403040705"
    "04040001010277000102031104052131061241"
    "51076171130822328108144291a1b1c10923335"
    "2f0156272d10a162434e125f11718191a262728"
    "292a35363738393a434445464748494a535455"
    "565758595a636465666768696a737475767778"
    "797a82838485868788898a9293949596979899"
    "9aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9ba"
    "c2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2"
    "e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda"
    "000c03010002110311003f00fbfaffd9"
)

# EPUB 2 toc.ncx（用于测试 NCX 作为标题兜底）
NCX = """<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:00000000-0000-0000-0000-000000000001"/></head>
  <docTitle><text>Test</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>NCX 第一章</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>NCX 第二章</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
"""

# 纯 EPUB 2 OPF：无 nav，目录在 toc.ncx（spine toc 指向 ncx）
OPF_NCX = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:00000000-0000-0000-0000-000000000001</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

# DRM 标记（reader 应拒收）
ENCRYPTION_XML = """<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"/>
</encryption>
"""


# 纯 EPUB 2，章节用 text/x-oebps-document MIME（Calibre/Sigil 旧版/某些工具的输出）
OPF_NCX_LEGACY_MIME = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:00000000-0000-0000-0000-000000000002</dc:identifier>
    <dc:title>Legacy EPUB 2</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="text/x-oebps-document"/>
    <item id="ch2" href="ch2.xhtml" media-type="text/x-oebps-1"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""


def build_valid_epub(path: Path) -> None:
    """合规 EPUB 3：1 nav + 2 章节 + 1 封面。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_VALID),
            ("OEBPS/nav.xhtml", NAV_VALID),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
            ("OEBPS/cover.jpg", COVER_JPG),
        ],
    )


def build_missing_identifier_epub(path: Path) -> None:
    """OPF 缺 dc:title（fixture 现在用空 title 触发，保留原"缺必填字段"语义）。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_MISSING_IDENTIFIER),
            ("OEBPS/ch1.xhtml", CH1),
        ],
    )


def build_only_missing_identifier_epub(path: Path) -> None:
    """只缺 dc:identifier，期望 parse_opf 自动 fallback 派生，正常导入。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_MISSING_IDENTIFIER_ONLY),
            ("OEBPS/ch1.xhtml", CH1),
        ],
    )


def build_corrupt_epub(path: Path) -> None:
    """写一个非 ZIP 的字节流，期望 CorruptEpubError。"""
    path.write_bytes(b"this is not a zip file at all")


def build_with_ncx_epub(path: Path) -> None:
    """纯 EPUB 2（无 nav.xhtml，目录在 toc.ncx），验证 NCX 作为标题兜底。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_NCX),
            ("OEBPS/toc.ncx", NCX),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
        ],
    )


def build_epub2_legacy_mime_epub(path: Path) -> None:
    """纯 EPUB 2，章节用 text/x-oebps-document / text/x-oebps-1 MIME。

    验证 _build_chapters() 的 MIME 白名单包含 EPUB 2 OPS 文档类型。
    """
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_NCX_LEGACY_MIME),
            ("OEBPS/toc.ncx", NCX),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/ch2.xhtml", CH2),
        ],
    )


def build_with_drm_epub(path: Path) -> None:
    """含 META-INF/encryption.xml，期望 DRMError。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("META-INF/encryption.xml", ENCRYPTION_XML),
            ("OEBPS/content.opf", OPF_VALID),
            ("OEBPS/nav.xhtml", NAV_VALID),
            ("OEBPS/ch1.xhtml", CH1),
        ],
    )


# calibre / EPUB 2 风格用 <meta name="cover" content="cover-img"/>
OPF_COVER_META = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bid">urn:uuid:00000000-0000-0000-0000-000000000010</dc:identifier>
    <dc:title>Calibre Style</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Tester</dc:creator>
    <meta name="cover" content="my-cover"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="my-cover" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>
"""


def build_cover_meta_epub(path: Path) -> None:
    """含 <meta name="cover"> 标记的 EPUB，期望被识别为封面。"""
    _write_epub(
        path,
        [
            ("mimetype", MIMETYPE),
            ("META-INF/container.xml", CONTAINER_XML),
            ("OEBPS/content.opf", OPF_COVER_META),
            ("OEBPS/nav.xhtml", NAV_VALID),
            ("OEBPS/ch1.xhtml", CH1),
            ("OEBPS/cover.jpg", COVER_JPG),
        ],
    )


ALL_BUILDERS = {
    "valid.epub": build_valid_epub,
    "missing_identifier.epub": build_missing_identifier_epub,
    "missing_identifier_only.epub": build_only_missing_identifier_epub,
    "corrupt.epub": build_corrupt_epub,
    "with_ncx.epub": build_with_ncx_epub,
    "with_drm.epub": build_with_drm_epub,
    "cover_meta.epub": build_cover_meta_epub,
    "epub2_legacy_mime.epub": build_epub2_legacy_mime_epub,
}


def build_all(out_dir: Path) -> None:
    """构造所有 fixture 到 out_dir。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, builder in ALL_BUILDERS.items():
        builder(out_dir / name)
