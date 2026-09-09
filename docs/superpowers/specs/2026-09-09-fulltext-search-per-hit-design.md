# 全文搜索:逐次命中 + 点击定位 设计文档

- 日期:2026-09-09
- 状态:已实现
- 关联:README「🔎 全文搜索」;触发:用户反馈「搜索结果好像不全」

---

## 1. 问题与数据核查

用户反馈:搜《无敌剑域》的「殷萱儿」,页面只显示四十几个结果。用真实库核查(`%APPDATA%/com.ryu2u.epublibrary/library.db`):

| 指标 | 数值 |
|---|---|
| 章节总数 | 2782 |
| 含关键词的章节 | 45 |
| **总出现次数** | **457** |
| FTS 索引覆盖 | 2782 / 2782(完整) |

索引没有漏。**"看不全"是三个叠加的实现问题**:

1. **列表被截断**:前端 `useBookSearch` 不传分页参数 → 后端默认 `size=20` → 列表最多 20 行,而头部 `total` 显示 45;
2. **一章一条**:结果按章节聚合,457 次出现压成 45 行;主流阅读器是"一次出现一条 + 上下文";
3. **"N 处"是假的**:FTS 路径 `match_count = rank.abs()`(BM25 分数),实测显示 8/5/4,真实是 17/24/1。

## 2. 后端改造(`src-tauri/src/service/search.rs`)

**逐次命中模型**:一条 `SearchResult` = 关键词的一次出现。

```rust
pub struct SearchResult {
    chapter_id, chapter_title, spine_order,
    char_offset: i64,        // 命中处字符偏移(章内升序)
    index_in_chapter: i64,   // 章内第几次(1 起)—— 阅读器定位依据
    snippet: String,         // 上下文 HTML,关键词 <mark>,正文已转义
    before: String,          // 命中前 24 字纯文本(定位锚)
    matched: String,         // 命中的原文
}
pub struct SearchResponse {
    items, total,            // total = 全书命中次数(457)
    chapter_total,           // 命中章节数(45)
    query,
}
```

实现要点:

- **候选章节**:`q ≥ 3` 字符走 FTS5 trigram 选出章节(短语查询的引号转义为 `""`);`< 3` 字符走 `LIKE ... ESCAPE '\'`(转义 `%`/`_`,修复通配符误匹配);
- **逐次定位**:两条路径都统一在 Rust 侧用 `(?i)` + `regex::escape(q)` 定位每一次出现 —— 大小写不敏感且不改变字节偏移,保证 snippet/次数/偏移三者一致;
- **分页**:只物化当前页的条目(总次数仍需扫完,否则 `total` 不准);
- **HTML 转义**:snippet 会被前端 `dangerouslySetInnerHTML` 渲染,上下文与命中原文都做 `&<>"'` 转义(顺带修掉原先 FTS `snippet()` 未转义的注入面);
- **命令层**:默认 `size=50`(上限 200),响应新增 `chapter_total`。

## 3. 前端改造

| 文件 | 改动 |
|---|---|
| `api/types.ts` | 镜像新的 `SearchResult` / `SearchResponse` |
| `hooks/useBooks.ts` | `useBookSearch` → `useInfiniteQuery`(每页 50,`getNextPageParam` 按已加载数 < total 判定) |
| `pages/Detail.tsx` | 结果列表按次展示(章节 + 第 N 处 + 高亮片段)、「加载更多」、收尾显示「已显示全部 N 处」;点击结果带定位参数跳转 |
| `lib/locateText.ts`(新) | 文本定位:DOM 文本重建 + 映射回 (节点, 偏移),返回 `Range` |
| `pages/Reader.tsx` | 解析 `?q&n&b`;滚动模式:选中高亮 + 滚到屏幕中间;有定位参数时跳过进度恢复 |
| `reader/paged/*` | 分页模式:`usePaginator.goToTextLocator` 把定位换算成 `Boundary` 跳页,页面渲染后选中高亮 |

### 定位设计(关键)

数据库里章节存的是**纯文本**(换行/空白与渲染后的 DOM 不一致),所以不能用字符偏移直接映射。改用**「章内第 N 次出现 + 命中前上下文」**:

```
locateTextRange(root, { term, index, before })
  1. TreeWalker 拼接子树文本(跳过 script/style、display:none 隐藏文本),
     记录每段文本节点 → 拼接文本的区间映射
  2. 在拼接文本里找出 term 的所有出现(大小写不敏感)
  3. 取第 index 次;若前文与 before 不符(空白差异导致计数漂移),
     退化为「上下文唯一匹配」→ 再退化「第 N 次」→ 「第一次」
  4. 拼接偏移 → (文本节点, 偏移),构造 Range
```

好处:与渲染结果天然对齐;`display:none` 跳过是为了兼容阅读器的「正文首个标题去重」逻辑。

## 4. 测试

- **Rust**(`service::search::search_tests`,6 个):逐次命中计数与序号、跨章分页顺序、snippet HTML 转义、2 字中文 + 通配符转义、UTF-8 切片安全、空查询/无命中;
- **前端**:`locateText.test.ts`(8:第 N 次/跨标签/越界/上下文消歧/隐藏文本)、`DetailSearch.test.tsx`(3:按次展示/定位参数/加载更多)、`ReaderLocator.test.tsx`(2:滚动模式定位/无参数不选中)、`PagedFlip.test.tsx` 增加分页模式定位用例(跳到命中所在页 + 选中);
- 真实数据核对:候选 45 章、总命中 457、章内序号与偏移递增。

## 5. 已知取舍

- 总次数需要扫完所有候选章节的正文(FTS 只用来选章节),常用词下等价于一次全书文本扫描;桌面端可接受,若将来要更快可在 `chapters` 上加物化的命中计数表;
- 结果条数上限由分页控制,不做「一次全量」返回;
- 滚动模式的定位依赖选中高亮(不修改正文 DOM),翻页/切换章节后高亮自然消失。
