# 章节内搜索 2 字中文 panic 修复实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `backend-rs` `search_like` 在生成 snippet 时按字节切片 UTF-8 文本导致的 panic，使任意长度的中文搜索都能返回正常结果。

**Architecture:** 局限在 `backend-rs/src/service/search.rs` 一个文件：用 `str::ceil_char_boundary` / `floor_char_boundary` 把切片下标圆整到 UTF-8 字符边界。在文件末尾新增 `#[cfg(test)] mod tests`，复用现有 `service::chapter_html_io_tests::setup()` 风格的 in-memory SQLite fixture。

**Tech Stack:** Rust 1.79+（std `ceil_char_boundary` / `floor_char_boundary`）、tokio-test、sqlx 0.8 in-memory SQLite、tempfile。

## Global Constraints

- 项目是 Rust binary crate，没有 lib 入口——测试用 `#[cfg(test)] mod tests` 放在 `src/service/search.rs` 末尾，与现有 `service::chapter_html_io_tests` 风格一致。
- 修复后**零行为变化**：原本成功的 LIKE 路径（前后都有 40 字节以上余量）必须保持现有 snippet 内容。
- 测试用现有 `setup()` 风格 fixture（in-memory SQLite + tempfile），不引入新依赖。
- Rust 工具链为 1.96 nightly，`ceil_char_boundary` / `floor_char_boundary` 均可用。
- 提交粒度：每个 Task 一次 commit，commit message 遵循现有 `feat(scope): ...` / `test(scope): ...` 风格。

## File Structure

- **Modify:** `backend-rs/src/service/search.rs`
  - 改 `search_like` 内部一个局部切片（约 3 行）
  - 文件末尾新增 `#[cfg(test)] mod tests`（约 60 行测试 + 共享 fixture）
- **No other files modified.**

---

### Task 1: 写失败测试 — LIKE 短中文匹配不 panic

**Files:**
- Modify: `backend-rs/src/service/search.rs`（在文件末尾追加 `#[cfg(test)] mod tests`，不动现有 `#[cfg(test)] mod chapter_html_io_tests`）
- Test: 同一文件内的 tests 模块

**Interfaces:**
- Consumes: `BookService::search_in_book(&self, book_id: &str, q: &str, page: i64, size: i64) -> Result<(Vec<SearchResult>, i64), EpubError>`（已存在）
- Produces: 不导出新接口。tests 模块对外不可见。

**背景：** 在 `search.rs` 末尾追加 tests 模块前，先确认原文件结构 —— `search.rs` 已有的顶层代码包括 `impl BookService { pub async fn search_in_book ... async fn search_fts ... async fn search_like ... }`，最后没有 `#[cfg(test)] mod`。新增的 tests 模块必须放在文件最末尾，且包含自己内部的 fixture 函数（不复用 `service::chapter_html_io_tests::setup`，因为那是另一个文件 `#[cfg(test)] mod chapter_html_io_tests { ... }` 的私有函数，跨文件不可见）。

- [ ] **Step 1: 在 `backend-rs/src/service/search.rs` 末尾追加 tests 模块头与 fixture**

在该文件**最末尾**追加：

```rust
// ========== LIKE 路径 UTF-8 切片安全测试 ==========
//
// 修复前 search_like 在生成 snippet 时按字节切片 UTF-8 文本,匹配位置距
// 章节开头不足 40 字节且落在字符中间时会 panic。本模块锁定该修复。

#[cfg(test)]
mod search_like_utf8_tests {
    use super::*;
    use crate::api::schema::SearchResult;
    use chrono::Utc;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// 临时 storage 目录 + 跑过 migration 的 in-memory SQLite。
    /// 与 service::chapter_html_io_tests::setup 等价,但独立以便本模块使用。
    async fn setup() -> (BookService, TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(":memory:")
            .expect("sqlite opts")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let svc = BookService::new(pool, tmp.path().to_path_buf());
        (svc, tmp)
    }

    /// 插入一本带 N 章的书。html 列已不存在于 schema 中,不写文件。
    async fn insert_book_with_chapter(svc: &BookService, book_id: &str, chapter_id: &str, text: &str) {
        sqlx::query(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, '测试书', '[]', 'zh', ?, ?, 0, 'deadbeef', ?)",
        )
        .bind(book_id)
        .bind(book_id)
        .bind(format!("{book_id}.epb"))
        .bind(Utc::now().naive_utc())
        .execute(&svc.pool)
        .await
        .expect("insert book");

        sqlx::query(
            "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
             VALUES (?, ?, '第一章', 0, 'OEBPS/ch1.xhtml', ?, 0)",
        )
        .bind(chapter_id)
        .bind(book_id)
        .bind(text)
        .execute(&svc.pool)
        .await
        .expect("insert chapter");
    }
}
```

