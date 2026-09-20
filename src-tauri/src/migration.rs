// 书库迁移:两台设备之间的数据搬运(导出归档 / 导入合并)。
//
// 归档格式(.epublib,实为 zip):
//   manifest.json      — 格式标识/版本/导出时间/书数
//   books.json         — books 表全量行(结构体序列化)
//   chapters.json      — chapters 表全量行
//   assets.json        — assets 表全量行
//   reader_prefs.json  — reader_prefs 表全量行(v2 新增;v1 归档无此项)
//   storage/...        — 存储目录原样(书籍源文件/chapters/*/html/covers)
//
// 不嵌入 SQLite 快照文件:JSON 行集跨版本更稳(避免 VACUUM INTO 在
// 部分构建下静默无效的问题),导入端按结构体字段读,缺列容错。
//
// 导入语义(merge,适配"两台电脑同时在用"):
//   - 目标机已有同 id 或同 SHA-256 的书 → 跳过(skipped)
//   - 否则:落盘该书相关文件(源文件 + 章节 html + 上传封面)并整书入库
//   - FTS 索引由 chapters 的 AFTER INSERT 触发器自动重建
//   - 资源字节不入归档:非 COS 模式直接从 .epb 源文件读;
//     COS 模式共用同一 bucket 时对象天然共享,读不到时
//     read_asset_bytes 自带本地 .epb 回退
//
// 进度回调 (current, total, phase):
//   导出: "packing"(已写字节/估算总字节)
//   导入: "extracting"(已解条目/总条目) → "importing"(已处理书/总书)

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::core_db::{Asset, Book, Chapter};
use crate::epub::EpubError;
use crate::service::{remap_pref_keys_for_import, BookService, PrefRow};

/// 归档格式标识与版本。导入时校验,防止误吃无关 zip。
///
/// v1 → v2:新增 `reader_prefs.json`(阅读状态随备份走)。
/// 导入端对 v1 归档保持兼容——缺该行集时跳过 prefs,其余照常导入。
const BACKUP_FORMAT: &str = "epub-library-backup";
const BACKUP_VERSION: i64 = 2;

type ProgressFn = Arc<dyn Fn(usize, usize, &str) + Send + Sync>;

#[derive(Serialize)]
struct Manifest {
    format: &'static str,
    version: i64,
    created_at: String,
    book_count: i64,
    app_version: &'static str,
}

#[derive(Deserialize)]
struct ManifestRead {
    format: String,
    version: i64,
}

/// 导出结果摘要
#[derive(Serialize, Debug)]
pub struct ExportSummary {
    pub path: String,
    pub book_count: i64,
    pub total_bytes: u64,
}

/// 导入结果摘要
#[derive(Serialize, Debug, Default)]
pub struct ImportSummary {
    pub added: i64,
    pub skipped: i64,
    pub total: i64,
}

fn err(msg: impl Into<String>) -> EpubError {
    EpubError::FileSystem(msg.into())
}

async fn fetch_all_books(pool: &sqlx::SqlitePool) -> Result<Vec<Book>, EpubError> {
    sqlx::query_as(
        "SELECT id, title, authors, language, publisher, description, pub_date, \
         identifier, file_path, file_size, file_sha256, created_at FROM books",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| err(format!("读取书籍失败:{e}")))
}

async fn fetch_all_chapters(pool: &sqlx::SqlitePool) -> Result<Vec<Chapter>, EpubError> {
    sqlx::query_as(
        "SELECT id, book_id, title, spine_order, href, text, word_count FROM chapters",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| err(format!("读取章节失败:{e}")))
}

async fn fetch_all_assets(pool: &sqlx::SqlitePool) -> Result<Vec<Asset>, EpubError> {
    sqlx::query_as("SELECT id, book_id, href, media_type, size, is_cover FROM assets")
        .fetch_all(pool)
        .await
        .map_err(|e| err(format!("读取资源失败:{e}")))
}

// ==================== 导出 ====================

/// 把整库导出为 .epublib 归档。
pub async fn export_library(
    svc: &BookService,
    dest: &Path,
    on_progress: ProgressFn,
) -> Result<ExportSummary, EpubError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("创建导出目录失败:{e}")))?;
    }

    // 1. 读全量行 + 存储文件清单
    let books = fetch_all_books(&svc.pool).await?;
    let chapters = fetch_all_chapters(&svc.pool).await?;
    let assets = fetch_all_assets(&svc.pool).await?;
    // 阅读状态(全局偏好 + 每本书的进度/最近章节):复用 service 的全表读,
    // 不另写一份 SELECT —— 它与 books/chapters/assets 不同,service 侧本就有全表语义的方法。
    let prefs = svc.list_reader_prefs().await?;

    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    collect_files(&svc.storage_dir, &mut files)
        .map_err(|e| err(format!("扫描存储目录失败:{e}")))?;

    let manifest = Manifest {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        created_at: Utc::now().to_rfc3339(),
        book_count: books.len() as i64,
        app_version: env!("CARGO_PKG_VERSION"),
    };

    // 2. 打包(阻塞线程;Path 引用非 'static,先转 owned)
    let dest = dest.to_path_buf();
    let dest_display = dest.display().to_string();
    let storage_dir = svc.storage_dir.clone();
    let book_count = books.len() as i64;

    let written = tokio::task::spawn_blocking(move || {
        pack_archive(
            &dest,
            &storage_dir,
            &files,
            &manifest,
            &books,
            &chapters,
            &assets,
            &prefs,
            &on_progress,
        )
    })
    .await
    .map_err(|e| err(format!("打包任务失败:{e}")))??;

    Ok(ExportSummary { path: dest_display, book_count, total_bytes: written })
}

