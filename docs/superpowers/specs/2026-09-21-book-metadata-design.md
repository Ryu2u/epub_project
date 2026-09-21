# 书籍元数据：分类 / 标签 / 别名 + 元数据搜索

- 日期：2026-09-21
- 状态：已批准（设计经对话确认），待实施

## 问题

书库目前只有导入时从 EPUB 提取的元数据（书名/作者/出版社/简介），用户无法给自己的书
打标签、归分类、记别名。书一多，「我标记过『待重读』的那几本」「所有日系推理」这类
个人维度的找书需求无法表达——现有搜索只匹配书名（`title LIKE '%q%'`，连作者都不搜）。

## 目标

1. 每本书可添加元数据：**分类（单选、可空）、标签（多值）、别名（多值）**
2. 搜索一体化：一个 `q` 同时子串匹配 书名 / 作者 / 分类 / 标签 / 别名
3. 录入为 combobox 模式：自由输入为主，已有分类/标签下拉建议可直接选，新值直接创建，无需预注册

非目标（已确认不做）：

- 书库按分类/标签的筛选 UI（facet 筛选条）
- 全量标签管理页（重命名/合并/批量删除）
- EPUB 导出带 `<dc:subject>`——导出是标准 EPUB 3 格式，元数据是应用层数据
- 顺手修复 publisher/description 的「清空不生效」缺陷——它与本次机制同源
  （`Option<String>` 无法区分 null 与缺字段），但修它会改变现有字段的 null 语义，
  属 API 行为变更，须单独确认单独做

## 关键决策（对话确认）

| 决策点 | 选择 |
|---|---|
| 元数据语义 | 经典三层：分类单选 + 标签多值 + 别名多值 |
| 搜索整合 | 仅一体化搜索，不加筛选 UI、不加搜索语法 |
| 录入体验 | 自由输入 + 已有值下拉建议（combobox），新值直接创建 |
| 存储方案 | books 表加三列（category TEXT、tags/aliases JSON 数组，同 authors 先例） |

## 设计

### 1. 数据模型

新增 `src-tauri/migrations/0006_book_metadata.sql`：

```sql
ALTER TABLE books ADD COLUMN category TEXT;
ALTER TABLE books ADD COLUMN tags     TEXT NOT NULL DEFAULT '[]';
ALTER TABLE books ADD COLUMN aliases  TEXT NOT NULL DEFAULT '[]';
```

- `tags` / `aliases` 与 `authors` 完全同型：JSON 数组存 TEXT 列（`authors` 是既有先例）
- 加列对旧二进制向后安全：仓库内全部查询用显式列清单，旧代码的 SELECT/INSERT 不受影响
- SQLite 的 `ALTER TABLE ADD COLUMN ... NOT NULL` 必须带 DEFAULT，故空库起步为 `'[]'`

### 2. 后端

**ORM（`core_db.rs` 的 `Book`）**：

```rust
pub category: Option<String>,
#[sqlx(json)]
pub tags: Vec<String>,
#[sqlx(json)]
pub aliases: Vec<String>,
```

**更新（`schema.rs` 的 `BookUpdate`）**——三态语义是关键设计：

- `tags: Option<Vec<String>>` / `aliases: Option<Vec<String>>`
  - `Some(vec)` = 整体替换；**`Some(vec![])` = 清空**；`None`（缺字段）= 不动
- `category: Option<Option<String>>`
  - `Some(Some(s))` = 设置；**`Some(None)` = 清空**；`None` = 不动
  - TS 侧类型 `category?: string | null`：undefined = 不发该字段，null = 清空
  - 为什么不学 publisher 的 `Option<String>`：它无法区分「null=清空」与「缺字段=不动」，
    现有实现里清空出版社实际不生效（`if let Some` 跳过了）——新字段必须避开这个坑

`update_book` 的 SET 构建沿用现有 `updates: Vec<(col, val)>` 模式，三个新字段按上述语义入列。

**搜索（`service/read.rs` 的 `list_books`）**：非空 `q` 的 WHERE 由

```sql
WHERE title LIKE ?
```

扩为五列 OR：

```sql
WHERE title LIKE ? OR authors LIKE ? OR category LIKE ? OR tags LIKE ? OR aliases LIKE ?
```

