# 书籍元数据（分类/标签/别名 + 元数据搜索）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每本书可添加分类（单选）/标签（多值）/别名（多值），搜索从「只搜书名」扩为五列一体化（书名/作者/分类/标签/别名）。

**Architecture:** books 表加三列（category TEXT、tags/aliases JSON 数组同 authors 先例）；`BookUpdate` 用三态语义（`Some(vec![])`=清空、`Option<Option<String>>` 区分清空/不动）；搜索改 `list_books` 的 WHERE 为五列 OR + LIKE 转义；新增 `list_tag_suggestions` 补全命令。**`BACKUP_VERSION` 不升**（扩字段而非新增行集，双向兼容由 serde 缺省保证，理由见 spec §3）。

**Tech Stack:** Tauri 2 + sqlx 0.8（SQLite WAL）、React 18 + TS、Vitest / cargo test。

**Spec:** `docs/superpowers/specs/2026-09-21-book-metadata-design.md`

## Global Constraints

- 分支：`feat/book-metadata`（已建）。提交信息风格 `type(scope): 中文描述`，写为什么。
- 测试基线（动手前实测）：Rust **104 passed**、前端 **31 文件 / 189 passed**、`pnpm typecheck` 通过；`cargo clippy --all-targets` 仅既存 `src/epub/txt.rs:195` 失败（用 `-- -A clippy::manual_is_multiple_of` 放行后必须零新增）。
- 注释一律中文，解释为什么。Rust 每步过 `cargo fmt`；前端无 lint，靠 `tsc`。
- 错误处理沿用 `EpubError::FileSystem(format!("…：{e}"))` 既有格式。
- **禁止修改历史迁移**（0001-0005）；新结构只进 `0006`。
- README 是完成的一部分（Task 6 有清单）。
- 工作区当前 clean；不要动与本任务无关的文件。

---

### Task 1: 数据层打通（迁移 + ORM + 归档列 + DTO + 前端类型）

`Book` 结构体加字段后所有 `query_as::<_, Book>` 的 SELECT 与归档 INSERT 必须同批改，否则运行时缺列报错——这是一个原子编译单元，不能拆。

**Files:**
- Create: `src-tauri/migrations/0006_book_metadata.sql`
- Modify: `src-tauri/src/core_db.rs:37-63`（Book 结构体）
- Modify: 所有 Book SELECT 列清单（`grep -n 'file_sha256, created_at' src-tauri/src/` 逐处确认：`service/read.rs` 的 `get_book_orm` 与 `list_books` 两分支、`migration.rs` 的 `fetch_all_books`）
- Modify: `src-tauri/src/migration.rs:350-352`（导入 INSERT）与测试模块
- Modify: `src-tauri/src/schema.rs:67-94`（BookDetail）、`src-tauri/src/service/read.rs:203-243`（book_to_detail）
- Modify: `src/api/types.ts:39-46`（BookDetail）
- Test: `src-tauri/src/migration.rs`（tests 模块加两条）

**Interfaces:**
- Produces: `Book.category: Option<String>`、`Book.tags: Vec<String>`、`Book.aliases: Vec<String>`（`#[sqlx(json)]`）；`BookDetail`/TS `BookDetail` 同名三字段（TS：`category: string | null; tags: string[]; aliases: string[]`）。后续任务直接依赖这些名字。

- [ ] **Step 1: 写迁移文件**

`src-tauri/migrations/0006_book_metadata.sql`：

```sql
-- 书籍元数据：分类(单选,可空) / 标签(多值) / 别名(多值)。
-- tags/aliases 与 authors 同型：JSON 数组存 TEXT。
-- SQLite 的 ADD COLUMN NOT NULL 必须带 DEFAULT，故存量行起步为 '[]'。
ALTER TABLE books ADD COLUMN category TEXT;
ALTER TABLE books ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE books ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 2: 写失败测试（旧归档无新字段必须能导入）**

`src-tauri/src/migration.rs` tests 模块末尾追加。这条锁的是 serde 缺省语义——**`Vec<String>` 缺字段会报 `missing field`，必须显式 `#[serde(default)]`**（spec 原文说「serde 对 Vec 缺省」不准确，以此测试为准）：

