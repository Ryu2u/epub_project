// 章节 HTML 编辑器页面 —— 左侧 CodeMirror 源码 + 右侧实时预览。
// 路由：/books/:bookId/edit/:chapterId
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiPatch, apiGet } from '../api/client';
import { HtmlEditor } from '../components/HtmlEditor';
import type { BookDetail, ChapterContent, ChapterUpdate } from '../api/types';

// 预览 HTML 中 <img src="/api/books/..."> 的重写已在后端完成，
// 这里直接用 dangerouslySetInnerHTML 渲染即可。

export default function ChapterEditorPage() {
  const { bookId = '', chapterId = '' } = useParams<{
    bookId: string;
    chapterId: string;
  }>();
  const navigate = useNavigate();

  // 加载书籍和章节数据
  const [book, setBook] = useState<BookDetail | null>(null);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // 编辑状态
  const [htmlContent, setHtmlContent] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true); // 是否有未保存的修改
  const [saveError, setSaveError] = useState<unknown>(null);

  // 预览容器 ref，用于重写 img src
  const previewRef = useRef<HTMLDivElement>(null);

  // 初始加载
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [bookData, chapterData] = await Promise.all([
          apiGet<BookDetail>(`/api/books/${bookId}`),
          apiGet<ChapterContent>(`/api/books/${bookId}/chapters/${chapterId}?format=html`),
        ]);
        if (cancelled) return;
        setBook(bookData);
        setChapter(chapterData);
        setHtmlContent(chapterData.content);
        setChapterTitle(chapterData.title);
        setSaved(true);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bookId, chapterId]);

  // 内容变化
  const handleHtmlChange = useCallback((value: string) => {
    setHtmlContent(value);
    setSaved(false);
  }, []);

  // 保存
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const data: ChapterUpdate = {};
      if (chapterTitle !== chapter?.title) data.title = chapterTitle;
      if (htmlContent !== chapter?.content) data.html = htmlContent;
      if (Object.keys(data).length === 0) {
        setSaving(false);
        return;
      }
      await apiPatch<ChapterContent>(
        `/api/books/${bookId}/chapters/${encodeURIComponent(chapterId)}`,
        data,
      );
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }, [bookId, chapterId, chapterTitle, htmlContent, chapter]);

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  // 预览：把 HTML 中 /api/books/... 的图片 src 重写为可加载的 URL
  // （后端 get_chapter 已经重写过，所以这里直接用即可）
  const previewHtml = useMemo(() => {
    // 确保相对图片路径能正确加载：在 <base> 标签中指定基础路径
    const base = `<base href="/api/books/${bookId}/assets/">`;
    // 注入 <base> 到 <head>，如果有的话
    if (htmlContent.includes('<head')) {
      return htmlContent.replace(/<head([^>]*)>/i, `<head$1>${base}`);
    }
    // 如果没有 <head>，在开头注入
    return `${base}${htmlContent}`;
  }, [htmlContent, bookId]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-900 text-cream-faint">
        <span className="font-display text-lg text-cream-muted">加载中…</span>
      </div>
    );
  }

  if (error || !book || !chapter) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-ink-900 text-cream">
        <p className="text-red-400">加载失败</p>
        <button
          onClick={() => navigate(`/books/${bookId}`)}
          className="text-sm text-gold-400 hover:text-gold-200"
        >
          ← 返回详情
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex h-screen flex-col bg-ink-900 text-cream"
      style={{ colorScheme: 'dark' }}
    >
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-gold-400/10 bg-ink-900/90 px-4 py-2 backdrop-blur-md">
        <button
          onClick={() => navigate(`/books/${bookId}`)}
          className="shrink-0 rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200"
        >
          ← 返回
        </button>

        <div className="min-w-0 flex-1 truncate text-xs text-cream-faint" title={book.title}>
          {book.title}
        </div>

        <input
          value={chapterTitle}
          onChange={(e) => {
            setChapterTitle(e.target.value);
            setSaved(false);
          }}
          className="w-64 rounded border border-gold-400/25 bg-ink-800 px-2 py-1 text-sm text-cream focus:border-gold-400/60 focus:outline-none"
          placeholder="章节标题"
        />

        <div className="flex items-center gap-2">
          {!saved && (
            <span className="text-xs text-gold-400">未保存</span>
          )}
          {saved && !saving && (
            <span className="text-xs text-cream-faint">已保存</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="rounded-full bg-gold-400 px-4 py-1.5 text-sm font-medium text-ink-900 transition-all hover:bg-gold-200 disabled:opacity-40"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </header>

      {saveError ? (
        <div className="border-b border-red-500/25 bg-red-950/40 px-4 py-2 text-sm text-red-200">
          保存失败：{String(saveError)}
        </div>
      ) : null}

      {/* 主体：左右分栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左：HTML 源码编辑器 */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-gold-400/10">
          <div className="shrink-0 border-b border-gold-400/10 px-3 py-1 text-xs text-cream-faint">
            HTML 源码
          </div>
          <HtmlEditor
            value={htmlContent}
            onChange={handleHtmlChange}
            className="min-h-0 flex-1"
          />
        </div>

        {/* 右：实时预览 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-gold-400/10 px-3 py-1 text-xs text-cream-faint">
            预览
          </div>
          <div
            ref={previewRef}
            className="min-h-0 flex-1 overflow-auto bg-white p-6 text-black"
            // 用 dangerouslySetInnerHTML 渲染预览（与阅读器同样的安全模型）
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>
    </div>
  );
}
