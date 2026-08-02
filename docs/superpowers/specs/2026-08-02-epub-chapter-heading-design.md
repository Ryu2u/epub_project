# 导出 EPUB 章节正文插入标题 设计

日期:2026-08-02
状态:已确认

## 背景

导出的 EPUB 每个章节 XHTML 存在两个问题:
1. **`<head><title>` 为空**:章节源 HTML 里是 `<head><title></title></head>`(源 EPUB 没写)。
   `inject_title_into_xhtml`(epub_writer.rs:200-203)只检查"有没有 `<title>` 标签"就返回,
   不注入 `ch.title`,导致空 title 保留。
2. **正文没有任何标题元素**:正文直接从 `<p>` 段落开始,阅读器正文看不到章节标题。

用户期望:**正文开头显示章节标题**,用 `<h3>` 而非 `<h1>`。

## 方案

只改 `backend-rs/src/epub_writer.rs`。

### 1. 增强 `inject_title_into_xhtml`:空 title 覆盖为章节标题

现有逻辑(epub_writer.rs:200-203)只要发现 `<title>` 就原样返回,空 title 不修。
改为:发现 `<title>` 后,**读取其内容;若为空则替换为 `ch.title`,非空则保留**。

### 2. 新增 `inject_chapter_heading(doc, title)`:正文插入 `<h3>`

对完整 XHTML 文档操作:定位 `<body>` 起始标签结束的 `>`,在其后检查正文前是否有 `h1-h6`;
无则插入 `<h3>{title}</h3>`,有则不动。用 `escape_xml(title)` 转义。

### 3. `normalize_xhtml` 各分支统一应用两步

三个分支的返回前都做「补 title + 插 h3」:

- **分支 1(已有 DOCTYPE)**:`ensure_xml_decl` 后,`inject_title_into_xhtml` + `inject_chapter_heading`
- **分支 2(`<?xml` 无 DOCTYPE)**:(实际源文件路径)inject_title 后追加 `inject_chapter_heading`
- **分支 3(有 `<html>` 根无 DOCTYPE)**:同上
- **分支 4(纯 body 片段,TXT)**:包壳时 `<head><title>{title}</title></head>` 已含标题,body 内插 `<h3>`

关键:`inject_chapter_heading` 处理的是**完整文档字符串**(含 `<body ...>`),自身定位 body 标签,
因此 normalize 各分支只需在返回前调用一次。

## 实际数据流(以「凌晨三点」为例)

源章节文件:以 `<?xml` 开头,**无 DOCTYPE** → 走分支 2:
`normalize_xhtml` 现先 `inject_title_into_xhtml`(增强版:空 title → 覆盖「第1章 失能症候群」),
再 `inject_chapter_heading`(body 开头插 `<h3>第1章 失能症候群</h3>`)。
最终章节 XHTML:`<head><title>第1章 失能症候群</title></head> <body><h3>第1章 失能症候群</h3><p>...</p>`