```rust
    // ---------- 书籍元数据随备份走(0006) ----------

    /// 造一本完整 Book 行的 JSON，可选剔除三个新字段（模拟 v2 时代的旧归档）。
    fn book_json_minus_metadata() -> Vec<u8> {
        let mut v = serde_json::json!({
            "id": "book-1", "title": "旧书", "authors": ["作者"],
            "language": "zh", "publisher": null, "description": null,
            "pub_date": null, "identifier": "book-1",
            "file_path": "book-1.epb", "file_size": 10, "file_sha256": "sha-1",
            "created_at": "2024-01-01T00:00:00",
            "category": "小说", "tags": ["推理"], "aliases": ["旧称"],
        });
        let obj = v.as_object_mut().unwrap();
        for k in ["category", "tags", "aliases"] {
            obj.remove(k);
        }
        serde_json::to_vec(&v).unwrap()
    }

    /// 旧格式归档（books.json 的行缺三个新字段）必须照常导入，元数据落空值。
    /// 不升 BACKUP_VERSION 的前提就是这条：serde 缺省兜住旧数据。
    #[tokio::test]
    async fn old_archive_without_metadata_imports_cleanly() {
        let tmp = tempfile::tempdir().expect("tmp");
        let svc = setup_service(tmp.path()).await;

        let archive = tmp.path().join("old.epublib");
        let f = std::fs::File::create(&archive).unwrap();
        let mut zw = ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(
            format!(r#"{{"format":"{BACKUP_FORMAT}","version":{BACKUP_VERSION}}}"#).as_bytes(),
        )
        .unwrap();
        zw.start_file("books.json", opts).unwrap();
        zw.write_all(&book_json_minus_metadata()).unwrap();
        for row in ["chapters.json", "assets.json", "reader_prefs.json"] {
            zw.start_file(row, opts).unwrap();
            zw.write_all(b"[]").unwrap();
        }
        zw.finish().unwrap();

        let r = import_library(&svc, &archive, Arc::new(|_, _, _| {})).await;
        assert!(r.is_ok(), "缺新字段的旧归档应正常导入:{r:?}");
        let detail = svc.fetch_book_detail("book-1").await.expect("detail").expect("exists");
        assert_eq!(detail.category, None);
        assert!(detail.tags.is_empty() && detail.aliases.is_empty());
    }

    /// 带元数据的导出 → 导入往返，三个字段原样到达。
    #[tokio::test]
    async fn metadata_survives_export_import_roundtrip() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &[]).await;
        sqlx::query("UPDATE books SET category = '小说', tags = '[\"推理\",\"日系\"]', aliases = '[\"旧称\"]' WHERE id = 'book-1'")
            .execute(&svc_a.pool).await.unwrap();

        let archive = tmp_a.path().join("backup.epublib");
        export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");
        import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");

        let d = svc_b.fetch_book_detail("book-1").await.expect("detail").expect("exists");
        assert_eq!(d.category.as_deref(), Some("小说"));
        assert_eq!(d.tags, vec!["推理".to_string(), "日系".to_string()]);
        assert_eq!(d.aliases, vec!["旧称".to_string()]);
    }
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src-tauri && cargo test old_archive_without_metadata metadata_survives 2>&1 | tail -5`
Expected: 编译失败（`detail.category` 字段不存在）或运行时缺列报错——红。

- [ ] **Step 4: 实现**

`core_db.rs` Book 结构体，在 `identifier` 字段后加：

```rust
    /// 分类（单选，用户自定义；可空）
    pub category: Option<String>,
    /// 标签（多值，用户自定义；JSON 列，同 authors）
    ///
    /// `#[serde(default)]`：旧归档的 books.json 行没有该字段，Vec 缺字段会报
    /// missing field（Option 才自动缺省为 None），必须显式声明。
    #[serde(default)]
    #[sqlx(json)]
    pub tags: Vec<String>,
    /// 别名（多值，搜索匹配用；JSON 列，同上需要 serde default）
    #[serde(default)]
    #[sqlx(json)]
    pub aliases: Vec<String>,
