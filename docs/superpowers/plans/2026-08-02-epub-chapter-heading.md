# 导出 EPUB 章节正文插入标题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出 EPUB 时每章正文开头插入 `<h3>章节标题</h3>`,并修复空 `<title>` 被保留的问题。

**Architecture:** 只改 `backend-rs/src/epub_writer.rs`。增强 `inject_title_into_xhtml`(空 title 覆盖为章节标题),新增 `inject_chapter_heading`(正文插 `<h3>`),`normalize_xhtml` 各分支返回前统一调用两者。

**Tech Stack:** Rust,axum 后端,epub_writer.rs 已有 `#[cfg(test)]` 测试模块(纯字符串处理,无需 DB)。

## Global Constraints

- 只改 `backend-rs/src/epub_writer.rs`,后端其他文件、前端一律不碰
- 标题用 `<h3>`(用户指定),不用 `<h1>`
- 正文已有 h1-h6 标题元素时**跳过插入**,避免重复
- `<title>` 非空则保留原文,只有空 title 才覆盖
- 所有插入的标题内容经 `escape_xml` 转义
- 需重新导出那本「凌晨三点,车站前的地雷系」验证

---

### Task 1: 增强 inject_title_into_xhtml 空 title 覆盖

**Files:**
- Modify: `backend-rs/src/epub_writer.rs:196-228`(`inject_title_into_xhtml` 函数)
- Test: 同文件 `mod tests`(epub_writer.rs:443 附近)

**Interfaces:**
- Consumes: `escape_xml(title: &str) -> String`(已存在,epub_writer.rs 上方)
- Produces: 修改后的 `inject_title_into_xhtml(doc: &str, title: &str) -> String`:
  - 已有非空 `<title>内容</title>` → 原样返回
  - 已有空 `<title></title>` → 覆盖为 `<title>{title}</title>`
  - 无 `<title>` → 现有逻辑(在 head 后插入,或 head 缺失时插入新 head)

- [ ] **Step 1: 写失败测试**

在 epub_writer.rs `mod tests` 末尾(现有测试之后)加:

```rust
    #[test]
    fn inject_title_overwrites_empty_title() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head><title></title></head>
<body><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第1章 失能症候群");
        assert!(
            out.contains("<title>第1章 失能症候群</title>"),
            "空 title 应被覆盖: {out}"
        );
        assert!(!out.contains("<title></title>"), "不应保留空 title: {out}");
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd backend-rs && cargo test inject_title_overwrites_empty_title
```
Expected: FAIL —— 当前 `inject_title_into_xhtml` 检测到 `<title>` 就原样返回,空 title 未覆盖。

- [ ] **Step 3: 实现空 title 覆盖**

将 epub_writer.rs:200-203 的现有逻辑:

```rust
    // 已有 <title> → 不动
    if lower.contains("<title>") {
        return doc.to_string();
    }
```

替换为:

```rust
    // 已有 <title> → 非空保留,空则覆盖为章节标题
    if let Some(title_tag_start) = lower.find("<title") {
        // 开标签结束 > 位置
        let tag_end = title_tag_start + doc[title_tag_start..].find('>').unwrap_or(7) + 1;
        // 找 </title> 闭标签
        if let Some(close) = doc[tag_end..].find("</title>") {
            let content_end = tag_end + close;
            let original = &doc[tag_end..content_end];
            if original.trim().is_empty() {
                // 空 title → 替换内容
                let escaped = escape_xml(title);
                return format!(
                    "{}{}{}{}",
                    &doc[..tag_end],
                    escaped,
                    &doc[content_end..]
                );
            }
        }
        // 非空 title → 保留
        return doc.to_string();
    }
```

注:`lower` 与 `doc` 在 ASCII 区间长度相同,`find("<title")` 的索引可安全用于 `doc`。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
cd backend-rs && cargo test inject_title_overwrites_empty_title
```
Expected: PASS。

同时跑全量 epub_writer 测试确认没破坏现有行为:
```bash
cd backend-rs && cargo test epub_writer
```
Expected: 全部 PASS(含 `normalize_already_valid_xhtml` 等既有用例)。

- [ ] **Step 5: Commit**

```bash
git add backend-rs/src/epub_writer.rs
git commit -m "fix(export): 空 <title> 覆盖为章节标题"
```

---

### Task 2: 新增 inject_chapter_heading + normalize 集成

**Files:**
- Modify: `backend-rs/src/epub_writer.rs`(新增 `inject_chapter_heading` 函数 + 改 `normalize_xhtml` 三处调用点)
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: `inject_title_into_xhtml`(Task 1 修改版),`escape_xml`
- Produces:
  - `fn inject_chapter_heading(doc: &str, title: &str) -> String`
  - `normalize_xhtml` 现在:除原有逻辑外,返回前对三个分支结果调用 `inject_chapter_heading`

- [ ] **Step 1: 写失败测试**

加:

```rust
    #[test]
    fn inject_h3_heading_into_body() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>已有</title></head>
