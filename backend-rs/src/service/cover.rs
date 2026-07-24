// 封面管理：设置 / 删除 / 清理旧封面标记。

use uuid::Uuid;

use crate::db::Asset;
use crate::epub::EpubError;
use crate::storage;

use super::BookService;

impl BookService {
    // ---------- 封面管理 ----------

    /// 为书籍设置上传封面：清旧封面标记 → 写 covers/{uuid} → 插入 Asset(is_cover=1)。
    /// 书不存在返回 None。
    pub async fn set_cover(
        &self,
        book_id: &str,
        image_bytes: &[u8],
        media_type: &str,
    ) -> Result<Option<Asset>, EpubError> {
        if self.get_book_orm(book_id).await?.is_none() {
            return Ok(None);
        }

        // 清理旧封面标记
        self.clear_existing_cover(book_id).await?;

        // 写新封面到磁盘 covers/{asset_id}
        let asset_id = Uuid::new_v4().simple().to_string();
        let covers_dir = self.storage_dir.join("covers");
        std::fs::create_dir_all(&covers_dir)
            .map_err(|e| EpubError::FileSystem(format!("创建 covers 目录失败：{e}")))?;
        let cover_path = covers_dir.join(&asset_id);
        storage::atomic_write(&cover_path, image_bytes)
            .map_err(|e| EpubError::FileSystem(format!("写封面失败：{e}")))?;

        // 插入 Asset 行
        let href = format!("cover:{asset_id}");
        let size = image_bytes.len() as i64;
        let r = sqlx::query(
            "INSERT INTO assets (id, book_id, href, media_type, size, is_cover) \
             VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(&asset_id)
        .bind(book_id)
        .bind(&href)
        .bind(media_type)
        .bind(size)
        .execute(&self.pool)
        .await;

        if let Err(e) = r {
            // 回滚磁盘文件
            let _ = std::fs::remove_file(&cover_path);
            return Err(EpubError::FileSystem(format!("INSERT asset 失败：{e}")));
        }

        // 读回刚插入的 Asset
        let asset = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND id = ?",
        )
        .bind(book_id)
        .bind(&asset_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("读回封面失败：{e}")))?;

        Ok(asset)
    }

    /// 删除上传的封面（href 以 "cover:" 开头）。
    /// EPUB 自带封面只取消标记（is_cover=0）。无书或无上传封面返回 false。
    pub async fn delete_cover(&self, book_id: &str) -> Result<bool, EpubError> {
        if self.get_book_orm(book_id).await?.is_none() {
            return Ok(false);
        }

        // 查当前封面
        let cover: Option<Asset> = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND is_cover = 1",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询封面失败：{e}")))?;

        let Some(cover) = cover else {
            return Ok(false);
        };

        if cover.href.starts_with("cover:") {
            // 上传的封面：删磁盘文件 + DB 行
            let cover_path = self.storage_dir.join("covers").join(&cover.id);
            let _ = std::fs::remove_file(&cover_path);
            sqlx::query("DELETE FROM assets WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("DELETE 封面失败：{e}")))?;
        } else {
            // EPUB 自带封面：只取消标记
            sqlx::query("UPDATE assets SET is_cover = 0 WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("取消封面标记失败：{e}")))?;
        }

        Ok(true)
    }

    /// 清除当前封面标记：上传封面删文件+行，EPUB 自带封面只置 0。
    async fn clear_existing_cover(&self, book_id: &str) -> Result<(), EpubError> {
        let cover: Option<Asset> = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND is_cover = 1",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询旧封面失败：{e}")))?;

        let Some(cover) = cover else {
            return Ok(());
        };

        if cover.href.starts_with("cover:") {
            let cover_path = self.storage_dir.join("covers").join(&cover.id);
            let _ = std::fs::remove_file(&cover_path);
            sqlx::query("DELETE FROM assets WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("DELETE 旧封面失败：{e}")))?;
        } else {
            sqlx::query("UPDATE assets SET is_cover = 0 WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("取消旧封面标记失败：{e}")))?;
        }

        Ok(())
    }
}