/// 收集 dir 下全部文件的 (绝对路径, 大小)。
fn collect_files(dir: &Path, out: &mut Vec<(PathBuf, u64)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((path, size));
        }
    }
    Ok(())
}

/// 归档里写一个 JSON 条目,返回写入字节数。
fn json_entry<W: Write + Seek>(
    zw: &mut ZipWriter<W>,
    name: &str,
    v: &impl Serialize,
    deflated: SimpleFileOptions,
) -> Result<u64, EpubError> {
    let bytes = serde_json::to_vec(v).map_err(|e| err(format!("序列化 {name} 失败:{e}")))?;
    zw.start_file(name, deflated)
        .map_err(|e| err(format!("写 {name} 失败:{e}")))?;
    zw.write_all(&bytes).map_err(|e| err(format!("写 {name} 失败:{e}")))?;
    Ok(bytes.len() as u64)
}

/// 写归档:manifest + 行集 JSON + storage/**(进度按累计写入字节节流回调)。
#[allow(clippy::too_many_arguments)]
fn pack_archive(
    dest: &Path,
    storage_dir: &Path,
    files: &[(PathBuf, u64)],
    manifest: &Manifest,
    books: &[Book],
    chapters: &[Chapter],
    assets: &[Asset],
    prefs: &[PrefRow],
    progress: &ProgressFn,
) -> Result<u64, EpubError> {
    // 先写同目录临时文件,全部成功后再 rename 到 dest。
    // 直接 File::create(dest) 会立刻截断用户上一次的备份:中途失败(磁盘满/
    // 进程被杀)就把旧备份毁成半截,而本次内容也不完整。
    let tmp_dest = dest.with_file_name(format!(
        ".packing_{}.epublib",
        uuid::Uuid::new_v4().simple()
    ));
    let file =
        std::fs::File::create(&tmp_dest).map_err(|e| err(format!("创建归档失败:{e}")))?;
    let mut zw = ZipWriter::new(file);
    let deflated = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let files_bytes: u64 = files.iter().map(|(_, s)| *s).sum();
    let total = files_bytes + 1024 * 1024; // JSON 部分按 1MB 估算(仅作进度分母)
    let mut written: u64 = 0;

    written += json_entry(&mut zw, "manifest.json", manifest, deflated)?;
    written += json_entry(&mut zw, "books.json", &books, deflated)?;
    written += json_entry(&mut zw, "chapters.json", &chapters, deflated)?;
    written += json_entry(&mut zw, "assets.json", &assets, deflated)?;
    written += json_entry(&mut zw, "reader_prefs.json", &prefs, deflated)?;
    progress(written.min(total) as usize, total as usize, "packing");

    // storage/**(归档名 = storage/ + 相对路径,统一 / 分隔)
    for (path, _) in files {
        let rel = path
            .strip_prefix(storage_dir)
            .map_err(|e| err(format!("相对路径失败:{e}")))?;
        let name = format!("storage/{}", rel.to_string_lossy().replace('\\', "/"));
        zw.start_file(name, deflated)
            .map_err(|e| err(format!("写入归档失败:{e}")))?;
        let mut f = std::fs::File::open(path).map_err(|e| err(format!("打开文件失败:{e}")))?;
        // 流式拷贝:64KB 块,边写边报进度
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| err(format!("读文件失败:{e}")))?;
            if n == 0 {
                break;
            }
            zw.write_all(&buf[..n])
                .map_err(|e| err(format!("写入归档失败:{e}")))?;
            written += n as u64;
            progress((written + 1024 * 1024).min(total) as usize, total as usize, "packing");
        }
    }

    zw.finish().map_err(|e| err(format!("收尾归档失败:{e}")))?;
    // 落定:rename 是原子的,失败时清掉临时文件,不留下垃圾
    std::fs::rename(&tmp_dest, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_dest);
        err(format!("落定归档失败:{e}"))
    })?;
    Ok(written)
}

// ==================== 导入 ====================

