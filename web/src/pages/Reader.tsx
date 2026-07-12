// 全屏阅读器页面。仿 iOS Books 的极简风：
// - 默认隐藏 detail chrome，纯阅读
// - 顶/底栏在用户停手时显示，向上滚动时隐藏
// - 设置面板（字号/行间距/主题/字体）
// - 滚动进度按章节持久化
//
// 注意：使用 `dangerouslySetInnerHTML` 渲染服务端重写过的章节 HTML。
// 服务端在 books.py::_rewrite_chapter_html 已做白名单重写（<img src> 和 SVG <image>
// 都改成 /api/books/{id}/assets/{aid}），XSS 风险被服务端限制。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  ReaderBottomBar,
  ReaderTopBar,
} from '../components/ReaderToolbar';
import { ReaderSettings } from '../components/ReaderSettings';
import { useBook, useChapter } from '../hooks/useBooks';
import {
  getChapterProgress,
  setChapterProgress,
} from '../hooks/useReaderProgress';
import { useReaderSettings } from '../hooks/useReaderSettings';
import { FONTS, LINE_HEIGHTS, THEMES } from '../lib/readerPrefs';

const TOOLBAR_HIDE_AFTER_MS = 1500; // 停手多久后自动显示工具栏
const PROGRESS_SAVE_DEBOUNCE_MS = 1500;
const SCROLL_DELTA_THRESHOLD = 4; // 忽略微小滚动