- [ ] **Step 2: 追加第一个失败测试**

在 `search_like_utf8_tests` 模块内、`}` 闭合之前，追加：

```rust
    /// 修复前 panic:匹配位置在文本前 40 字节内,切片落在 UTF-8 字符中间。
    /// 修复后应返回 1 条带 <mark> 的 snippet。
    #[tokio::test]
    async fn search_like_does_not_panic_on_short_chinese_match() {
        let (svc, _tmp) = setup().await;
        // 文本开头先放 ~38 个 ASCII 字符 + 一个中文片段,保证 "开端" 命中位置
        // 距文本开头 < 40 字节且 ctx_start=447 落在中文汉字"业"中间。
        // 实际选一个更短的: 开头 30 个 ASCII 后接中文,确保 ctx_start 必然切到字符中间。
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa他突然觉得这一幕也许会成为某种改变的开端。\
                    他抬头看向远方,期待接下来会发生什么。";
        insert_book_with_chapter(&svc, "book-utf8-1", "ch-1", text).await;

        let (items, total) = svc
            .search_in_book("book-utf8-1", "开端", 1, 20)
            .await
            .expect("search_in_book should not panic");

        assert_eq!(total, 1, "expected 1 matching chapter, got {total}");
        assert_eq!(items.len(), 1);
        let item: &SearchResult = &items[0];
        assert!(
            item.snippet.contains("<mark>开端</mark>"),
            "snippet should highlight match, got: {}",
            item.snippet
        );
    }
```

- [ ] **Step 3: 运行测试,确认 panic**

在 `backend-rs/` 目录执行：

```bash
cargo test --no-fail-fast search_like_does_not_panic_on_short_chinese_match
```

**Expected output:** 测试失败,stderr 含 `panicked at ... byte index N is not a char boundary`。

- [ ] **Step 4: 不要 commit,留在 worktree**

失败状态先留着,留给 Task 2 修复时让它转绿。

---

### Task 2: 修复 search_like 的字节切片 panic

**Files:**
- Modify: `backend-rs/src/service/search.rs:154-157`（search_like 内 `for &(start, end) in matches.iter().take(3)` 块）

**Interfaces:** 不改任何函数签名。`search_in_book` / `search_like` / `search_fts` 的签名与返回值保持原样。

- [ ] **Step 1: 修改切片逻辑**

把 `backend-rs/src/service/search.rs` 中:

```rust
            for &(start, end) in matches.iter().take(3) {
                let ctx_start = start.saturating_sub(40);
                let ctx_end = (end + 40).min(text_len);
                let ctx = &ch.text[ctx_start..ctx_end];
```

替换为:

```rust
            for &(start, end) in matches.iter().take(3) {
                let ctx_start = start.saturating_sub(40);
                let ctx_end = (end + 40).min(text_len);
                // 圆整到最近的 UTF-8 字符边界,避免 saturating_sub 后落在多字节字符中间。
                let safe_start = ch.text.ceil_char_boundary(ctx_start);
                let safe_end = ch.text.floor_char_boundary(ctx_end);
                let ctx = &ch.text[safe_start..safe_end];
```

唯一变量名变化: `ctx` 的切片下标从 `ctx_start..ctx_end` 改为 `safe_start..safe_end`。后续使用 `ctx` 的代码（`highlighted`、`prefix`、`suffix`）保持不变。

- [ ] **Step 2: 跑 Task 1 的失败测试,确认转绿**

```bash
cd backend-rs && cargo test --no-fail-fast search_like_does_not_panic_on_short_chinese_match
```

**Expected output:** PASS。

- [ ] **Step 3: 跑 search_like_utf8_tests 整个模块,确认没有引入回归**

```bash
cd backend-rs && cargo test --no-fail-fast search_like_utf8_tests
```

**Expected output:** 1 passed, 0 failed。

- [ ] **Step 4: Commit**

```bash
git add backend-rs/src/service/search.rs
git commit -m "fix(search): 用 ceil/floor_char_boundary 防止 LIKE 路径 panic"
```

---

### Task 3: 补中文上下文与公共 API 测试

**Files:**
- Modify: `backend-rs/src/service/search.rs`（在 `search_like_utf8_tests` 模块内追加两个测试）

**Interfaces:** 不改接口。仅追加测试。

- [ ] **Step 1: 追加中文上下文测试**

在 `search_like_does_not_panic_on_short_chinese_match` 函数 `}` 之后、`mod search_like_utf8_tests` 闭合 `}` 之前，追加：

