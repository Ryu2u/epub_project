// 导出：EPUB 3（重建打包）或 TXT（标题顶格 / 正文段首缩进）。

use crate::core_db::{Asset, Book, Chapter};
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
        let mut missing_assets = 0usize;
        for (i, a) in assets.iter().enumerate() {
            match self.read_asset_bytes(a, book) {
                Ok(bytes) => {
                    asset_bytes.insert(a.id.clone(), bytes);
                }
                Err(e) => {
                    // 读不到(COS 取失败且本地 .epb 缺失/损坏)时,章节里的引用
                    // 仍会被改写成 assets/{id} → 包里留下悬空引用、图片全裂。
                    // 以前这里静默丢弃,用户只看到「导出成功」。
                    missing_assets += 1;
                    tracing::warn!("资源 {} 读取失败,导出包内将缺失:{e}", a.id);
                }
            }
            on_progress(i + 1, asset_total, "reading_assets");
        }
        if missing_assets > 0 {
            tracing::warn!(
                "本次导出缺失 {missing_assets} 个资源(共 {asset_total} 个),EPUB 里对应图片会显示不出来"
            );
        }

        // 每章 html 真值在 storage 文件里，按 chapters 顺序读出来传给 writer
        let mut empty_chapters = 0usize;
        let chapter_htmls: Vec<String> = chapters
            .iter()
            .map(|ch| {
                let html = self.read_chapter_html(&ch.book_id, &ch.id);
                if html.trim().is_empty() {
                    empty_chapters += 1;
                }
                html
            })
            .collect();
        if empty_chapters > 0 {
            // 读不到就是空串(storage.rs 里 unwrap_or_default):以前完全静默,
            // 导出出来是一本空书,用户没有任何提示
            tracing::warn!(
                "本次导出有 {empty_chapters}/{} 个章节正文为空(章节文件缺失或损坏)",
                chapters.len()
            );
        }

        crate::epub_writer::build_epub_bytes(
            book,
            chapters,
            chapter_htmls,
            assets,
            &asset_bytes,
            &on_progress,
        )
    }

    /// 导出 TXT：按章节顺序读 html 真值，转成
    /// 「标题顶格 / 正文段首两个全角空格」的纯文本（UTF-8）。
    ///
    /// `on_progress(current, total, "building")` 每章回调一次。
    pub fn export_txt(
        &self,
        chapters: Vec<Chapter>,
        on_progress: impl Fn(usize, usize, &str),
    ) -> Result<Vec<u8>, EpubError> {
        // 每章 html 真值在 storage 文件里，按 chapters 顺序读出来传给 writer
        let chapter_htmls: Vec<String> = chapters
            .iter()
            .map(|ch| self.read_chapter_html(&ch.book_id, &ch.id))
            .collect();

        Ok(crate::txt_writer::build_txt(
            &chapters,
            &chapter_htmls,
            &on_progress,
        ))
    }
}
