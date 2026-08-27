# 章节内搜索 2 字中文 panic 修复设计

## 背景

用户在 EPUB Library Web App 的书籍详情页（`http://localhost:3000/books/{id}`）输入 2 个中文字搜索章节内容时（例如"开端"），请求失败、搜索面板无结果。

## 根因

`backend-rs/src/service/search.rs::search_like` 在生成高亮片段时按 **UTF-8 字节偏移** 切片章节正文：

```rust
// src/service/search.rs:155-157
let ctx_start = start.saturating_sub(40);
let ctx_end = (end + 40).min(text_len);
let ctx = &ch.text[ctx_start..ctx_end];
```

`re.find_iter` 返回的 `start` / `end` 是字节偏移。当匹配位置距离 `ch.text` 开头不足 40 字节时，`ctx_start` 可能落在某个 UTF-8 多字节字符的中间。Rust 的 `&text[a..b]` 要求 `a` / `b` 必须落在 UTF-8 字符边界上，否则直接 panic（`byte index N is not a char boundary`）。

panic 通过 axum 任务冒泡，导致当前 worker 崩溃，连接被 RST——前端看到的就是"无结果"（实际是请求失败）。

复现证据：
- `q=第一`（3 字）→ 走 FTS 路径 → 正常返回空 JSON
- `q=开端`（2 字）→ 走 LIKE 路径 → **服务端 RST，curl 报 52 Empty reply**
- 在 SQLite 直接用 LIKE 查询命中的章节文本，确认 `&text[447..]` 切到汉字"业"（`\xe8\x8a\xb8`）的中间字节 `0x8d`

字符数边界：
- `< 2` 字符：handler 入口 `q.trim().chars().count() < 2` 直接返回空响应，不进入 search_like
- `2` 字符：走 `search_like`，snippet 切片可能 panic
- `>= 3` 字符：走 `search_fts`，不切片字符文本，正常

所以问题只在 2 字符中英文输入时会触发，3 字及以上恰好绕过——这解释了为什么用户报告"搜索书本内容有问题"但部分搜索能工作。

## 设计

### 修复范围

只改 `backend-rs/src/service/search.rs::search_like` 中的 snippet 切片逻辑。零行为变化（修复前正确的路径修复后仍然正确，修复前 panic 的路径修复后正确返回片段）。

### 修复方式

用 `str::ceil_char_boundary` / `floor_char_boundary`（Rust 1.79+ std）在切片前把字节偏移圆整到最近的字符边界：

```rust
let ctx_start = start.saturating_sub(40);
let ctx_end = (end + 40).min(text_len);
// 圆整到字符边界：saturating_sub 后 ctx_start 可能落到字符中间
let safe_start = ch.text.ceil_char_boundary(ctx_start);
let safe_end = ch.text.floor_char_boundary(ctx_end);
let ctx = &ch.text[safe_start..safe_end];
```

`str::ceil_char_boundary(n)` 返回不小于 `n` 的最小字符边界；`floor_char_boundary(n)` 返回不大于 `n` 的最大字符边界。两个都是 const fn、单字节成本，常数时间。

> 选用 floor/ceil 而不是 chars().take()：最小修改、零行为变化、保留所有现有匹配逻辑（regex 偏移、snippet 拼接、ellipsis 前缀后缀均不变）。只是把"可能 panic 的字节下标"变成"保证安全的字符边界下标"。

### 数据流

```
GET /api/books/:id/search?q=开端
  └─ search_in_book(q.chars().count() == 2)
     └─ search_like("开端")
        ├─ SQL: chapters.text LIKE '%开端%'      (1 行)
        ├─ re.find_iter → [(487, 493)]
        ├─ ctx_start = 447, ctx_end = 533        ← 现在可能落在字符中间
        ├─ [修复后] ceil/floor 到 447/533 → 450/533（推到"业"之后）
        └─ &ch.text[450..533]                    ← 安全切片
```

### 错误处理

- 如果 `ceil_char_boundary(ctx_start)` 之后等于 `ctx_end`（极端情况：上下文窗口被反向圆整成空），snippet 退化为空字符串——与现有"snippet 为空时不挂前缀后缀"行为一致。
- 不引入任何新的 Result / Option 路径。
- 不修改 handler 层的 `q.chars().count() < 2` 早 return 逻辑。

### 测试

在 `backend-rs/src/service/search.rs` 末尾新增 `#[cfg(test)] mod tests`，复用已有 `service::chapter_html_io_tests::setup()` 风格的 in-memory SQLite fixture，覆盖三个场景：

1. **`search_like_does_not_panic_on_short_chinese_match`** — 命中位置在文本前 40 字节内、且 40 字节偏移落在 UTF-8 字符中间（复现当前 bug）。修复前 panic，修复后返回带 `<mark>` 的片段。
2. **`search_like_highlights_match_with_chinese_context`** — 命中位置远离开头，前后都有 40 字节以上中文上下文。验证 snippet 同时包含前/后 ellipsis 与 `<mark>` 标签（保证未引入回归）。
3. **`search_in_book_2char_chinese_does_not_panic`** — 走完整 `search_in_book("开端")` 路径，验证修复对公共 API 也有效。

三个测试都用真实 UTF-8 中文输入，确保不会因为切到 ASCII 字符边界而误判"通过"。

### 范围外

- **不修 handler 层的字符阈值**：`< 2` 字符早 return、`>= 3` 走 FTS 的策略与原 Python 版一致，本次只消除 panic，不动分支选择。
- **不改 search_fts**：FTS 路径不切片字符文本，无同样问题。
- **不改前端**：浏览器 `encodeURIComponent` 已是 UTF-8 percent-encode，curl 看到的 GBK 编码仅是 cmd 代码页 936 的工具现象，与前端无关。
- **不优化 LIKE 性能**：本次只消除 panic。

## 验证

1. `cargo test search_like` 在新测试上从 panic 转为绿色
2. `cargo test` 全量绿（确保 search_fts、chapter_html_io 等未回归）
3. 重启 `epub-backend-rs.exe`，对 `082a89674928431886c95adb62f865cd` 这本书 curl `q=开端`：
   - 修复前：`curl: (52) Empty reply from server`
   - 修复后：`{"items":[{"chapter_id":"...","chapter_title":"...","spine_order":...,"snippet":"...<mark>开端</mark>...","match_count":N}], "total":1, "query":"开端"}`
4. 浏览器手工验证：打开 `http://localhost:3000/books/082a89674928431886c95adb62f865cd`，搜索框输入"开端"，400ms debounce 后搜索结果列表显示 1 条命中片段。

## 风险

极低：
- `ceil/floor_char_boundary` 是 std API（1.79+），稳定
- 修改局限在 `search_like` 内一个函数片段
- 现有 17 个 web 测试与本次修改无关
- 没有 SQL 改动、没有 schema 改动、没有 API contract 改动