/// 从 .epublib 归档导入(合并)到当前书库。
pub async fn import_library(
    svc: &BookService,
    archive: &Path,
    on_progress: ProgressFn,
) -> Result<ImportSummary, EpubError> {
    if !archive.exists() {
        return Err(err(format!("归档不存在:{}", archive.display())));
    }

    // 1. 解包到临时目录(阻塞线程):校验 manifest + 行集 JSON + storage/**
    let tmp = tempfile::tempdir().map_err(|e| err(format!("临时目录失败:{e}")))?;
    let tmp_path = tmp.path().to_path_buf();
    let archive = archive.to_path_buf();
    let progress = on_progress.clone();
    let (books, chapters, assets, prefs) = tokio::task::spawn_blocking(move || {
        extract_archive(&archive, &tmp_path, &progress)
    })
    .await
    .map_err(|e| err(format!("解包任务失败:{e}")))??;

    // 2. 按书分组
    let chapters_by_book: HashMap<String, Vec<&Chapter>> = {
        let mut m: HashMap<String, Vec<&Chapter>> = HashMap::new();
        for c in &chapters {
            m.entry(c.book_id.clone()).or_default().push(c);
        }
        m
    };
    let assets_by_book: HashMap<String, Vec<&Asset>> = {
        let mut m: HashMap<String, Vec<&Asset>> = HashMap::new();
        for a in &assets {
            m.entry(a.book_id.clone()).or_default().push(a);
        }
        m
    };

    // 3. 逐书合并:已存在(同 id 或同 SHA)跳过;否则搬文件 + 入库
    let tmp_storage = tmp.path().join("storage");
    let total = books.len();
    let mut summary = ImportSummary { total: total as i64, ..Default::default() };

    // 归档 book_id → 本机 book_id,只登记「被 SHA 判重跳过」的书:它们的 id 不同,
    // 阅读状态必须改挂到本机 id 上,否则进度恢复不了、还会留下清不掉的孤儿行。
    let mut id_remap: HashMap<String, String> = HashMap::new();
    // 导入结束后本机实际存在的全部 book_id,用于丢弃无主的每书键
    let mut local_book_ids: HashSet<String> = HashSet::new();

    for (i, book) in books.iter().enumerate() {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT id FROM books WHERE id = ? OR file_sha256 = ?")
                .bind(&book.id)
                .bind(&book.file_sha256)
                .fetch_optional(&svc.pool)
                .await
                .map_err(|e| err(format!("查重失败:{e}")))?;

        if let Some((local_id,)) = exists {
            // id 不同而 SHA 相同 = 两台设备各自导入过同一本书。记下映射,
            // 好把归档侧那本书的阅读状态改挂到本机这本书上。
            if local_id != book.id {
                id_remap.insert(book.id.clone(), local_id.clone());
            }
            local_book_ids.insert(local_id);
            summary.skipped += 1;
            on_progress(i + 1, total, "importing");
            continue;
        }

        // 3a. 搬运该书文件(源文件 + 章节 html 目录 + 上传封面)
        move_book_files(svc, &tmp_storage, book, assets_by_book.get(&book.id))?;

        // 3b. 入库(单书事务;FTS 触发器随 INSERT 自动建索引)
        let mut tx = svc
            .pool
            .begin()
            .await
            .map_err(|e| err(format!("开启事务失败:{e}")))?;

        let authors_json =
            serde_json::to_string(&book.authors).unwrap_or_else(|_| "[]".into());
        let r = sqlx::query(
            "INSERT INTO books (id, title, authors, language, publisher, description, \
             pub_date, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&book.id)
        .bind(&book.title)
        .bind(&authors_json)
        .bind(&book.language)
        .bind(&book.publisher)
        .bind(&book.description)
        .bind(book.pub_date)
        .bind(&book.identifier)
        .bind(&book.file_path)
        .bind(book.file_size)
        .bind(&book.file_sha256)
        .bind(book.created_at)
        .execute(&mut *tx)
        .await;
        if let Err(e) = r {
            let _ = tx.rollback().await;
            return Err(err(format!("INSERT book 失败:{e}")));
        }

        if let Some(chs) = chapters_by_book.get(&book.id) {
            for c in chs {
                let r = sqlx::query(
                    "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&c.id)
                .bind(&c.book_id)
                .bind(&c.title)
                .bind(c.spine_order)
                .bind(&c.href)
                .bind(&c.text)
                .bind(c.word_count)
                .execute(&mut *tx)
                .await;
                if let Err(e) = r {
                    let _ = tx.rollback().await;
                    return Err(err(format!("INSERT chapter 失败:{e}")));
                }
            }
        }

        if let Some(ass) = assets_by_book.get(&book.id) {
            for a in ass {
                let is_cover: i64 = if a.is_cover_bool() { 1 } else { 0 };
                let r = sqlx::query(
                    "INSERT INTO assets (id, book_id, href, media_type, size, is_cover) \
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(&a.id)
                .bind(&a.book_id)
                .bind(&a.href)
                .bind(&a.media_type)
                .bind(a.size)
                .bind(is_cover)
                .execute(&mut *tx)
                .await;
                if let Err(e) = r {
                    let _ = tx.rollback().await;
                    return Err(err(format!("INSERT asset 失败:{e}")));
                }
            }
        }

        tx.commit()
            .await
            .map_err(|e| err(format!("提交事务失败:{e}")))?;

        local_book_ids.insert(book.id.clone());
        summary.added += 1;
        on_progress(i + 1, total, "importing");
    }

    // 4. 合并阅读状态。与书本身的「已存在则跳过」不同:进度是**逐键独立**的,
    //    两台设备的书库合并时应当每个键各取较新的那个,而不是整本跳过——
    //    service 侧的 upsert 用 `excluded.updated_at > reader_prefs.updated_at` 实现。
    //    归档没有该行集(v1)时 prefs 为 None,跳过且不报错。
    //
    //    先按本机键空间改写:同一本书在两台设备上 id 不同,归档侧的进度键必须
    //    改挂到本机 id;无主的每书残键则丢弃,否则会留下清不掉的孤儿行。
    if let Some(prefs) = prefs {
        let prefs = remap_pref_keys_for_import(prefs, &id_remap, &local_book_ids);
        // 失败只 warn 不报错:书已全部入库,阅读状态是附加层。与上面「缺行集不报错」
        // 同一原则——不让附属数据废掉整次书库恢复(§10 尽力而为需显式吞异常并写明理由)。
        match svc.import_reader_prefs(prefs).await {
            Ok(written) => tracing::info!(
                "导入阅读状态 {written} 条(逐键取较新,被判定为更旧的条目未覆盖)"
            ),
            Err(e) => tracing::warn!(
                "合并阅读状态失败: {e}（书已全部导入,仅阅读状态未恢复）"
            ),
        }
    }

    Ok(summary)
}

/// 解包结果。`prefs` 为 `None` 表示归档里没有该行集(v1 归档),不是错误。
type ArchiveRows = (Vec<Book>, Vec<Chapter>, Vec<Asset>, Option<Vec<PrefRow>>);

/// 解包归档:校验 manifest,行集 JSON 解析,storage/** 落临时目录。
fn extract_archive(
    archive: &Path,
    tmp: &Path,
    progress: &ProgressFn,
) -> Result<ArchiveRows, EpubError> {
    let file = std::fs::File::open(archive).map_err(|e| err(format!("打开归档失败:{e}")))?;
    let mut zr = zip::ZipArchive::new(file).map_err(|e| err(format!("读取归档失败:{e}")))?;

    // 先解 manifest 并校验(单独作用域尽早释放借用)
    let manifest: ManifestRead = {
        let mut m = zr
            .by_name("manifest.json")
            .map_err(|_| err("归档缺少 manifest.json,不是有效的书库备份"))?;
        let mut bytes = Vec::new();
        m.read_to_end(&mut bytes).map_err(|e| err(format!("读 manifest 失败:{e}")))?;
        serde_json::from_slice(&bytes).map_err(|e| err(format!("manifest 解析失败:{e}")))?
    };
    if manifest.format != BACKUP_FORMAT {
        return Err(err(format!(
            "不是书库备份归档(format={:?},要求 {BACKUP_FORMAT:?})",
            manifest.format
        )));
    }
    if manifest.version > BACKUP_VERSION {
        return Err(err(format!(
            "备份版本过新(v{},当前支持 v{BACKUP_VERSION}),请升级应用",
            manifest.version
        )));
    }

    let total = zr.len();
    let mut done = 0usize;
    let mut written: u64 = 0;
    // 解压总量上限:防止恶意归档(zip bomb)写满磁盘。正常备份里已经压过的
    // .epb/图片几乎不再压缩,文本也只有几倍膨胀,所以「归档体积 × 200,
    // 且不低于 2 GiB」足够宽松,不会误伤真实备份。
    let packed = std::fs::metadata(archive).map(|m| m.len()).unwrap_or(0);
    let size_limit = packed.saturating_mul(200).max(2 * 1024 * 1024 * 1024);

    for i in 0..total {
        let mut entry = zr
            .by_index(i)
            .map_err(|e| err(format!("读归档项失败:{e}")))?;
        let name = entry.name().to_string();
        if name == "manifest.json" {
            continue;
        }
        // 防目录穿越:只接受「普通相对段」组成的条目名。
        // 注意:只拒绝 ".." 段是不够的 —— 条目名是绝对路径时(Windows 的盘符/UNC
        // 前缀 "C:/Users/..."、"//host/share/...";Unix 的根路径 "/etc/..."),
        // `Path::join` 会整体替换基路径,于是可以写到任意位置。
        // zip 为此提供了 enclosed_name()(拒绝绝对路径/前缀/.. 段),这里用它,
        // 并对 join 结果再做一次前缀断言。
        let Some(rel) = entry.enclosed_name() else {
            tracing::warn!("跳过归档中的非法路径条目: {name}");
            continue;
        };
        let dest = tmp.join(&rel);
        if !dest.starts_with(tmp) {
            tracing::warn!("跳过越界条目: {name}");
            continue;
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| err(format!("创建目录失败:{e}")))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| err(format!("创建目录失败:{e}")))?;
        }
        let mut out =
            std::fs::File::create(&dest).map_err(|e| err(format!("解包失败:{e}")))?;
        written += std::io::copy(&mut entry, &mut out)
            .map_err(|e| err(format!("解包失败:{e}")))?;
        if written > size_limit {
            return Err(err(format!(
                "归档解压后体积异常(已 {written} 字节),可能是恶意归档,已中止导入"
            )));
        }
        done += 1;
        progress(done, total.max(1), "extracting");
    }

    // 行集 JSON 解析
    let read_json = |name: &str| -> Result<Vec<u8>, EpubError> {
        std::fs::read(tmp.join(name)).map_err(|_| err(format!("归档缺少 {name},可能已损坏")))
    };
    let books: Vec<Book> = serde_json::from_slice(&read_json("books.json")?)
        .map_err(|e| err(format!("books.json 解析失败:{e}")))?;
    let chapters: Vec<Chapter> = serde_json::from_slice(&read_json("chapters.json")?)
        .map_err(|e| err(format!("chapters.json 解析失败:{e}")))?;
    let assets: Vec<Asset> = serde_json::from_slice(&read_json("assets.json")?)
        .map_err(|e| err(format!("assets.json 解析失败:{e}")))?;

    // reader_prefs.json 是 v2 才有的行集。**缺失不算损坏**——v1 归档本就没有它,
    // 此时返回 None 让导入端跳过 prefs、其余照常导入(向后兼容)。
    // 有意不在这里报错:为一个附属行集让整次书库恢复失败,代价不对等。
    let prefs: Option<Vec<PrefRow>> = {
        let path = tmp.join("reader_prefs.json");
        if path.exists() {
            let bytes = std::fs::read(&path)
                .map_err(|e| err(format!("读 reader_prefs.json 失败:{e}")))?;
            Some(
                serde_json::from_slice(&bytes)
                    .map_err(|e| err(format!("reader_prefs.json 解析失败:{e}")))?,
            )
        } else {
            // v2 起该行集是必备的:声明了 v2 却没有它 = 归档被改过或打包中途出错。
            // 仍不报错(不让附属行集废掉整次恢复),但不能静默——留 warn 可排障。
            if manifest.version >= 2 {
                tracing::warn!(
                    "归档声明 v{} 但缺少 reader_prefs.json,本次不会恢复任何阅读状态",
                    manifest.version
                );
            }
            None
        }
    };

    Ok((books, chapters, assets, prefs))
}

/// 把解包出的该书文件搬到正式存储目录。
fn move_book_files(
    svc: &BookService,
    tmp_storage: &Path,
    book: &Book,
    assets: Option<&Vec<&Asset>>,
) -> Result<(), EpubError> {
    // 源文件(.epb/.txt,归档根相对路径 = file_path)
    let src = tmp_storage.join(&book.file_path);
    if src.exists() {
        let dest = svc.storage_dir.join(&book.file_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| err(format!("创建目录失败:{e}")))?;
        }
        std::fs::copy(&src, &dest).map_err(|e| err(format!("复制书籍文件失败:{e}")))?;
    } else {
        tracing::warn!(
            "migration: 归档缺少源文件 {}(book {}),跳过该文件",
            book.file_path,
            book.id
        );
    }

    // 章节 html 目录(chapters/{book_id}/)
    let ch_dir = tmp_storage.join("chapters").join(&book.id);
    if ch_dir.exists() {
        let dest_dir = svc.storage_dir.join("chapters").join(&book.id);
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| err(format!("创建章节目录失败:{e}")))?;
        let entries =
            std::fs::read_dir(&ch_dir).map_err(|e| err(format!("读章节目录失败:{e}")))?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                let name = e.file_name();
                std::fs::copy(&p, dest_dir.join(&name))
                    .map_err(|e| err(format!("复制章节文件失败:{e}")))?;
            }
        }
    }

    // 上传封面(covers/{asset_id},href 以 cover: 前缀标识)
    if let Some(ass) = assets {
        for a in ass.iter() {
            if a.href.starts_with("cover:") {
                let src = tmp_storage.join("covers").join(&a.id);
                if src.exists() {
                    let dest_dir = svc.storage_dir.join("covers");
                    std::fs::create_dir_all(&dest_dir)
                        .map_err(|e| err(format!("创建封面目录失败:{e}")))?;
                    std::fs::copy(&src, dest_dir.join(&a.id))
                        .map_err(|e| err(format!("复制封面失败:{e}")))?;
                }
            }
        }
    }

    Ok(())
}

