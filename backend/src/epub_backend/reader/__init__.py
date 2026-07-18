"""Reader 子包：EPUB 3 自实现解析。

这个包负责将 .epub 文件解析成结构化的 Python 对象。
EPUB 本质上是一个 ZIP 压缩包，里面包含：
- mimetype 文件（标识这是 EPUB）
- META-INF/container.xml（指向 OPF 包描述文件）
- OPF 文件（描述书籍元数据、章节清单、阅读顺序）
- XHTML 章节文件、图片、CSS 样式等资源
"""