<body><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第一章");
        assert!(
            out.contains("<body><h3>第一章</h3>"),
            "body 开头应有 <h3> 标题: {out}"
        );
    }

    #[test]
    fn skip_h3_when_body_has_existing_heading() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head></head>
<body><h1>已有大标题</h1><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第一章");
        assert!(!out.contains("<h3>第一章</h3>"), "正文已有标题不应重复插入: {out}");
        assert!(out.contains("<h1>已有大标题</h1>"), "应保留已有标题: {out}");
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd backend-rs && cargo test inject_h3_heading_into_body
cd backend-rs && cargo test skip_h3_when_body_has_existing_heading
```
Expected: 两个都 FAIL —— `inject_chapter_heading` 不存在,正文无 `<h3>`。

- [ ] **Step 3: 实现 inject_chapter_heading**

在 `inject_title_into_xhtml` 函数之后新增:

```rust
/// 在 <body> 起始标签后插入 <h3>章节标题</h3>。
/// 正文已有 h1-h6 标题则跳过(避免重复)。无 <body> 时原样返回。
fn inject_chapter_heading(doc: &str, title: &str) -> String {
    let lower = doc.to_lowercase();
    // 已有任何标题元素 → 不动
    if ["<h1", "<h2", "<h3", "<h4", "<h5", "<h6"]
        .iter()
        .any(|tag| lower.contains(tag))
    {
        return doc.to_string();
    }
    // 定位 <body ...> 的结束 >
    if let Some(body_start) = lower.find("<body") {
        if let Some(tag_end) = doc[body_start..].find('>') {
            let insert_at = body_start + tag_end + 1;
            let (before, after) = doc.split_at(insert_at);
            return format!("{before}<h3>{}</h3>\n{}", escape_xml(title), after);
        }
    }
    doc.to_string()
}
```

- [ ] **Step 4: normalize_xhtml 三处返回前调用**

`normalize_xhtml`(epub_writer.rs:157-191)修改三处返回:

**分支 1**(epub_writer.rs:161-163,已有 DOCTYPE 直接返回):
```rust
    if trimmed.contains("<!DOCTYPE") {
        return inject_chapter_heading(&ensure_xml_decl(input), title);
    }
```

**分支 2**(epub_writer.rs:166-173,`<?xml` 无 DOCTYPE):
```rust
    if trimmed.starts_with("<?xml") {
        let xml_end = trimmed.find("?>").map(|i| i + 2).unwrap_or(0);
        let after_xml_decl = &trimmed[xml_end..];
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(after_xml_decl, title).trim_start()
        );
        return inject_chapter_heading(&doc, title);
    }
```

**分支 3**(epub_writer.rs:177-183,有 `<html>` 根无 DOCTYPE):
```rust
    if lower.contains("<html") {
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(trimmed, title)
        );
        return inject_chapter_heading(&doc, title);
    }
```

**分支 4**(epub_writer.rs:186-190,纯 body 片段):
```rust
    let doc = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n\
<html xmlns=\"{XHTML_NS}\">\n<head>\n<title>{}</title>\n</head>\n<body>\n{input}\n</body>\n</html>",
        escape_xml(title),
    );
    inject_chapter_heading(&doc, title)
```

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
cd backend-rs && cargo test epub_writer
```
Expected: 全部 PASS(含新增 2 个 + 既有 5 个)。

同时全量:
```bash
cd backend-rs && cargo test
```
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend-rs/src/epub_writer.rs
git commit -m "feat(export): 导出章节正文开头插入 <h3> 标题"
```

---

### Task 3: 重新导出验证真实书

**Files:**
- 无代码改动,验证已部署的后端

**Interfaces:**
- Consumes: Task 1+2 的代码(需 `cargo build` 后重启后端才生效)

- [ ] **Step 1: 编译并重启后端**

Run:
```bash
cd backend-rs && cargo build 2>&1 | tail -3
```
Expected: `Finished` 无 error。

重启后端(停掉当前 8001 的后端进程,重新 `cargo run` 后台)。

- [ ] **Step 2: 重新导出该书**

Run:
```bash
curl -s -o /tmp/re-export.epub -w "HTTP %{http_code}\n" "http://localhost:8001/api/books/<该书id>/export"
```
(该书 id 可从之前查到的 `f41d5f8fb5a743af8c12735aa604bc1d` 确认)

- [ ] **Step 3: 解压检查标题**

Run:
```bash
cd /tmp && rm -rf recheck && mkdir recheck && cd recheck && unzip -o /tmp/re-export.epub >/dev/null && head -c 500 OEBPS/chapter_0000.xhtml
```
Expected:
- `<head><title>第1章 失能症候群</title></head>`(非空)
- `<body>` 开头有 `<h3>第1章 失能症候群</h3>`

- [ ] **Step 4: 用 Sigil/阅读器打开确认正文显示标题**(可选)

- [ ] **Step 5: 提交任何文档/说明改动**(无则跳过)