export default function ReaderPage() {
  const { bookId = '', chapterId = '' } = useParams<{
    bookId: string;
    chapterId: string;
  }>();
  const navigate = useNavigate();

  const settings = useReaderSettings();
  const bookQuery = useBook(bookId);
  const chapterQuery = useChapter(bookId, chapterId, 'html');

  const scrollRef = useRef<HTMLDivElement>(null);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restored, setRestored] = useState(false); // 是否已经完成滚位置恢复
  const [liveProgress, setLiveProgress] = useState(0); // 当前实时滚动百分比（底栏显示）

  // ---------- 计算 CSS 变量（设置变化时即时生效） ----------
  const cssVars = useMemo<React.CSSProperties>(
    () => ({
      ['--fs' as string]: `${settings.fontSize}px`,
      ['--lh' as string]: LINE_HEIGHTS[settings.lineHeight],
      ['--bg' as string]: THEMES[settings.theme].bg,
      ['--fg' as string]: THEMES[settings.theme].fg,
      ['--font-family' as string]: FONTS[settings.font].family,
    }),
    [settings.fontSize, settings.lineHeight, settings.theme, settings.font],
  );

  // ---------- 章节序列定位（上下章） ----------
  const chapters = bookQuery.data?.chapters ?? [];
  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.spine_order - b.spine_order),
    [chapters],
  );
  const currentIndex = sortedChapters.findIndex((c) => c.id === chapterId);
  const prev = currentIndex > 0 ? sortedChapters[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < sortedChapters.length - 1
      ? sortedChapters[currentIndex + 1]
      : null;

  // 重要：因为后端 ChapterOut.id 可能包含 ".xhtml" 等含字符点，需要原样保留。
  // URL 跳转不做额外编码（react-router 会处理）。
  const prevHref = prev ? `/books/${bookId}/chapters/${encodeURIComponent(prev.id)}` : null;
  const nextHref = next ? `/books/${bookId}/chapters/${encodeURIComponent(next.id)}` : null;

  // ---------- 滚位置恢复：进入章节后定位 ----------
  useEffect(() => {
    if (!chapterQuery.data) return;
    const el = scrollRef.current;
    if (!el) return;
    const pct = getChapterProgress(bookId, chapterId);
    setRestored(false);
    // 等一帧让 layout 计算完成
    requestAnimationFrame(() => {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0 && pct > 0 && pct < 1) {
        el.scrollTop = Math.round(max * pct);
      } else if (pct >= 1) {
        // 之前已经读完了 — 直接置底
        el.scrollTop = el.scrollHeight;
      }
      setRestored(true);
      // 初次进度
      const finalMax = el.scrollHeight - el.clientHeight;
      setLiveProgress(finalMax > 0 ? el.scrollTop / finalMax : 0);
    });
  }, [bookId, chapterId, chapterQuery.data]);

  // ---------- 滚位置保存 + 工具栏显隐（wheel + scroll 协同） ----------
  // 鼠标滚轮 / 触控板手势触发 wheel 事件，但浏览器可能合并请求只发一两次 scroll。
  // 因此方向判定用 wheel event.deltaY，scrollTop 用 scroll event。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let lastY = el.scrollTop;
    let progressTimer: number | undefined;
    let toolbarTimer: number | undefined;
    // 累计 wheel deltaY，超过阈值（默认 10px）才认定为"用户在主动滚动"，
    // 避免滚轮微动一格就频繁触发工具栏显隐。
    let wheelDeltaAcc = 0;
    let wheelWindowTimer: number | undefined;
    const WHEEL_ACC_THRESHOLD = 10;
    const WHEEL_WINDOW_MS = 200; // 累计窗口

    const showToolbar = () => {
      setToolbarVisible(true);
      clearTimeout(toolbarTimer);
    };
    const hideToolbar = (withFallback: boolean) => {
      setToolbarVisible(false);
      clearTimeout(toolbarTimer);
      if (withFallback) {
        toolbarTimer = window.setTimeout(
          () => setToolbarVisible(true),
          TOOLBAR_HIDE_AFTER_MS,
        );
      }
    };

    const updateLiveProgress = () => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) {
        setLiveProgress(0);
        return;
      }
      setLiveProgress(el.scrollTop / max);
    };

    const onWheel = (e: WheelEvent) => {
      // 在容器上发生的 wheel 才管；其它区域（设置面板等）不处理
      const target = e.target as Node | null;
      if (!target || !el.contains(target)) return;

      // 在窗口期内累计 deltaY；超阈值后真正处理方向
      const dir = e.deltaY;
      if (dir === 0) return;

      const before = wheelDeltaAcc;
      wheelDeltaAcc += dir;
      // 累计够一次处理
      if (Math.abs(wheelDeltaAcc) < WHEEL_ACC_THRESHOLD) {
        // 重置累计窗口
        clearTimeout(wheelWindowTimer);
        wheelWindowTimer = window.setTimeout(
          () => {
            wheelDeltaAcc = 0;
          },
          WHEEL_WINDOW_MS,
        );
        void before;
        return;
      }

      // 消费完这次累计
      wheelDeltaAcc = 0;
      clearTimeout(wheelWindowTimer);

      const max = el.scrollHeight - el.clientHeight;
      const cur = el.scrollTop;
      const atBottom = max > 0 && cur >= max - SCROLL_DELTA_THRESHOLD;

      if (atBottom) {
        showToolbar();
      } else if (dir > 0) {
        // 滚轮向下滑（deltaY > 0 = 内容上移）→ 隐藏
        hideToolbar(true);
      } else {
        // 滚轮向上滑（deltaY < 0 = 内容下移）→ 显示
        showToolbar();
      }
    };

    const onScroll = () => {
      const cur = el.scrollTop;
      if (Math.abs(cur - lastY) < SCROLL_DELTA_THRESHOLD) return;
      lastY = cur;

      const max = el.scrollHeight - el.clientHeight;
      const atBottom = max > 0 && cur >= max - SCROLL_DELTA_THRESHOLD;

      // scroll 触发的显隐：到顶/到底/反弹时强制显示，否则保持 wheel 的状态
      if (atBottom) {
        showToolbar();
      } else if (cur === 0) {
        showToolbar();
      }

      // 滚动进度：debounce 保存到 localStorage
      clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => {
        const max2 = el.scrollHeight - el.clientHeight;
        if (max2 <= 0) return;
        const pct = Math.max(0, Math.min(1, el.scrollTop / max2));
        setChapterProgress(bookId, chapterId, pct);
      }, PROGRESS_SAVE_DEBOUNCE_MS);

      updateLiveProgress();
    };

    // wheel 用 non-passive：可以 preventDefault，未来如要劫持滚轮
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      clearTimeout(progressTimer);
      clearTimeout(toolbarTimer);
      clearTimeout(wheelWindowTimer);
    };
  }, [bookId, chapterId, chapterQuery.data]);

  // ---------- 加载 / 错误状态 ----------
  if (bookQuery.isLoading || chapterQuery.isLoading) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <div className="opacity-70 text-sm">加载中…</div>
      </div>
    );
  }

  if (chapterQuery.error || !chapterQuery.data) {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-4 px-6"
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <ErrorBanner error={chapterQuery.error ?? new Error('章节不存在')} />
        <button
          onClick={() => navigate(`/books/${bookId}`)}
          className="px-4 py-2 rounded-md border border-current/30 text-sm hover:bg-black/5"
        >
          ← 返回详情
        </button>
      </div>
    );
  }

  const chapter = chapterQuery.data;
  const progressLabel =
    currentIndex >= 0 ? `${currentIndex + 1} / ${sortedChapters.length}` : '';

  return (
    <div
      style={cssVars}
      className="fixed inset-0 overflow-hidden"
    >
      <ReaderTopBar
        bookId={bookId}
        chapterTitle={chapter.title}
        visible={toolbarVisible}
        onSettings={() => setSettingsOpen(true)}
      />

      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-auto py-20 px-6"
        aria-label="章节正文"
      >
        <article
          className="mx-auto max-w-[680px]"
          style={{
            fontSize: 'var(--fs)',
            lineHeight: 'var(--lh)',
            fontFamily: 'var(--font-family)',
          }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: chapter.content }}
          // 一些常见正文样式：用 Tailwind 的子选择器兜底
          onLoad={(e) => {
            // 章节 HTML 内 img 自适配（防止太大撑爆），加一段全局子样式
            const root = e.currentTarget;
            root.querySelectorAll('img').forEach((img) => {
              (img as HTMLElement).style.maxWidth = '100%';
              (img as HTMLElement).style.height = 'auto';
              (img as HTMLElement).style.display = 'block';
              (img as HTMLElement).style.margin = '1em auto';
              (img as HTMLElement).style.borderRadius = '4px';
            });
          }}
        />
      </div>

      <ReaderBottomBar
        visible={toolbarVisible}
        prevHref={prevHref}
        nextHref={nextHref}
        progressLabel={progressLabel}
        progressPercent={restored ? liveProgress : 0}
      />

      <ReaderSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        fontSize={settings.fontSize}
        lineHeight={settings.lineHeight}
        theme={settings.theme}
        font={settings.font}
        onFontSizeChange={settings.setFontSize}
        onLineHeightChange={settings.setLineHeight}
        onThemeChange={settings.setTheme}
        onFontChange={settings.setFont}
      />
    </div>
  );
}