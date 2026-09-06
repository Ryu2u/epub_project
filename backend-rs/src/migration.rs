// 书库迁移:两台设备之间的数据搬运(导出归档 / 导入合并)。
//
// 归档格式(.epublib,实为 zip):
//   manifest.json   — 格式标识/版本/导出时间/书数
//   books.json      — books 表全量行(结构体序列化)
//   chapters.json   — chapters 表全量行
//   assets.json     — assets 表全量行
//   storage/...     — 存储目录原样(书籍源文件/chapters/*/html/covers)
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

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::db::{Asset, Book, Chapter};
use crate::epub::EpubError;
use crate::service::BookService;

/// 归档格式标识与版本。导入时校验,防止误吃无关 zip。
const BACKUP_FORMAT: &str = "epub-library-backup";
const BACKUP_VERSION: i64 = 1;

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
    progress: &ProgressFn,
) -> Result<u64, EpubError> {
    let file = std::fs::File::create(dest).map_err(|e| err(format!("创建归档失败:{e}")))?;
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
    let (books, chapters, assets) = tokio::task::spawn_blocking(move || {
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

    for (i, book) in books.iter().enumerate() {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT id FROM books WHERE id = ? OR file_sha256 = ?")
                .bind(&book.id)
                .bind(&book.file_sha256)
                .fetch_optional(&svc.pool)
                .await
                .map_err(|e| err(format!("查重失败:{e}")))?;

        if exists.is_some() {
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

        summary.added += 1;
        on_progress(i + 1, total, "importing");
    }

    Ok(summary)
}

/// 解包产物:三张表的全量行
type ArchiveRows = (Vec<Book>, Vec<Chapter>, Vec<Asset>);

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

    for i in 0..total {
        let mut entry = zr
            .by_index(i)
            .map_err(|e| err(format!("读归档项失败:{e}")))?;
        let name = entry.name().to_string();
        if name == "manifest.json" {
            continue;
        }
        let dest_rel = name.replace('\\', "/");
        // 防目录穿越:拒绝包含 .. 的路径
        if dest_rel.split('/').any(|seg| seg == "..") {
            continue;
        }
        let dest = tmp.join(&dest_rel);
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
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| err(format!("解包失败:{e}")))?;
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

    Ok((books, chapters, assets))
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
}