- 全部 `%q%` 子串；`authors`/`tags`/`aliases` 是 JSON 文本，中文按原文存储，LIKE 直接命中
- `%` / `_` / `\` 需转义，复用 `service/search.rs` 已有的 LIKE 转义写法
- **这是既有行为变更**：搜索从「只搜书名」变为「五列一体」——对话已确认
- SQLite `LIKE` 对 ASCII 大小写不敏感、对中文无影响，接受

**建议命令（新，`commands.rs`）**：

```
list_tag_suggestions() -> { categories: Vec<String>, tags: Vec<String> }
```

- 全库去重：`SELECT DISTINCT value FROM books, json_each(books.tags)`；
  分类为 `SELECT DISTINCT category FROM books WHERE category IS NOT NULL`
- 实现时验证 SQLite JSON1 可用（FTS5 已可用，bundled 构建通常两者都开）；
  不可用则退化为取列后 Rust 侧去重——个人书库规模两者性能无感
- 别名不做建议：别名（曾用名/译名）每本书独特，跨书复用无意义
- 注册进 `lib.rs` 的 `generate_handler!`

### 3. 备份（.epublib）兼容——**不升 BACKUP_VERSION**

这是「扩展现有行集（books.json）的字段」，不是新增行集：

- **新应用读旧归档**：books.json 缺三个新字段 → serde 对 `Option`/`Vec` 缺省
  （None / 空）→ 正常导入，元数据为空
- **老应用读新归档**：books.json 多出三个未知字段 → serde 默认忽略 →
  书正常导入，元数据静默丢弃（老应用本无此功能，属合理降级）
- 若升 v3 反而更糟：老应用会按「版本过新」**拒收整个备份**，书都导不进去——
  相比「导入成功但无元数据」，伤害更大
- 与 `src-tauri/AGENTS.md` 的「新增行集必须升版本」规则不冲突：那是行集（文件）维度，
  这是字段维度，双向兼容由 serde 缺省语义保证

改动点：`migration.rs` 的 `fetch_all_books` SELECT 与导入侧 `INSERT INTO books` 各加三列。

### 4. 前端

- `src/api/types.ts`：`Book` 加 `category: string | null`、`tags: string[]`、`aliases: string[]`
- `src/api/client.ts`：加 `fetchTagSuggestions()`；**浏览器分支返回空列表**（无后端，
  模式同 `reader_prefs` 的「仅桌面端」处理），Tauri 分支 invoke `list_tag_suggestions`
- **Detail 编辑表单**（扩展既有 `metaDraft`，无新组件、零新依赖）：
  - 分类：单行 input + 原生 `<datalist>` 列出已有分类
  - 标签 / 别名：逗号分隔单行 input（与 `authors` 完全同型的既有模式），
    input 下方一排已有值的小 chips，点击追加
  - 保存：`tags`/`aliases` 按逗号切分过滤空串后提交（`[]` 即清空）；
    `category` 提交 `string | null`
- **Detail 展示**：元数据区显示分类与标签（小 chip）、别名小字副行
- **Library / SearchSheet 零改动**：共用 `?q=`，搜索扩列后自动受益

### 5. 测试

- Rust：
  - 迁移后三列读写（`ALTER` 后旧书三列为 NULL/[]，不炸现有查询）
  - 搜索命中矩阵：书名/作者/分类/标签/别名各一条命中 + 一条五列都不命中
  - 更新语义：整体替换 / 空数组清空 / 缺字段不动 / category 三态
  - 归档往返带元数据；**旧格式归档（books.json 无新字段）导入不报错**
  - `list_tag_suggestions` 去重与空库
- 前端：编辑表单三字段渲染与提交载荷、建议拉取（含浏览器降级）、类型门禁
- 回归基线：Rust 104 / 前端 31 文件 189 必须保持全绿

### 6. 文档同步

README（特性列表、Tauri 命令表加 `list_tag_suggestions`、备份描述提元数据随 books 行集走、
搜索行为从「书名」改为「五列」）、`src-tauri/AGENTS.md` §5 迁移清单加 `0006`、
根 `AGENTS.md` §28.5 验证基线。

## 影响面

| 层 | 文件 |
|---|---|
| 数据库 | 新增 `migrations/0006_book_metadata.sql` |
| 后端 | `core_db.rs`（Book）、`schema.rs`（BookUpdate）、`service/read.rs`（搜索）、`service/write.rs`（更新）、`commands.rs`（建议命令 + 透传）、`lib.rs`（注册）、`migration.rs`（行集列） |
| 前端 | `api/types.ts`、`api/client.ts`、`pages/Detail.tsx`（编辑表单 + 展示） |
| 文档 | `README.md`、`src-tauri/AGENTS.md`、根 `AGENTS.md` |
