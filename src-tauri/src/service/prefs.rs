// 阅读状态存储：reader_prefs 表的读写。
// 键名沿用前端 localStorage 的 epub_reader:* 形态，值原样存字符串(复杂值为 JSON)。
// 单表镜像 localStorage，是为了让 .epublib 备份能带上阅读进度与偏好——
// 它们此前只存在 webview 的 localStorage 里，换电脑就丢。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::query_as;
use std::collections::{HashMap, HashSet};

use crate::epub::EpubError;

use super::BookService;

/// reader_prefs 的一行
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PrefRow {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

/// 删除书籍时一并清理的键前缀，与前端 readerPrefs.ts 的 key 命名一一对应
const BOOK_KEY_PREFIXES: [&str; 4] = [
    "epub_reader:progress:",
    "epub_reader:progressPaged:",
    "epub_reader:lastRead:",
    "epub_reader:status:",
];

/// 时间戳的**规范格式**：`YYYY-MM-DDTHH:MM:SS.sssZ`(毫秒精度、UTC、Z 后缀)。
///
/// 为什么必须统一：导入时「取较新」是在 SQL 里用 `excluded.updated_at > reader_prefs.updated_at`
/// 做**字符串比较**的。这只在格式定长且后缀一致时才等价于时间比较——
/// chrono 默认的 `to_rfc3339()` 产出 `...+00:00`，而 JS 的 `toISOString()` 产出 `...Z`，
/// 两者混存时 `Z`(0x5A) > `+`(0x2B)，同一时刻会被判成前者更大。
/// 前后端一律用这个格式(JS 侧对应 `new Date().toISOString()`)。
fn now_stamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl BookService {
    /// 全量读取。前端启动时一次性拉走载入内存缓存。
    pub async fn list_reader_prefs(&self) -> Result<Vec<PrefRow>, EpubError> {
        query_as::<_, PrefRow>("SELECT key, value, updated_at FROM reader_prefs")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("读取阅读状态失败：{e}")))
    }

    /// upsert 单键并刷新时间戳(时间戳由后端生成，避免依赖前端时钟)。
    pub async fn set_reader_pref(&self, key: &str, value: &str) -> Result<(), EpubError> {
        sqlx::query(
            "INSERT INTO reader_prefs (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET \
             value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(now_stamp())
        .execute(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("写入阅读状态失败：{e}")))?;
        Ok(())
    }

    /// 删除单键(幂等：键不存在时静默成功)。
    pub async fn remove_reader_pref(&self, key: &str) -> Result<(), EpubError> {
        sqlx::query("DELETE FROM reader_prefs WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("删除阅读状态失败：{e}")))?;
        Ok(())
    }

    /// 批量导入(备份恢复)：**逐键比较 updated_at，取较新**。
    /// `WHERE excluded.updated_at > reader_prefs.updated_at` 是这里的核心——
    /// 它让同一套逻辑同时满足「新电脑恢复」与「合并两台设备的书库」两种场景。
    /// 返回实际写入(新增或更新)的条目数，被判定为更旧的条目不计入。
    pub async fn import_reader_prefs(&self, items: Vec<PrefRow>) -> Result<usize, EpubError> {
        let mut written = 0usize;
        for item in items {
            let res = sqlx::query(
                "INSERT INTO reader_prefs (key, value, updated_at) VALUES (?, ?, ?) \
                 ON CONFLICT(key) DO UPDATE SET \
                 value = excluded.value, updated_at = excluded.updated_at \
                 WHERE excluded.updated_at > reader_prefs.updated_at",
            )
            .bind(&item.key)
            .bind(&item.value)
            .bind(&item.updated_at)
            .execute(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("导入阅读状态失败：{e}")))?;
            written += res.rows_affected() as usize;
        }
        Ok(written)
    }

    /// 删除某本书的全部阅读状态(删书时调用)。返回删除行数。
    ///
    /// 用**精确键名**逐前缀匹配，不用 `LIKE 'epub_reader:%' || book_id`——
    /// book_id 位于键尾，`'%c'` 会误伤 `epub_reader:progress:abc`。
    pub async fn delete_reader_prefs_for_book(&self, book_id: &str) -> Result<u64, EpubError> {
        let mut total = 0u64;
        for prefix in BOOK_KEY_PREFIXES {
            let res = sqlx::query("DELETE FROM reader_prefs WHERE key = ?")
                .bind(format!("{prefix}{book_id}"))
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("清理阅读状态失败：{e}")))?;
            total += res.rows_affected();
        }
        Ok(total)
    }
}

