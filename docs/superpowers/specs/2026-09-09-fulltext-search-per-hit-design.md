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

**按章节分组的逐次命中**:分页单位是章节,章为一行,组内带本章每一次出现。

```rust
pub struct SearchHit {           // 一次出现
    index_in_chapter: i64,       // 章内第几次(1 起)—— 阅读器定位依据
    char_offset: i64,            // 命中处字符偏移
    snippet: String,             // 上下文 HTML,关键词 <mark>,正文已转义
    before: String,              // 命中前 24 字纯文本(定位锚)
    matched: String,             // 命中的原文
}
pub struct SearchChapter {       // 一个命中章节(一个分组)
    chapter_id, chapter_title, spine_order,
    match_count: i64,            // 本章命中次数
    hits: Vec<SearchHit>,        // 本章全部命中(按出现顺序)
}
pub struct SearchResponse {
    items: Vec<SearchChapter>,   // 当前页章节
    total: i64,                  // 全书命中次数(457)
    chapter_total: i64,          // 命中章节数(45)
    query,
}
```

实现要点:

- **候选章节**:`q ≥ 3` 字符走 FTS5 trigram 选出章节(短语查询的引号转义为 `""`);`< 3` 字符走 `LIKE ... ESCAPE '\'`(转义 `%`/`_`,修复通配符误匹配);
- **逐次定位**:两条路径都统一在 Rust 侧用 `(?i)` + `regex::escape(q)` 定位每一次出现 —— 大小写不敏感且不改变字节偏移,保证 snippet/次数/偏移三者一致;
- **分页**:只物化当前页章节的 `hits`(总次数仍需扫完,否则 `total` 不准);
- **HTML 转义**:snippet 会被前端 `dangerouslySetInnerHTML` 渲染,上下文与命中原文都做 `&<>"'` 转义(顺带修掉原先 FTS `snippet()` 未转义的注入面);
- **命令层**:默认 `size=20`(每页 20 章,上限 100),响应新增 `chapter_total`。

> 演进说明:第一版做成「平铺的逐次命中」(457 行),用户反馈「同一章的结果看起来重复」;
> 第二版改为**章节分组 + 展开**——既保留全部出现(不漏),又不会有重复感。
> 数据核实:第 685 章正文里「殷萱儿」确实出现 6 次且上下文各不相同,不是重复结果。

## 3. 前端改造

| 文件 | 改动 |
|---|---|
| `api/types.ts` | 镜像 `SearchHit` / `SearchChapter` / `SearchResponse` |
| `hooks/useBooks.ts` | `useBookSearch` → `useInfiniteQuery`(每页 20 章,`getNextPageParam` 按已加载章节数 < `chapter_total` 判定) |
| `pages/Detail.tsx` | 章节分组列表:章行(序号 + 标题 + `N 处` + 展开/收起),折叠时只给第 1 条预览 + 「展开其余 N 处…」;展开后每条出现都可点击跳转;「加载更多」按章节翻页 |
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

- **Rust**(`service::search::search_tests`,6 个):按章节分组(一章 3 次 → 1 组 3 条命中)、按章节分页、snippet HTML 转义、2 字中文 + 通配符转义、UTF-8 切片安全、空查询/无命中;
- **前端**:`locateText.test.ts`(8:第 N 次/跨标签/越界/上下文消歧/隐藏文本)、`DetailSearch.test.tsx`(3:按次展示/定位参数/加载更多)、`ReaderLocator.test.tsx`(2:滚动模式定位/无参数不选中)、`PagedFlip.test.tsx` 增加分页模式定位用例(跳到命中所在页 + 选中);
- 真实数据核对:候选 45 章、总命中 457、章内序号与偏移递增。

## 5. 已知取舍

- 总次数需要扫完所有候选章节的正文(FTS 只用来选章节),常用词下等价于一次全书文本扫描;桌面端可接受,若将来要更快可在 `chapters` 上加物化的命中计数表;
- 结果条数上限由分页控制,不做「一次全量」返回;
- 滚动模式的定位依赖选中高亮(不修改正文 DOM),翻页/切换章节后高亮自然消失。

## 6. 返回详情页恢复搜索状态

**问题**:搜索结果多、翻了很久,点进阅读页再返回,详情页回到初始状态(搜索词、展开、滚动位置全丢),得重新搜。

**方案**:`src/lib/detailSearchState.ts` —— 用 **sessionStorage**(标签页级,关掉即失效,不污染长期存储),按 bookId 隔离:

- 点击某条命中前(Link 的 onClick)暂存 `{query, expanded, scrollTop, windowScrollY}`;
- 详情页挂载时 `takeDetailSearch`(读取即消费):恢复关键词(跳过 debounce 直接生效)、展开集合、结果渲染完成后恢复滚动位置(容器 `scrollTop` 与页面 `window.scrollY` 都存,窄屏/宽屏各自命中);
- **读取即消费**:正常从书库进入书籍时不会莫名弹出旧搜索结果;
- 展开集合改为受控(父组件持有),并处理「恢复时不要被『关键词变化清空展开』误清」——用 `prevQueryRef`(跳过挂载首帧)+ `restoredForQueryRef`(识别恢复来源)两个 ref 精确判断。

测试:`detailSearchState.test.ts`(6:往返/消费/隔离/空词/脏数据/清除)、`DetailSearchRestore.test.tsx`(2:恢复关键词+展开+滚动、状态只消费一次)。