```rust
    /// 命中位置远离开头,前后都有充足上下文,验证 snippet 包含前/后 ellipsis
    /// 与 <mark> 高亮,确保修复未引入回归。
    #[tokio::test]
    async fn search_like_highlights_match_with_chinese_context() {
        let (svc, _tmp) = setup().await;
        let prefix: String = "春".repeat(50);
        let suffix: String = "夏".repeat(50);
        let text = format!("{prefix}命中关键词{suffix}");
        insert_book_with_chapter(&svc, "book-utf8-2", "ch-1", &text).await;

        let (items, total) = svc
            .search_in_book("book-utf8-2", "命中关键词", 1, 20)
            .await
            .expect("search should succeed");

        assert_eq!(total, 1);
        assert_eq!(items.len(), 1);
        let snip = &items[0].snippet;
        assert!(snip.starts_with('…'), "snippet should have leading ellipsis, got: {snip}");
        assert!(snip.ends_with('…'), "snippet should have trailing ellipsis, got: {snip}");
        assert!(
            snip.contains("<mark>命中关键词</mark>"),
            "snippet should highlight match, got: {snip}"
        );
    }

    /// 走完整 search_in_book 公共 API,验证 2 字中文输入在修复后
    /// 不再触发 panic 且能正常返回结果或空结果。
    #[tokio::test]
    async fn search_in_book_2char_chinese_does_not_panic() {
        let (svc, _tmp) = setup().await;
        // 一本没有任何"开端"二字的书,期望返回空结果(不是 panic)
        let text = "这是一些不包含目标关键词的普通文本内容,用于验证搜索路径在无命中时也能正常返回。";
        insert_book_with_chapter(&svc, "book-utf8-3", "ch-1", text).await;

        let (items, total) = svc
            .search_in_book("book-utf8-3", "开端", 1, 20)
            .await
            .expect("search should not panic on 2-char Chinese");

        assert_eq!(total, 0, "expected 0 matches, got {total}");
        assert!(items.is_empty());
    }
```

- [ ] **Step 2: 跑全部 search_like_utf8_tests 模块**

```bash
cd backend-rs && cargo test --no-fail-fast search_like_utf8_tests
```

**Expected output:** 3 passed, 0 failed。

- [ ] **Step 3: 跑后端全量测试,确认无回归**

```bash
cd backend-rs && cargo test
```

**Expected output:** 全绿,无 panic,无回归。如果有其他模块失败,**先停下来排查**,不要继续。

- [ ] **Step 4: Commit**

```bash
git add backend-rs/src/service/search.rs
git commit -m "test(search): 补中文上下文与 2 字搜索公共 API 测试"
```

---

### Task 4: 端到端验证 + 浏览器手工验证

**Files:** 不修改任何文件。

**Interfaces:** 不改接口。

- [ ] **Step 1: 重新编译并启动后端**

当前 `epub-backend-rs.exe` 是 `cargo run` 启动的进程(PID 在 `Get-Process` 中可见),停止它并重新构建运行:

```bash
cd backend-rs
# 停止运行中的后端(根据 PID,实际执行时换成 Get-Process 查到的 PID)
Stop-Process -Id <PID> -Force
cargo run
```

或者保留原进程,只在测试通过的前提下进行端到端验证。**注意: 运行中的后端进程用的是修复前的二进制,搜索路径仍会 panic**——必须先停止旧进程,重新启动新二进制后才能 curl 验证。

- [ ] **Step 2: 用 curl 验证 2 字中文搜索返回正常 JSON**

新后端启动后,执行:

```bash
curl -sS -m 5 'http://127.0.0.1:8001/api/books/082a89674928431886c95adb62f865cd/search?q=%E5%BC%80%E7%AB%AF&page=1&size=3'
```

**Expected output:** JSON,`total >= 0`,`items` 是数组,`query` 字段回显 `"开端"`(不是乱码也不是 U+FFFD),`items[0].snippet` 含 `<mark>开端</mark>`。

**修复前对照(不要再回到这个状态):** `curl: (52) Empty reply from server`。

- [ ] **Step 3: 验证 1 字/3 字搜索行为未变**

```bash
curl -sS -m 5 'http://127.0.0.1:8001/api/books/082a89674928431886c95adb62f865cd/search?q=%E5%BC%80&page=1&size=3'
curl -sS -m 5 'http://127.0.0.1:8001/api/books/082a89674928431886c95adb62f865cd/search?q=%E7%AC%AC%E4%B8%80%E7%AB%AF&page=1&size=3'
```

**Expected output:** 两个请求都返回 200 JSON,`query` 字段正常 UTF-8 回显。

- [ ] **Step 4: 浏览器手工验证**

打开 `http://localhost:3000/books/082a89674928431886c95adb62f865cd`,在搜索框输入 `开端`,等 400ms debounce。**Expected:** 搜索结果面板显示 1 条命中,章节标题 + 含 `<mark>` 高亮的 snippet。

- [ ] **Step 5: 无需 commit (Task 4 无文件变更)**

如果验证失败,**回到 Task 1 重新诊断**,不要继续。