// ========== 单元测试:导出 → 导入往返(合并/去重) ==========

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn setup_service(dir: &Path) -> BookService {
        let opts = SqliteConnectOptions::from_str(":memory:")
            .expect("sqlite opts")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
        BookService::new(pool, dir.to_path_buf())
    }

    async fn insert_book(
        svc: &BookService,
        id: &str,
        sha: &str,
        file_path: &str,
        chapter_ids: &[&str],
    ) {
        sqlx::query(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, \
             file_size, file_sha256, created_at) \
             VALUES (?, '测试书', '[\"作者\"]', 'zh', ?, ?, 10, ?, '2024-01-01 00:00:00')",
        )
        .bind(id)
        .bind(id)
        .bind(file_path)
        .bind(sha)
        .execute(&svc.pool)
        .await
        .expect("insert book");
        for (i, cid) in chapter_ids.iter().enumerate() {
            svc.write_chapter_html(id, cid, "<p>正文</p>").expect("write html");
            sqlx::query(
                "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
                 VALUES (?, ?, ?, ?, ?, '', 0)",
            )
            .bind(cid)
            .bind(id)
            .bind(format!("第{}章", i + 1))
            .bind(i as i64)
            .bind(format!("ch/{cid}.xhtml"))
            .execute(&svc.pool)
            .await
            .expect("insert chapter");
        }
        // 源文件
        std::fs::write(svc.storage_dir.join(file_path), b"fake-epub-bytes").expect("write src");
    }

    #[tokio::test]
    async fn export_then_import_merges_with_dedup() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        // A 机两本,B 机一本(与 A 的 book-1 同 SHA → 应去重跳过)
        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &["c1", "c2"]).await;
        insert_book(&svc_a, "book-2", "sha-2", "book-2.epb", &["c3"]).await;
        insert_book(&svc_b, "book-9", "sha-1", "book-9.epb", &["cx"]).await;

        // 导出 A
        let archive = tmp_a.path().join("backup.epublib");
        let export =
            export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");
        assert_eq!(export.book_count, 2);
        assert!(archive.exists());

        // 导入 B:book-1 同 SHA 跳过,book-2 新增
        let summary =
            import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");
        assert_eq!(summary.total, 2);
        assert_eq!(summary.skipped, 1, "同 SHA 去重");
        assert_eq!(summary.added, 1);

        // B 现在两本;book-2 的章节 html 与源文件已落盘
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM books")
            .fetch_one(&svc_b.pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2);
        assert!(svc_b.read_chapter_html("book-2", "c3").contains("正文"));
        assert!(svc_b.storage_dir.join("book-2.epb").exists());

        // FTS 触发器应已为新增章节建索引(book-2 的 c3)
        let fts: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM chapters_fts WHERE chapter_id = 'c3'")
                .fetch_one(&svc_b.pool)
                .await
                .unwrap();
        assert_eq!(fts.0, 1, "FTS 索引应随导入重建");

        // 再导入一次:全部跳过(幂等)
        let again =
            import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("again");
        assert_eq!(again.added, 0);
        assert_eq!(again.skipped, 2);
    }

    #[tokio::test]
    async fn import_rejects_non_backup_zip() {
        let tmp = tempfile::tempdir().expect("tmp");
        let svc = setup_service(tmp.path()).await;
        // 造一个普通 zip(无 manifest)
        let fake = tmp.path().join("fake.epublib");
        let f = std::fs::File::create(&fake).unwrap();
        let mut zw = ZipWriter::new(f);
        zw.start_file("hello.txt", SimpleFileOptions::default()).unwrap();
        zw.write_all(b"hi").unwrap();
        zw.finish().unwrap();

        let r = import_library(&svc, &fake, Arc::new(|_, _, _| {})).await;
        assert!(r.is_err(), "非书库备份应被拒绝");
    }

    /// 归档条目名是绝对路径时,`Path::join` 会整体替换基路径 —— 老代码
    /// 只拒绝 `..` 段,于是可以写到解包目录之外的任意位置。本用例锁住修复。
    ///
    /// 绝对路径有两种形态,按平台取对应的一种(另一形态在本平台不构成攻击):
    /// Windows 是带盘符前缀(`C:/...`)、Unix 是根路径(`/...`)。
    /// 二者在各自平台上都会让 `Path::join` 丢弃基路径,检测看 `enclosed_name()`
    /// 是否拒绝 `Component::Prefix` / `Component::RootDir`。
    #[tokio::test]
    async fn import_never_writes_outside_extract_dir() {
        let tmp = tempfile::tempdir().expect("tmp");
        let svc = setup_service(tmp.path()).await;

        // 攻击者希望被写出的文件(解包目录之外)
        let outside = tmp.path().join("pwned.txt");
        #[cfg(windows)]
        let evil = outside.to_string_lossy().replace('\\', "/");
        #[cfg(not(windows))]
        let evil = outside.to_string_lossy().into_owned();
        let is_absolute = if cfg!(windows) {
            evil.contains(':')
        } else {
            evil.starts_with('/')
        };
        assert!(is_absolute, "越界条目必须是绝对路径,实际: {evil}");

        let archive = tmp.path().join("evil.epublib");
        let f = std::fs::File::create(&archive).unwrap();
        let mut zw = ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(
            format!(r#"{{"format":"{BACKUP_FORMAT}","version":{BACKUP_VERSION}}}"#).as_bytes(),
        )
        .unwrap();
        for row in ["books.json", "chapters.json", "assets.json"] {
            zw.start_file(row, opts).unwrap();
            zw.write_all(b"[]").unwrap();
        }
        // 越界条目:盘符前缀(Windows 上 join 会整体替换基路径)
        zw.start_file(evil.clone(), opts).unwrap();
        zw.write_all(b"pwned").unwrap();
        // 传统穿越条目(老代码已拦,这里一并锁住)
        zw.start_file("../pwned2.txt", opts).unwrap();
        zw.write_all(b"pwned").unwrap();
        zw.finish().unwrap();

        let r = import_library(&svc, &archive, Arc::new(|_, _, _| {})).await;
        // 行集都是空数组 → 导入本身应成功(新增 0 本),但越界文件绝不能被写出
        assert!(r.is_ok(), "空备份应能正常导入:{r:?}");
        assert!(
            !outside.exists(),
            "不得写到解包目录之外:{}",
            outside.display()
        );
        let escaped = tmp.path().parent().unwrap().join("pwned2.txt");
        assert!(!escaped.exists(), "不得穿越 ..:{}", escaped.display());
    }

    // ---------- 阅读状态随备份走(v2 新增行集) ----------

    /// 读归档里某个条目的字节;条目不存在返回 None。
    fn read_entry(archive: &Path, name: &str) -> Option<Vec<u8>> {
        let f = std::fs::File::open(archive).expect("open archive");
        let mut zr = zip::ZipArchive::new(f).expect("zip");
        let mut e = zr.by_name(name).ok()?;
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).expect("read entry");
        Some(buf)
    }

    fn pref_value(svc_rows: &[PrefRow], key: &str) -> Option<String> {
        svc_rows.iter().find(|r| r.key == key).map(|r| r.value.clone())
    }

    /// 换电脑的主场景:归档必须真的带上阅读状态,导入空库后进度与偏好都在。
    /// 锁住「导出侧写了 reader_prefs.json」——只测进口不测出口,少写一行就全丢。
    #[tokio::test]
    async fn reader_prefs_survive_export_import_roundtrip() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &["c1"]).await;
        svc_a
            .set_reader_pref("epub_reader:progress:book-1", "{\"c1\":37}")
            .await
            .expect("seed progress");
        svc_a
            .set_reader_pref("epub_reader:theme:v2", "\"dark\"")
            .await
            .expect("seed theme");

        let archive = tmp_a.path().join("backup.epublib");
        export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");

        assert!(
            read_entry(&archive, "reader_prefs.json").is_some(),
            "归档应含 reader_prefs.json(v2 新增行集)"
        );
        assert_eq!(BACKUP_VERSION, 2, "新增行集必须升版本,否则旧版会静默忽略");

        import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");

        let rows = svc_b.list_reader_prefs().await.expect("list");
        assert_eq!(
            pref_value(&rows, "epub_reader:progress:book-1").as_deref(),
            Some("{\"c1\":37}"),
            "滚动进度应随备份恢复"
        );
        assert_eq!(
            pref_value(&rows, "epub_reader:theme:v2").as_deref(),
            Some("\"dark\""),
            "全局偏好应随备份恢复"
        );
    }

    /// 合并两台设备:**逐键**取较新,而不是像书那样「已存在就整本跳过」。
    #[tokio::test]
    async fn import_merges_prefs_per_key_taking_newer() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        // 每书键只在「本机确实有这本书」时才被保留,所以先把书建出来:
        // A 有 book-1 与 book-9,B 只有 book-1
        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &["c1"]).await;
        insert_book(&svc_a, "book-9", "sha-9", "book-9.epb", &["c9"]).await;
        insert_book(&svc_b, "book-1", "sha-1", "book-1.epb", &["c1"]).await;

        const K: &str = "epub_reader:progress:book-1";
        // A 先写(更旧),B 后写(更新)——同一时刻的毫秒精度相同,必须拉开间隔
        svc_a.set_reader_pref(K, "{\"c1\":10}").await.expect("seed a");
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        svc_b.set_reader_pref(K, "{\"c1\":80}").await.expect("seed b");
        // 另加一个 B 独有、一个 A 独有的键,验证不是只处理两边同名的键
        svc_b.set_reader_pref("epub_reader:fontSize:global", "18")
            .await
            .expect("seed b2");
        svc_a.set_reader_pref("epub_reader:status:book-9", "\"reading\"")
            .await
            .expect("seed a2");

        let archive = tmp_a.path().join("backup.epublib");
        export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");
        import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");

        let rows = svc_b.list_reader_prefs().await.expect("list");
        assert_eq!(
            pref_value(&rows, K).as_deref(),
            Some("{\"c1\":80}"),
            "本地较新的值不能被备份里更旧的值覆盖"
        );
        assert_eq!(
            pref_value(&rows, "epub_reader:fontSize:global").as_deref(),
            Some("18"),
            "B 独有的键不受导入影响"
        );
        assert_eq!(
            pref_value(&rows, "epub_reader:status:book-9").as_deref(),
            Some("\"reading\""),
            "A 独有的键应被补进来"
        );
    }

    /// v1 归档(manifest version=1、无 reader_prefs.json)必须照常导入、不报错。
    /// 这是向后兼容的回归锁:老备份不能因为新增行集而变得导不进去。
    /// 断言「本机已有偏好未被改动」——比断言「表为空」可证伪:后者在空库上恒真。
    #[tokio::test]
    async fn import_accepts_v1_archive_without_prefs() {
        let tmp = tempfile::tempdir().expect("tmp");
        let svc = setup_service(tmp.path()).await;
        svc.set_reader_pref("epub_reader:fontSize:global", "22")
            .await
            .expect("seed");

        let archive = tmp.path().join("v1.epublib");
        let f = std::fs::File::create(&archive).unwrap();
        let mut zw = ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(format!(r#"{{"format":"{BACKUP_FORMAT}","version":1}}"#).as_bytes())
            .unwrap();
        for row in ["books.json", "chapters.json", "assets.json"] {
            zw.start_file(row, opts).unwrap();
            zw.write_all(b"[]").unwrap();
        }
        // 刻意不写 reader_prefs.json —— 这正是 v1 归档的形态
        zw.finish().unwrap();

        let r = import_library(&svc, &archive, Arc::new(|_, _, _| {})).await;
        assert!(r.is_ok(), "v1 归档应能正常导入:{r:?}");
        assert_eq!(r.unwrap().total, 0);
        let rows = svc.list_reader_prefs().await.expect("list");
        assert_eq!(
            pref_value(&rows, "epub_reader:fontSize:global").as_deref(),
            Some("22"),
            "v1 归档没有 prefs 行集,既不该报错、也不该动本机已有的值"
        );
    }

    // ---------- 两台设备合并:book id 不同、SHA 相同 ----------

    /// 同一本书在两台设备上各有自己的 id(导入时 `Uuid::new_v4()`)，
    /// 所以合并时归档侧那本会被 SHA 判重跳过。
    /// 此时它的阅读进度必须**改挂到本机那本书的 id 上**——
    /// 否则进度既没恢复(本机书的键仍为空)，又留下一个指向不存在书籍的孤儿键：
    /// 孤儿键清不掉(`delete_book` 在本机找不到那本书,早返回)、
    /// 且会随之后每一次导出继续传播到别的机器。
    #[tokio::test]
    async fn import_remaps_progress_to_local_book_id_on_sha_dedup() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        // 同一本书(同 SHA-1),两台设备各自的 id 不同
        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &["c1"]).await;
        insert_book(&svc_b, "book-9", "sha-1", "book-9.epb", &["c9"]).await;

        // A 机读到 37%,B 机尚未读过这本
        svc_a
            .set_reader_pref("epub_reader:progress:book-1", "{\"c1\":37}")
            .await
            .expect("seed");

        let archive = tmp_a.path().join("backup.epublib");
        export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");
        let summary =
            import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");
        assert_eq!(summary.skipped, 1, "同 SHA 应跳过整本书");

        let rows = svc_b.list_reader_prefs().await.expect("list");
        assert_eq!(
            pref_value(&rows, "epub_reader:progress:book-9").as_deref(),
            Some("{\"c1\":37}"),
            "进度应改挂到本机 book-9 上,实际:{rows:?}"
        );
        assert!(
            pref_value(&rows, "epub_reader:progress:book-1").is_none(),
            "不得留下指向归档侧 id 的孤儿键:{rows:?}"
        );
    }

    /// 归档里指向「本机和归档都没有的书」的残键不得被搬进来。
    #[tokio::test]
    async fn import_skips_prefs_for_unknown_books() {
        let tmp_a = tempfile::tempdir().expect("tmp");
        let tmp_b = tempfile::tempdir().expect("tmp");
        let svc_a = setup_service(tmp_a.path()).await;
        let svc_b = setup_service(tmp_b.path()).await;

        insert_book(&svc_a, "book-1", "sha-1", "book-1.epb", &["c1"]).await;
        // 指向一本两边都不存在的书的残键(历史遗留)
        svc_a
            .set_reader_pref("epub_reader:progress:ghost-book", "{\"c1\":9}")
            .await
            .expect("seed ghost");
        // 两边都有的书,它的进度必须留下
        svc_a
            .set_reader_pref("epub_reader:progress:book-1", "{\"c1\":55}")
            .await
            .expect("seed book");
        svc_a
            .set_reader_pref("epub_reader:fontSize:global", "22")
            .await
            .expect("seed global");

        let archive = tmp_a.path().join("backup.epublib");
        export_library(&svc_a, &archive, Arc::new(|_, _, _| {})).await.expect("export");
        import_library(&svc_b, &archive, Arc::new(|_, _, _| {})).await.expect("import");

        let rows = svc_b.list_reader_prefs().await.expect("list");
        assert!(
            pref_value(&rows, "epub_reader:progress:ghost-book").is_none(),
            "无主的每书键应被丢弃:{rows:?}"
        );
        assert_eq!(
            pref_value(&rows, "epub_reader:progress:book-1").as_deref(),
            Some("{\"c1\":55}"),
            "书本身被导入了,它的进度应照常带上"
        );
        assert_eq!(
            pref_value(&rows, "epub_reader:fontSize:global").as_deref(),
            Some("22"),
            "全局偏好与书无关,必须照常导入"
        );
    }
}
