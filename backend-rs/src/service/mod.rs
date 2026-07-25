// BookService：业务层，粘合 EPUB 解析 / DB / 文件系统。
// 对应 Python services/book_service.py 的核心方法。
//
// 模块划分：
// - mod.rs：struct 定义 + 构造 + 公共辅助（book_file_path / read_asset_bytes）
// - read.rs：读取路径（书 / 章节 / 资源 / 列表）
// - write.rs：写路径（上传 / 更新 / 重排 / 删除）
// - cover.rs：封面管理（设置 / 删除 / 清理）
// - search.rs：搜索（FTS5 + LIKE 兜底）
// - export.rs：导出 EPUB

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::db::{Asset, Book};
use crate::epub::EpubError;

mod cover;
mod export;
mod read;
mod search;
mod write;

pub struct BookService {
    pub pool: SqlitePool,
    pub storage_dir: PathBuf,
}

impl BookService {
    pub fn new(pool: SqlitePool, storage_dir: PathBuf) -> Self {
        Self { pool, storage_dir }
    }

    /// 书文件路径：从 Book.file_path 提取 basename（不含目录），
    /// 不再硬编码 .epb，以兼容 EPUB(.epb) 与 TXT(.txt) 两种来源。
    fn book_file_path(&self, book: &Book) -> PathBuf {
        self.storage_dir.join(
            Path::new(&book.file_path)
                .file_name()
                .unwrap_or_default(),
        )
    }

    /// 读取资源字节（封面从磁盘读，其他从 .epb zip 读）
    pub fn read_asset_bytes(&self, asset: &Asset, book: &Book) -> Result<Vec<u8>, EpubError> {
        if asset.href.starts_with("cover:") {
            // 上传的封面：从 covers/{id} 读
            let path = self.storage_dir.join("covers").join(&asset.id);
            std::fs::read(&path).map_err(|e| EpubError::FileSystem(format!("读封面失败：{e}")))
        } else {
            // EPUB 自带资源：从 .epb zip 读
            let epb_path = self
                .storage_dir
                .join(Path::new(&book.file_path).file_name().unwrap_or_default());
            let file = std::fs::File::open(&epb_path)
                .map_err(|e| EpubError::FileSystem(format!("打开 EPUB 失败：{e}")))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| EpubError::Corrupt(format!("打开 ZIP 失败：{e}")))?;
            let mut zf = archive
                .by_name(&asset.href)
                .map_err(|e| EpubError::FileSystem(format!("ZIP 内找不到 {e}")))?;
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut zf, &mut buf)
                .map_err(|e| EpubError::FileSystem(format!("读取失败：{e}")))?;
            Ok(buf)
        }
    }
}