/// 把归档里的每书键改写到**本机**的键空间,并丢弃无主的每书键。
///
/// 为什么必须改写:book_id 是各机导入时生成的 `Uuid::new_v4()`,所以
/// 「两台设备各自导入同一本 EPUB」得到的是**不同 id、相同 SHA**。归档侧那本
/// 会被 SHA 判重跳过,但它的阅读状态是按**归档侧 id** 命名的——不改写就
/// 两头落空:本机那本书的键仍是空的(进度没恢复),同时多出一个指向不存在
/// 书籍的孤儿行(它清不掉,还会随之后每次导出继续传播)。
///
/// - `remap`:归档 book_id → 本机 book_id,只含被判重跳过的那些书
/// - `local_books`:导入结束后本机实际存在的全部 book_id
///
/// 每书键的目标 id 不在 `local_books` 里 → 丢弃(无主残键不进本机库)。
/// 非每书键(字号/主题/阅读时长等全局偏好)与书无关,原样放行。
pub fn remap_pref_keys_for_import(
    items: Vec<PrefRow>,
    remap: &HashMap<String, String>,
    local_books: &HashSet<String>,
) -> Vec<PrefRow> {
    items
        .into_iter()
        .filter_map(|mut row| {
            let Some(prefix) = BOOK_KEY_PREFIXES.iter().find(|p| row.key.starts_with(**p))
            else {
                return Some(row); // 全局键
            };
            let archived_id = &row.key[prefix.len()..];
            let local_id = remap.get(archived_id).map(String::as_str).unwrap_or(archived_id);
            if !local_books.contains(local_id) {
                return None; // 无主:归档和本机都没有这本书
            }
            if local_id != archived_id {
                row.key = format!("{prefix}{local_id}");
            }
            Some(row)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::service::BookService;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// 标准 fixture：in-memory SQLite(已跑迁移) + 临时 storage 目录
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

    const K_FONT: &str = "epub_reader:fontSize:global";

    /// 写进去能原样读出来
    #[tokio::test]
    async fn set_then_list_roundtrip() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "22").await.expect("set");

        let rows = svc.list_reader_prefs().await.expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, K_FONT);
        assert_eq!(rows[0].value, "22");
        assert!(!rows[0].updated_at.is_empty(), "updated_at 应被填充");
    }

    /// 同键重复写入 → 覆盖值并刷新时间戳
    #[tokio::test]
    async fn set_overwrites_and_refreshes_timestamp() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "18").await.expect("set 1");
        let first = svc.list_reader_prefs().await.expect("list")[0].updated_at.clone();

        svc.set_reader_pref(K_FONT, "24").await.expect("set 2");
        let rows = svc.list_reader_prefs().await.expect("list");

        assert_eq!(rows.len(), 1, "同键不应产生两行");
        assert_eq!(rows[0].value, "24");
        assert!(rows[0].updated_at >= first, "时间戳不应回退");
    }

    /// 删除键
    #[tokio::test]
    async fn remove_deletes_key() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "22").await.expect("set");

        svc.remove_reader_pref(K_FONT).await.expect("remove");

        assert!(svc.list_reader_prefs().await.expect("list").is_empty());
    }

    /// 删除不存在的键不报错(幂等)
    #[tokio::test]
    async fn remove_missing_key_is_noop() {
        let (svc, _tmp) = setup().await;
        svc.remove_reader_pref("epub_reader:never-existed")
            .await
            .expect("remove 应幂等");
    }

    /// 生成的 updated_at 必须是指定的规范格式(定长 + Z 后缀)。
    /// 「取较新」依赖字符串比较，格式漂移会**静默**破坏排序——
    /// 所以这条测试是刻意的格式锁，不是凑数。
    #[tokio::test]
    async fn timestamp_uses_canonical_format() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "22").await.expect("set");
        let ts = svc.list_reader_prefs().await.expect("list")[0].updated_at.clone();

        assert_eq!(ts.len(), 24, "应为 YYYY-MM-DDTHH:MM:SS.sssZ(定长 24)，实际：{ts}");
        assert!(ts.ends_with('Z'), "必须用 Z 后缀而非 +00:00，否则与 JS toISOString() 无法比较：{ts}");
        assert_eq!(&ts[19..20], ".", "第 20 位应是毫秒小数点：{ts}");
    }

    /// 后端生成的时间戳，字符串序必须与时间序一致。
    #[tokio::test]
    async fn timestamps_are_lexicographically_ordered() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "18").await.expect("set 1");
        let older = svc.list_reader_prefs().await.expect("list")[0].updated_at.clone();

        // 格式是毫秒精度，睡够一毫秒以上才能保证时间戳不同
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;

        svc.set_reader_pref(K_FONT, "24").await.expect("set 2");
        let newer = svc.list_reader_prefs().await.expect("list")[0].updated_at.clone();

        assert!(newer > older, "字符串比较结果应与时间顺序一致：{older} → {newer}");
    }

    // ---------- 导入合并：逐键取较新 ----------

    fn row(key: &str, value: &str, updated_at: &str) -> super::PrefRow {
        super::PrefRow {
            key: key.to_string(),
            value: value.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    /// 备份里的更新 → 用备份的值
    #[tokio::test]
    async fn import_keeps_newer_backup_value() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "本地旧")
            .await
            .expect("seed local");

        let written = svc
            .import_reader_prefs(vec![row(K_FONT, "备份新", "2999-01-01T00:00:00.000Z")])
            .await
            .expect("import");

        assert_eq!(written, 1, "更新的条目应被写入");
        let rows = svc.list_reader_prefs().await.expect("list");
        assert_eq!(rows[0].value, "备份新");
    }

    /// 备份里的更旧 → 保留本地，不覆盖
    #[tokio::test]
    async fn import_ignores_older_backup_value() {
        let (svc, _tmp) = setup().await;
        svc.set_reader_pref(K_FONT, "本地新")
            .await
            .expect("seed local");

        let written = svc
            .import_reader_prefs(vec![row(K_FONT, "备份旧", "2000-01-01T00:00:00.000Z")])
            .await
            .expect("import");

        assert_eq!(written, 0, "更旧的条目不应写入");
        let rows = svc.list_reader_prefs().await.expect("list");
        assert_eq!(rows[0].value, "本地新", "本地较新值必须保留");
    }

    /// 本地没有该键 → 直接插入
    #[tokio::test]
    async fn import_inserts_missing_key() {
        let (svc, _tmp) = setup().await;

        let written = svc
            .import_reader_prefs(vec![row(K_FONT, "22", "2026-01-01T00:00:00.000Z")])
            .await
            .expect("import");

        assert_eq!(written, 1);
        assert_eq!(svc.list_reader_prefs().await.expect("list")[0].value, "22");
    }

    // ---------- 按书清理 ----------

    /// 删书只清该书自己的键，且不误伤「book_id 是别的键后缀」的情况
    #[tokio::test]
    async fn delete_for_book_removes_only_that_books_keys() {
        let (svc, _tmp) = setup().await;
        // 目标书 id 为 "c"；另造一本 id 为 "abc" 的书，其键以 "c" 结尾
        svc.set_reader_pref("epub_reader:progress:c", "{\"ch1\":10}")
            .await
            .expect("set");
        svc.set_reader_pref("epub_reader:progressPaged:c", "{}")
            .await
            .expect("set");
        svc.set_reader_pref("epub_reader:lastRead:c", "ch1")
            .await
            .expect("set");
        svc.set_reader_pref("epub_reader:status:c", "reading")
            .await
            .expect("set");
        svc.set_reader_pref("epub_reader:progress:abc", "{\"ch9\":90}")
            .await
            .expect("set");
        svc.set_reader_pref(K_FONT, "22").await.expect("set");

        let deleted = svc.delete_reader_prefs_for_book("c").await.expect("delete");

        assert_eq!(deleted, 4, "应恰好删掉该书的 4 个键");
        let keys: Vec<String> = svc
            .list_reader_prefs()
            .await
            .expect("list")
            .into_iter()
            .map(|r| r.key)
            .collect();
        assert!(
            keys.contains(&"epub_reader:progress:abc".to_string()),
            "book_id 为 abc 的书不能被误删(其键恰好以 c 结尾)"
        );
        assert!(keys.contains(&K_FONT.to_string()), "全局偏好不能被误删");
    }
}