```

所有 Book 的 SELECT 列清单：`file_sha256, created_at` 后、`FROM` 前加 `, category, tags, aliases`。定位方式（不要靠行号，以 grep 为准）：

```bash
grep -n 'file_sha256, created_at' src-tauri/src/
```

预期命中：`service/read.rs` 三处（get_book_orm、list_books 空分支、list_books 搜索分支）、`migration.rs` 一处（fetch_all_books）。逐一修改。

`migration.rs` 导入 INSERT（当前在 `INSERT INTO books (id, title, authors, ... created_at)` 处）扩为：

```rust
        let r = sqlx::query(
            "INSERT INTO books (id, title, authors, language, publisher, description, \
             pub_date, identifier, file_path, file_size, file_sha256, created_at, \
             category, tags, aliases) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
```

绑定处（`created_at` 的 bind 之后）追加：

```rust
                .bind(&book.category)
                .bind(serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".into()))
                .bind(serde_json::to_string(&book.aliases).unwrap_or_else(|_| "[]".into()))
```

`schema.rs` BookDetail（`identifier` 字段后加）：

```rust
    /// 分类（单选，用户自定义；可空）
    pub category: Option<String>,
    /// 标签（多值，用户自定义）
    pub tags: Vec<String>,
    /// 别名（多值，搜索匹配用）
    pub aliases: Vec<String>,
```

`service/read.rs` `book_to_detail` 的 `BookDetail {` 构造里（`identifier:` 后）加：

```rust
            category: book.category.clone(),
            tags: book.tags.clone(),
            aliases: book.aliases.clone(),
```

`src/api/types.ts` BookDetail（`identifier` 后加）：

```ts
  category: string | null;     // 分类（单选，用户自定义），可为空
  tags: string[];              // 标签（多值，用户自定义）
  aliases: string[];           // 别名（多值，搜索匹配用）
```

确认 add_book 无需改（显式列清单 + 新列有 DEFAULT）：

```bash
grep -n 'INSERT INTO books' src-tauri/src/
```

write.rs 的 add_book INSERT 若列清单不含新列 → 不改（依赖 DEFAULT）。

- [ ] **Step 5: 跑全量验证**

```bash
cd src-tauri && cargo fmt && cargo test 2>&1 | grep -E 'test result: (ok|FAILED)' | head -1
```
Expected: **106 passed**（104 + 2 新增），0 failed。

```bash
cd .. && pnpm typecheck && pnpm test 2>&1 | grep -E 'Test Files|Tests '
```
Expected: typecheck 无输出；31 文件 / 189 passed 不回归（Detail 测试的 mock book 对象缺新字段会在 TS 层报错——若有，给测试夹具的 book JSON 补三字段即可，属类型修正不是改断言）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(metadata): books 表加 分类/标签/别名 三列(迁移 0006 + ORM/归档/DTO 全链路)

旧归档兼容靠 serde 缺省:Vec 字段必须显式 #[serde default](Option 自动,
Vec 缺字段会报 missing field),旧格式 books.json 行剔除三字段后照常导入。
BACKUP_VERSION 不升:这是扩展现有行集的字段而非新增行集,老应用读新归档
serde 忽略未知字段、新应用读旧归档走缺省,双向降级都合理;升 v3 反而让
老应用拒收整个备份。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 更新路径（BookUpdate 三态语义）

**Files:**
- Modify: `src-tauri/src/schema.rs:120-135`（BookUpdate）
- Modify: `src-tauri/src/commands.rs:512-534`（BookUpdateCmd + From）与 `has_update` 判空（约 484 行）
- Modify: `src-tauri/src/service/write.rs`（update_book 的 SET 构建，约 396-417 行）
- Test: `src-tauri/src/service/write.rs`（tests 模块追加）

**Interfaces:**
- Consumes: Task 1 的 `Book.category/tags/aliases`。
- Produces: `BookUpdate { tags: Option<Vec<String>>, aliases: Option<Vec<String>>, category: Option<Option<String>> }`；TS 载荷（Task 5 用）：`tags?: string[]`、`aliases?: string[]`、`category?: string | null`（`null`=清空，缺省=不动）。

- [ ] **Step 1: 写失败测试**

`write.rs` tests 模块追加（复用既有 `setup()`/`insert_book()` fixture）：

```rust
    // ---------- 元数据更新:三态语义 ----------

    /// Some(vec) 整体替换;Some(vec![]) 清空;缺字段不动。
    #[tokio::test]
    async fn update_replaces_tags_and_aliases_wholesale() {
        let (svc, _t) = setup().await;
        insert_book(&svc, "b1").await;
        sqlx::query("UPDATE books SET tags = '[\"旧标签\"]', aliases = '[\"旧称\"]' WHERE id = 'b1'")
            .execute(&svc.pool).await.unwrap();

        // 整体替换(不是追加)
        svc.update_book("b1", &crate::schema::BookUpdate {
            tags: Some(vec!["推理".into(), "日系".into()]),
            aliases: Some(vec!["新称".into()]),
            ..Default::default()
        }).await.expect("replace");

        let b = svc.get_book_orm("b1").await.unwrap().unwrap();
        assert_eq!(b.tags, vec!["推理".to_string(), "日系".to_string()]);
        assert_eq!(b.aliases, vec!["新称".to_string()]);
        assert_eq!(b.category, None, "本次没碰 category");

        // 空数组 = 清空
        svc.update_book("b1", &crate::schema::BookUpdate {
            tags: Some(vec![]), aliases: Some(vec![]), ..Default::default()
        }).await.expect("clear");
        let b = svc.get_book_orm("b1").await.unwrap().unwrap();
        assert!(b.tags.is_empty() && b.aliases.is_empty());
    }

    /// category 三态:设置 / 清空(Some(None)) / 不动(None)。
    /// 不用 publisher 的 Option<String>——它区分不了 null 与缺字段,清空实际不生效。
    #[tokio::test]
    async fn update_category_three_states() {
        let (svc, _t) = setup().await;
        insert_book(&svc, "b1").await;
        sqlx::query("UPDATE books SET category = '小说' WHERE id = 'b1'")
            .execute(&svc.pool).await.unwrap();

        svc.update_book("b1", &crate::schema::BookUpdate {
            category: Some(Some("科技".into())), ..Default::default()
        }).await.expect("set");
        assert_eq!(svc.get_book_orm("b1").await.unwrap().unwrap().category.as_deref(), Some("科技"));

        svc.update_book("b1", &crate::schema::BookUpdate {
            category: Some(None), ..Default::default()
        }).await.expect("clear");
        assert_eq!(svc.get_book_orm("b1").await.unwrap().unwrap().category, None);

        // 缺字段 = 不动:category 保持 None 的同时,别的字段更新不牵连它
        svc.update_book("b1", &crate::schema::BookUpdate {
            title: Some("新名".into()), ..Default::default()
        }).await.expect("other field");
        let b = svc.get_book_orm("b1").await.unwrap().unwrap();
        assert_eq!(b.title, "新名");
        assert_eq!(b.category, None);
    }
```

注意：测试用了 `..Default::default()`，需要 `BookUpdate` 派生 `Default`（Step 3 一起加；`Option` 字段的 Default 全是 None）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test update_replaces_tags update_category 2>&1 | tail -5`
Expected: 编译失败（字段不存在 / 未派生 Default）。

- [ ] **Step 3: 实现**

`schema.rs` BookUpdate：派生加 `Default`，字段追加：

```rust
#[derive(Debug, Default, Deserialize)]
pub struct BookUpdate {
    // ……既有字段不动……
    /// 标签（整体替换；Some(vec![]) = 清空；缺字段 = 不动）
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// 别名（整体替换；Some(vec![]) = 清空；缺字段 = 不动）
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    /// 分类（Some(Some) = 设置；Some(None) = 清空；None = 不动）
    #[serde(default)]
    pub category: Option<Option<String>>,
}
```

`service/write.rs` `update_book` 的 SET 构建：值类型改为可空以支持写 NULL——

```rust
        // 值改为 Option<String>:None 绑定为 SQL NULL(category 清空需要;
        /// 既有字段的值全部是 Some,行为不变)
        let mut updates: Vec<(&str, Option<String>)> = Vec::new();

        if let Some(v) = &data.title {
            updates.push(("title", Some(v.clone())));
        }
        // ……其余既有 push 同样包 Some(……)……
```

（逐个既有 `updates.push(("col", v.clone()))` 改为 `updates.push(("col", Some(v.clone())))`；authors 那条是 `Some(serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()))`。）

在 identifier 之后追加三个新字段的处理：

```rust
        if let Some(v) = &data.tags {
            updates.push((
                "tags",
                Some(serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())),
            ));
        }
        if let Some(v) = &data.aliases {
            updates.push((
                "aliases",
                Some(serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())),
            ));
        }
        match &data.category {
            Some(Some(s)) => updates.push(("category", Some(s.clone()))),
            // 清空:绑定为 NULL(不能写字符串 "NULL",那会存字面量)
            Some(None) => updates.push(("category", None)),
            None => {}
        }
```

`commands.rs` `BookUpdateCmd`：同样加 `#[serde(default)]` 三字段（类型同 BookUpdate），`From` 实现透传三行，`has_update` 判空追加 `|| data.tags.is_some() || data.aliases.is_some() || data.category.is_some()`。

- [ ] **Step 4: 跑全量验证**

```bash
cd src-tauri && cargo fmt && cargo test 2>&1 | grep -E 'test result: (ok|FAILED)' | head -1
```
Expected: **108 passed**，0 failed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metadata): 元数据可编辑——tags/aliases 整体替换、category 三态语义

Some(vec![]) = 清空、Option<Option<String>> 区分 null(清空)与缺字段(不动)。
不用 publisher 的 Option<String> 方案:它区分不了两种语义,现有清空实际不生效;
新字段从一开始就避开这个坑(既有字段保持原语义,属另一处待修缺陷,不在本次)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 一体化搜索（五列 OR + LIKE 转义）

**Files:**
- Modify: `src-tauri/src/service/read.rs`（list_books 的非空 q 分支，约 93-112 行）
- Test: `src-tauri/src/service/read.rs`（新增 `#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: Task 1 的三列。
- Produces: `list_books(q, page, size)` 签名不变——**对调用方（commands.rs / 前端）零改动**，行为变更（五列命中）。

- [ ] **Step 1: 写失败测试**

`service/read.rs` 文件末尾新增测试模块（fixture 与 write.rs/prefs.rs 同型）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn setup() -> (BookService, TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(":memory:")
            .expect("sqlite opts").foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1)
            .connect_with(opts).await.expect("connect");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
        (BookService::new(pool, tmp.path().to_path_buf()), tmp)
    }

    async fn seed_book(svc: &BookService, id: &str, title: &str, authors: &str, meta: &str) {
        // meta 形如 "小说|["推理"]|["旧称"]" → category|tags|aliases
        let (cat, tags, aliases) = {
            let mut it = meta.splitn(3, '|');
            let c = it.next().unwrap_or("");
            let t = it.next().unwrap_or("[]");
            let a = it.next().unwrap_or("[]");
            (c, t, a)
        };
        let cat = if cat.is_empty() { "NULL".to_string() } else { format!("'{cat}'") };
        sqlx::query(&format!(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, \
             file_size, file_sha256, created_at, category, tags, aliases) \
             VALUES ('{id}', '{title}', '{authors}', 'zh', '{id}', '{id}.epb', 10, 'sha-{id}', \
             '2024-01-01 00:00:00', {cat}, '{tags}', '{aliases}')"
        )).execute(&svc.pool).await.expect("seed");
    }

    /// 一体化搜索:五列任一命中即返回。
    #[tokio::test]
    async fn search_matches_all_five_columns() {
        let (svc, _t) = setup().await;
        seed_book(&svc, "b1", "白夜行", "[\"东野圭吾\"]", "小说|[\"推理\"]|[\"Byakuya\"]").await;
        seed_book(&svc, "b2", "无关书", "[\"某人\"]", "|[]|[]").await;

        for q in ["白夜行", "东野圭吾", "小说", "推理", "Byakuya"] {
            let (books, total) = svc.list_books(q, 1, 20).await.expect("search");
            assert_eq!(total, 1, "查询 {q} 应恰好命中 b1");
            assert_eq!(books[0].id, "b1", "查询 {q}");
        }
        // 五列都不含 → 不命中
        let (_, total) = svc.list_books("不存在的词", 1, 20).await.expect("miss");
        assert_eq!(total, 0);
    }

    /// LIKE 通配符必须转义:输入 % 或 _ 不会变成「匹配任意」。
    #[tokio::test]
    async fn search_escapes_like_wildcards() {
        let (svc, _t) = setup().await;
        seed_book(&svc, "b1", "100%满意", "[\"甲\"]", "|[]|[]").await;
        seed_book(&svc, "b2", "普通书", "[\"乙\"]", "|[]|[]").await;

        // 输入 % 只命中字面含 % 的书,不会匹配全部
        let (books, total) = svc.list_books("%", 1, 20).await.expect("wildcard");
        assert_eq!(total, 1);
        assert_eq!(books[0].id, "b1");
        // 输入 _ 同理(不会当成单字符通配)
        let (_, total) = svc.list_books("____", 1, 20).await.expect("underscore");
        assert_eq!(total, 0, "没有书名含字面下划线");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test search_matches_all_five search_escapes_like 2>&1 | tail -5`
Expected: `search_matches_all_five` FAIL（「东野圭吾」「小说」「推理」「Byakuya」查不到——现在只搜书名）。

- [ ] **Step 3: 实现**

`service/read.rs` `list_books` 的非空 q 分支整体替换（SELECT 列清单已在 Task 1 含新列）：

```rust
        } else {
            // LIKE 通配符转义(% _ \),与 service/search.rs 的兜底路径同一套规则
            let escaped = q
                .trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            // 一体化搜索:书名/作者/分类/标签/别名五列任一命中。
            // tags/aliases 是 JSON 文本,中文按原文存储,LIKE 直接子串命中。
            // 注意:这是行为变更——此前只搜书名(spec 已确认)。
            let where_clause = "title LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\' \
                 OR category LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' \
                 OR aliases LIKE ? ESCAPE '\\'";
            let total: i64 =
                sqlx::query_scalar(&format!("SELECT COUNT(*) FROM books WHERE {where_clause}"))
                    .bind(&pattern)
                    .bind(&pattern)
                    .bind(&pattern)
                    .bind(&pattern)
                    .bind(&pattern)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(|e| EpubError::FileSystem(format!("COUNT 失败：{e}")))?;
            let books = query_as::<_, Book>(
                "SELECT id, title, authors, language, publisher, description, pub_date, \
                 identifier, file_path, file_size, file_sha256, created_at, \
                 category, tags, aliases \
                 FROM books WHERE {WHERE} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(size)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败：{e}")))?;
            (books, total)
        }
```

注意 `{WHERE}` 占位：SQL 字符串里不能直接内插变量名——实际写法是先 `let sql = format!("SELECT ... FROM books WHERE {where_clause} ORDER BY ...")` 再 `query_as::<_, Book>(&sql)`。实现时按这个来。

- [ ] **Step 4: 跑全量验证**

```bash
cd src-tauri && cargo fmt && cargo test 2>&1 | grep -E 'test result: (ok|FAILED)' | head -1
```
Expected: **110 passed**，0 failed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(search): 书库搜索从只搜书名扩为五列一体化(书名/作者/分类/标签/别名)

LIKE 通配符(% _ \\)转义复用 search.rs 兜底路径的同一套规则,输入 % 不再
变成匹配任意。SearchSheet 与 Library 共用此接口,前端零改动自动受益。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 补全建议命令（list_tag_suggestions）

**Files:**
- Modify: `src-tauri/src/service/read.rs`（新方法）、`src-tauri/src/commands.rs`（命令 + DTO）、`src-tauri/src/lib.rs`（generate_handler 注册）
- Modify: `src/api/client.ts`（fetchTagSuggestions）
- Test: `src-tauri/src/service/read.rs` tests 模块

**Interfaces:**
- Produces: Tauri 命令 `list_tag_suggestions() -> TagSuggestions { categories: Vec<String>, tags: Vec<String> }`；前端 `fetchTagSuggestions(): Promise<TagSuggestions>`（TS 接口 `TagSuggestions { categories: string[]; tags: string[] }`，浏览器分支返回空）。Task 5 的编辑表单消费它。

- [ ] **Step 1: 写失败测试**

`service/read.rs` tests 模块追加：

```rust
    /// 补全建议:全库去重、跳过空串;分类与标签分开返回;别名不做建议。
    #[tokio::test]
    async fn tag_suggestions_dedupe_across_books() {
        let (svc, _t) = setup().await;
        seed_book(&svc, "b1", "甲", "[\"甲\"]", "小说|[\"推理\",\"日系\"]|[]").await;
        seed_book(&svc, "b2", "乙", "[\"乙\"]", "小说|[\"推理\",\"\"]|[]").await;
        // b3 无任何元数据,不应贡献空串
        seed_book(&svc, "b3", "丙", "[\"丙\"]", "|[]|[]").await;

        let (cats, tags) = svc.list_tag_suggestions().await.expect("suggest");
        assert_eq!(cats, vec!["小说".to_string()], "分类去重");
        assert_eq!(tags, vec!["日系".to_string(), "推理".to_string()], "标签去重 + 跳过空串 + 排序");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test tag_suggestions 2>&1 | tail -3`
Expected: 编译失败（方法不存在）。

- [ ] **Step 3: 实现**

`service/read.rs` BookService impl（`list_books` 之后）：

```rust
    /// 全库去重的已有分类/标签,供编辑表单补全。别名不做建议(每本书独特,跨书复用无意义)。
    /// json_each 是 SQLite JSON1 的表值函数;本仓库 bundled 构建已启用 FTS5,
    /// JSON1 同为默认开启,此测试同时就是可用性验证(不可用则改为取列后 Rust 侧去重)。
    pub async fn list_tag_suggestions(&self) -> Result<(Vec<String>, Vec<String>), EpubError> {
        let categories: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT category FROM books \
             WHERE category IS NOT NULL AND category != '' ORDER BY category",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("读取分类建议失败：{e}")))?;

        let tags: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT je.value FROM books, json_each(books.tags) je \
             WHERE je.value != '' ORDER BY je.value",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("读取标签建议失败：{e}")))?;

        Ok((
            categories.into_iter().map(|(c,)| c).collect(),
            tags.into_iter().map(|(t,)| t).collect(),
        ))
    }
```

`commands.rs`（读命令区）：

```rust
/// 补全建议:全库去重的已有分类/标签(编辑表单用)
#[derive(Serialize)]
pub struct TagSuggestions {
    pub categories: Vec<String>,
    pub tags: Vec<String>,
}

/// 已有分类/标签的去重列表(编辑表单补全;别名不做建议)
#[tauri::command]
pub async fn list_tag_suggestions(state: State<'_, AppState>) -> CmdResult<TagSuggestions> {
    let (categories, tags) = state
        .service
        .list_tag_suggestions()
        .await
        .map_err(CmdError::from)?;
    Ok(TagSuggestions { categories, tags })
}
```

`lib.rs` `generate_handler!` 列表加一行 `commands::list_tag_suggestions,`（与 reader_prefs 命令相邻处）。

`src/api/client.ts`（reader_prefs 包装附近）：

```ts
/// 补全建议(与后端 TagSuggestions 镜像)
export interface TagSuggestions {
  categories: string[];
  tags: string[];
}

/// 已有分类/标签的去重列表(编辑表单补全)。
/// 浏览器端无后端,返回空建议——combobox 仍可自由输入(模式同 reader_prefs)。
export async function fetchTagSuggestions(): Promise<TagSuggestions> {
  if (!isTauri) return { categories: [], tags: [] };
  return tauriInvoke<TagSuggestions>('list_tag_suggestions');
}
```

- [ ] **Step 4: 跑全量验证**

```bash
cd src-tauri && cargo fmt && cargo test 2>&1 | grep -E 'test result: (ok|FAILED)' | head -1
```
Expected: **111 passed**（+1；json_each 不可用则此测试红——按注释里的兜底方案改写后再跑）。

```bash
cd .. && pnpm typecheck
```
Expected: 无输出。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metadata): list_tag_suggestions 补全命令(分类/标签全库去重)

编辑表单的 combobox 数据源:自由输入为主,已有值下拉可直接选。别名不做
建议——曾用名/译名每本书独特,跨书复用没有意义。浏览器端无后端,降级
返回空建议,输入不受影响。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 前端——编辑表单与展示

**Files:**
- Modify: `src/pages/Detail.tsx`（metaDraft 约 196-275 行、MetadataEditor 约 1088-1130 行、展示区约 1004 行）
- Test: `src/pages/DetailMetadata.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `BookDetail` 三字段、Task 2 的更新载荷（`tags?: string[]`、`category?: string | null`）、Task 4 的 `fetchTagSuggestions`。

- [ ] **Step 1: 写失败测试**

新建 `src/pages/DetailMetadata.test.tsx`。先看 `Detail.test.tsx` 开头的 mock 方式并照抄其 fetch mock 与渲染 harness（它 mock 了 `fetch` 返回 bookJson/chapters），再覆盖：

```tsx
// 元数据编辑表单:分类/标签/别名的编辑、保存载荷、已有值建议。
// 复用 Detail.test.tsx 的 fetch mock 模式(见该文件开头)。
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// ……照抄 Detail.test.tsx 的 harness(路由 /books/:id、fetch mock、bookJson 夹具)……

// bookJson 夹具在 Detail.test.tsx 基础上补三字段:
//   category: '小说', tags: ['推理'], aliases: ['旧称'],

describe('DetailPage 元数据', () => {
  it('编辑模式渲染三个新字段并回填当前值', async () => {
    render(<DetailHarness initialRoute="/books/b1" />);
    const editBtn = await screen.findByRole('button', { name: '编辑' });
    await userEvent.click(editBtn);
    expect((screen.getByLabelText('分类') as HTMLInputElement).value).toBe('小说');
    expect((screen.getByLabelText('标签') as HTMLInputElement).value).toBe('推理');
    expect((screen.getByLabelText('别名') as HTMLInputElement).value).toBe('旧称');
  });

  it('保存载荷:标签按逗号切分,分类清空提交 null', async () => {
    const calls: unknown[] = [];
    // harness 的 fetch mock 里拦截 PATCH…——但桌面端走 invoke;
    // Detail.test.tsx 既有 mock 怎么断言 update_book 就怎么断言(以其为准,此处语义:
    // 点保存后,提交体含 tags: ['推理','日系'] 且 category 为 null)
    // ……按 Detail.test.tsx 的实际 mock 结构补全……
  });

  it('查看模式展示分类与标签、别名为小字', async () => {
    render(<DetailHarness initialRoute="/books/b1" />);
    await screen.findByText('推理');
    expect(screen.getByText('小说')).toBeInTheDocument();
    expect(screen.getByText('旧称')).toBeInTheDocument();
  });
});
```

> **执行注意**：上面第二、三条测试的 mock 细节（invoke 拦截方式、label 关联写法）必须以 `Detail.test.tsx` 现有结构为准——先读它再补全，不要凭空发明 harness。测试意图如上；断言目标：编辑回填、保存载荷（`tags: ['推理','日系']`、`category: null`）、查看展示。`getByLabelText` 若表单 label 未用 htmlFor 关联，则按 Detail.test.tsx 的取件方式调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/pages/DetailMetadata.test.tsx`
Expected: FAIL（字段不存在）。

- [ ] **Step 3: 实现**

`Detail.tsx`：

1. `metaDraft` 类型与初始化（`enterEditMode`）加三个逗号串字段：

```tsx
  // 元数据编辑草稿（editMode 开启时从 book 初始化）——逗号串与 authors 同型
  // category 为空串时保存提交 null（清空）
  const [metaDraft, setMetaDraft] = useState({
    title: '', authors: '', publisher: '', description: '',
    category: '', tags: '', aliases: '',
  });
```

`enterEditMode` 的 `setMetaDraft({...})` 追加：

```tsx
      category: book.category ?? '',
      tags: book.tags.join(', '),
      aliases: book.aliases.join(', '),
```

2. `saveMetadata` 载荷追加（逗号切分抽小函数，authors 一并复用）：

```tsx
  // 逗号分隔串 → 去空串数组（authors/tags/aliases 共用）
  const splitList = (s: string) =>
    s.split(',').map((t) => t.trim()).filter(Boolean);
```

```tsx
      await updateBook.mutateAsync({
        // ……既有字段不动……
        category: metaDraft.category.trim() || null,
        tags: splitList(metaDraft.tags),
        aliases: splitList(metaDraft.aliases),
      });
```

（authors 原来的内联切分替换为 `splitList(metaDraft.authors)`，行为不变。）

3. 建议数据（编辑时才拉）：

```tsx
  // 补全建议:进编辑模式才拉取,缓存 5 分钟(标签不常变,避免每次开表单都查)
  const { data: suggestions } = useQuery({
    queryKey: ['tag-suggestions'],
    queryFn: fetchTagSuggestions,
    enabled: editMode,
    staleTime: 5 * 60 * 1000,
  });
```

（`useQuery` 与 `fetchTagSuggestions` 补 import；Detail 已在 QueryClientProvider 内——以现有 hooks 的用法为准。）

4. `MetadataEditor`：draft 类型加 `category: string; tags: string; aliases: string;`，props 加 `suggestions?: TagSuggestions`。fields 数组加三项，分类项带 `datalist`：

```tsx
  const fields = [
    { key: 'title', label: '书名', type: 'input' },
    { key: 'authors', label: '作者', type: 'input', placeholder: '多个用逗号分隔' },
    { key: 'category', label: '分类', type: 'input', list: 'meta-cat-list' },
    { key: 'tags', label: '标签', type: 'input', placeholder: '多个用逗号分隔', list: 'meta-tag-list' },
    { key: 'aliases', label: '别名', type: 'input', placeholder: '多个用逗号分隔' },
    { key: 'publisher', label: '出版社', type: 'input' },
    { key: 'description', label: '简介', type: 'textarea' },
  ] as const;
```

input 加 `list` 属性透传；组件底部渲染两个 datalist；标签 input 下方加已有标签 chips（不在当前输入串里的才显示，点击追加）：

```tsx
      {/* 已有分类/标签下拉建议:原生 datalist,零新依赖 */}
      <datalist id="meta-cat-list">
        {(suggestions?.categories ?? []).map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id="meta-tag-list">
        {(suggestions?.tags ?? []).map((t) => <option key={t} value={t} />)}
      </datalist>
```

```tsx
      {/* 标签行下:已有标签快捷追加(当前输入已含的不再显示) */}
      {(() => {
        const current = new Set(splitList(draft.tags));
        const rest = (suggestions?.tags ?? []).filter((t) => !current.has(t));
        if (rest.length === 0) return null;
        return (
          <div className="mt-1 flex flex-wrap gap-1">
            {rest.slice(0, 12).map((t) => (
              <button key={t} type="button"
                onClick={() => onChange('tags', draft.tags.trim() ? `${draft.tags}, ${t}` : t)}
                className="rounded-full border border-gold-400/25 px-2 py-0.5 text-xs text-cream-muted hover:border-gold-400/60 hover:text-cream">
                + {t}
              </button>
            ))}
          </div>
        );
      })()}
```

（`splitList` 提到模块级导出供 MetadataEditor 用；chips 块放在 fields.map 之外、datalist 之前，或包进 fields 循环的 tags 分支——实现时取更贴合现有结构的写法。）

5. 查看模式展示：找到展示作者/出版社的元信息区（约 1004 行 `book.authors.join(', ')` 处），其后追加：

```tsx
      {/* 用户元数据:分类/标签 chips + 别名小字 */}
      {(book.category || book.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {book.category && (
            <span className="rounded-full bg-gold-400/15 px-2 py-0.5 text-xs text-gold-200">
              {book.category}
            </span>
          )}
          {book.tags.map((t) => (
            <span key={t} className="rounded-full border border-shell-line px-2 py-0.5 text-xs text-cream-muted">
              {t}
            </span>
          ))}
        </div>
      )}
      {book.aliases.length > 0 && (
        <p className="text-xs text-cream-faint">别名:{book.aliases.join(' / ')}</p>
      )}
```

（具体 className 以该区域现有写法为准，保持一致即可。）

6. 既有测试夹具修正：全仓 grep 测试里的 book 夹具（`Detail.test.tsx`、`DetailCoverDelete.test.tsx`、`DetailDescription.test.tsx`、`DetailSearch*.test.tsx`、`Reader*.test.tsx`、`ExportDialog*.test.tsx`、`MigrationDialog.test.tsx` 等 mock bookJson 的地方），缺三字段的补 `category: null, tags: [], aliases: []`。这是类型修正，不是改断言。

- [ ] **Step 4: 跑全量验证**

```bash
pnpm typecheck && pnpm test 2>&1 | grep -E 'Test Files|Tests '
```
Expected: typecheck 无输出；测试数 = 189 + 3（新文件三条）= **192 passed**（夹具补字段后既有用例不回归）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(metadata): 详情页元数据编辑(分类/标签/别名)与展示

标签/别名沿用 authors 的逗号分隔输入(零新组件);分类与标签接原生
datalist 下拉已有值,标签行下另有 chips 快捷追加。jsdom 下 isTauri=false,
fetchTagSuggestions 自动降级为空建议,无需 mock。保存载荷:空分类提交
null(清空),标签数组空即清空——与后端三态语义一一对应。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 文档同步 + 全量验证 + 提交

**Files:**
- Modify: `README.md`、`src-tauri/AGENTS.md`、`AGENTS.md`

**Interfaces:** 无代码。此任务产出的基线数字写入根 AGENTS.md §28.5。

- [ ] **Step 1: README 同步（对照 spec §6）**

1. 特性列表加一条（放「📖 书籍库管理」之后）：

```markdown
- **🏷️ 书籍元数据** — 每本书可设置分类(单选)/标签(多值)/别名(多值),详情页编辑:自由输入 + 已有分类/标签下拉建议(新值直接创建);**搜索一体化**——书名/作者/分类/标签/别名任一命中即返回(LIKE 通配符已转义);删除书籍时元数据随书行一并消失,随 `.epublib` 备份带走(books 行集自带,无需升归档版本)
```

2. 「🔎 全文搜索」条目或书库条目中涉及「搜索」的措辞核对——凡写「搜书名」处改为五列一体化（以实际 README 文字为准，grep `搜索`逐处核对）。
3. 命令表加一行：

```markdown
| `list_tag_suggestions` | —(桌面端新功能) | 已有分类/标签去重列表(编辑表单补全) |
```

4. 「书库迁移/备份」条目的括号内补「书目(含分类/标签/别名)」。
5. 项目结构树 migrations 段加 `│  │  └─ 0006_book_metadata.sql   分类/标签/别名三列`（注意上一行 `0005` 的 `└─` 改 `├─`）。

- [ ] **Step 2: AGENTS 同步**

`src-tauri/AGENTS.md` §5 迁移清单加 `0006_book_metadata.sql`；
根 `AGENTS.md` §28.5 基线数字改为本次实测值（Rust / 前端以 Step 3 输出为准）。

- [ ] **Step 3: 全量验证（真实数字写进报告）**

```bash
cd src-tauri && cargo test 2>&1 | grep -E 'test result: (ok|FAILED)' | head -1
cd src-tauri && cargo clippy --all-targets -- -A clippy::manual_is_multiple_of 2>&1 | grep -cE '^error' || true
cd .. && pnpm typecheck && pnpm test 2>&1 | grep -E 'Test Files|Tests ' && pnpm build 2>&1 | grep -E 'built in|error'
git -c core.whitespace=cr-at-eol diff --check && git diff --stat
```

Expected: Rust 全绿（111+）；clippy 除放行项外 0 error；前端全绿（31 文件/192+）；typecheck 无输出；build 成功；diff 无真实空白问题、无调试残留（`git diff -U0 | grep '^[+]' | grep -E 'println!|dbg!|console\.log'` 为空）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: 同步书籍元数据功能(README 特性/命令表/备份/结构 + AGENTS 基线)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review 记录

1. **Spec 覆盖**：spec §1 数据模型→Task 1；§2 后端(模型/更新/搜索/建议/注册)→Task 1/2/3/4；§3 备份不升版→Task 1（测试锁双向兼容）；§4 前端→Task 5；§5 测试→各任务 + Task 6 回归；§6 文档→Task 6。无缺口。
2. **修正 spec 一处**：`Vec<String>` 缺字段 serde 报错，需显式 `#[serde(default)]`（spec 原表述不准，计划 Task 1 已按正确写法并配测试）。
3. **类型一致性**：`Book`/`BookDetail`/TS 三处字段同名同序（category/tags/aliases）；`BookUpdate` 与 `BookUpdateCmd` 类型一致；`list_tag_suggestions` 命令名在 service/commands/lib.rs/client.ts 四处一致。
