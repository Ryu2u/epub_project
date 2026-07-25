// 导出：把书重新打包成 EPUB 3 字节。

use crate::db::{Asset, Book, Chapter};
use crate::epub::EpubError;

use super::BookService;

impl BookService {
    // ---------- 导出 ----------

    /// 导出 EPUB：读所有 asset 字节 + 每章 html，调 epub_writer 重建 EPUB 3 字节
    pub fn export_epub(
        &self,
        book: &Book,
        chapters: Vec<Chapter>,
        assets: &[Asset],
    ) -> Result<Vec<u8>, EpubError> {
        let mut asset_bytes: std::collections::HashMap<String, Vec<u8>> =
            std::collections::HashMap::new();
        for a in assets {
            if let Ok(bytes) = self.read_asset_bytes(a, book) {
                asset_bytes.insert(a.id.clone(), bytes);
            }
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
        ))
    }
}
