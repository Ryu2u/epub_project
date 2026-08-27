// 导出：把书重新打包成 EPUB 3 字节。

use crate::db::{Asset, Book, Chapter};
use crate::epub::EpubError;

use super::BookService;

impl BookService {
    // ---------- 导出 ----------

    /// 导出 EPUB：读所有 asset 字节 + 每章 html，调 epub_writer 重建 EPUB 3 字节。
    ///
    /// `on_progress(current, total, phase)` 在读取资源字节 / 生成章节 XHTML 时被回调：
    ///   - "reading_assets": (current, total, "reading_assets")
    ///   - "building": (current, total, "building") — build_epub_bytes 内部触发
    pub fn export_epub(
        &self,
        book: &Book,
        chapters: Vec<Chapter>,
        assets: &[Asset],
        on_progress: impl Fn(usize, usize, &str),
    ) -> Result<Vec<u8>, EpubError> {
        let mut asset_bytes: std::collections::HashMap<String, Vec<u8>> =
            std::collections::HashMap::new();
        let asset_total = assets.len();
        for (i, a) in assets.iter().enumerate() {
            if let Ok(bytes) = self.read_asset_bytes(a, book) {
                asset_bytes.insert(a.id.clone(), bytes);
            }
            on_progress(i + 1, asset_total, "reading_assets");
        }

        // 每章 html 真值在 storage 文件里，按 chapters 顺序读出来传给 writer
        let chapter_htmls: Vec<String> = chapters
            .iter()
            .map(|ch| self.read_chapter_html(&ch.book_id, &ch.id))
            .collect();

        Ok(crate::epub_writer::build_epub_bytes(
            book,
            chapters,
            chapter_htmls,
            assets,
            &asset_bytes,
            &on_progress,
        ))
    }
}
