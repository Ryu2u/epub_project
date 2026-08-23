// 全屏阅读器页面。布局仿起点中文网阅读页：
// - 正文上方：章节大标题 + 数据行（书名/作者/字数/时间）
// - 正文末尾："本章完" + 上一章 | 目录 | 下一章 三段式切换按钮
// - 右侧（宽屏≥900px）：常驻纵向工具栏（目录/书详情/书架/夜间/设置/返回顶部）；
//   窄屏隐藏侧边栏避免遮挡正文，顶栏提供 目录/设置 图标按钮兜底
// - 顶栏：滚动时自动显隐（返回 + 书名 + 进度）
// - 设置面板（字号/行间距/主题/字体）；滚动进度按章节持久化
//
// 注意：使用 `dangerouslySetInnerHTML` 渲染服务端重写过的章节 HTML。
// 服务端已做白名单重写（<img src> 和 SVG <image> 都改成
// /api/books/{id}/assets/{aid}），XSS 风险被服务端限制。

import { useEffect, useMemo, useRef, useState } from 'react';
// useNavigate: 编程式导航（返回详情页）；useParams: 从 URL 提取 bookId 和 chapterId
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { ReaderTopBar } from '../components/ReaderToolbar';
import { ReaderChapterEnd } from '../components/ReaderChapterEnd';
import { ReaderChapterHeader } from '../components/ReaderChapterHeader';
import { ReaderSettings } from '../components/ReaderSettings';
import { ReaderSidebar } from '../components/ReaderSidebar';
import { ReaderTocPanel } from '../components/ReaderTocPanel';
import { useBook, useChapter } from '../hooks/useBooks'; // 获取书籍元数据和章节内容
import {
  getChapterProgress,
  setChapterProgress,
} from '../hooks/useReaderProgress'; // localStorage 读写阅读进度
import { useReaderSettings } from '../hooks/useReaderSettings'; // 阅读器偏好设置 hook
import { FONTS, THEMES, type Theme } from '../lib/readerPrefs'; // 字体/主题的预设常量

// 工具栏切换通过方向判定：向下滚→隐藏；向上滚→显示。
// 隐藏后不再自动重新出现（避免停滚后工具栏突然跳出来妨碍阅读）。
// 右侧侧边栏（ReaderSidebar）不参与显隐，始终常驻。
const PROGRESS_SAVE_DEBOUNCE_MS = 1500; // 进度保存的防抖时间，避免频繁写入 localStorage
const SCROLL_DELTA_THRESHOLD = 4; // 滚动偏移量小于此值时忽略，防止细微抖动触发逻辑

export default function ReaderPage() {
  // useParams 泛型声明路由参数类型：/books/:bookId/chapters/:chapterId
  const { bookId = '', chapterId = '' } = useParams<{
    bookId: string;
    chapterId: string;
  }>();
  const navigate = useNavigate();

  const settings = useReaderSettings();      // 自定义 hook，管理字号/行高/主题/字体偏好
  const bookQuery = useBook(bookId);         // 获取书籍元数据（含章节目录）
  const chapterQuery = useChapter(bookId, chapterId, 'html'); // 获取指定章节的 HTML 内容

  // useRef 获取滚动容器的 DOM 引用，用于手动操作 scrollTop
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restored, setRestored] = useState(false); // 是否已经完成滚位置恢复
  const [liveProgress, setLiveProgress] = useState(0); // 当前实时滚动百分比
  const [tocOpen, setTocOpen] = useState(false);
  const tocJumpRef = useRef(false);
  // "夜间"切换：记录进入夜间前的主题，切回来时恢复
  const dayThemeRef = useRef<Theme>(settings.theme === 'dark' ? 'light' : settings.theme);

  // ---------- 计算 CSS 变量（设置变化时即时生效） ----------
  // useMemo 将阅读偏好映射为 CSS 自定义属性（--fs, --lh, --bg 等）
  const cssVars = useMemo<React.CSSProperties>(
    () => ({
      ['--fs' as string]: `${settings.fontSize}px`,
      ['--lh' as string]: String(settings.lineHeight),
      ['--bg' as string]: THEMES[settings.theme].bg,
      ['--fg' as string]: THEMES[settings.theme].fg,
      ['--font-family' as string]: FONTS[settings.font].family,
    }),
    [settings.fontSize, settings.lineHeight, settings.theme, settings.font],
  );

  // ---------- 章节序列定位（上下章） ----------
  // 从书籍数据中获取章节目录，按 spine_order（EPUB 中的阅读顺序）排序
  const chapters = bookQuery.data?.chapters ?? [];
  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.spine_order - b.spine_order),
    [chapters],
  );
  // 在排序后的章节列表中找到当前章节的索引，用于确定上一章/下一章
  const currentIndex = sortedChapters.findIndex((c) => c.id === chapterId);
  const currentChapterMeta =
    currentIndex >= 0 ? sortedChapters[currentIndex] : undefined;
  const prev = currentIndex > 0 ? sortedChapters[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < sortedChapters.length - 1
      ? sortedChapters[currentIndex + 1]
      : null;

  // 重要：因为后端 ChapterOut.id 可能包含 ".xhtml" 等含字符点，需要原样保留。
  // URL 跳转不做额外编码（react-router 会处理）。
  const prevHref = prev ? `/books/${bookId}/chapters/${encodeURIComponent(prev.id)}` : null;
  const nextHref = next ? `/books/${bookId}/chapters/${encodeURIComponent(next.id)}` : null;

  // 目录选中某章节：关闭面板 + 标记 toc 跳转 + 导航
  const handleTocSelect = (targetChapterId: string) => {
    tocJumpRef.current = true;
    setTocOpen(false);
    navigate(`/books/${bookId}/chapters/${encodeURIComponent(targetChapterId)}`);
  };

  // 夜间切换：亮/暗主题互切，并记住进入夜间前的主题
  const handleToggleNight = () => {
    if (settings.theme === 'dark') {
      settings.setTheme(dayThemeRef.current);
    } else {
      dayThemeRef.current = settings.theme;
      settings.setTheme('dark');
    }
  };

  // ---------- 滚位置恢复：进入章节后定位 ----------
  // useEffect：当章节内容加载完成后，从 localStorage 读取上次阅读位置并恢复滚动条
  useEffect(() => {
    if (!chapterQuery.data) return; // 内容未加载完，不执行
    const el = scrollRef.current;
    if (!el) return;
    const pct = getChapterProgress(bookId, chapterId); // 从 localStorage 读取进度百分比
    setRestored(false);
    // requestAnimationFrame 等浏览器完成一帧渲染（layout 计算），确保 scrollHeight 准确
    requestAnimationFrame(() => {
      if (!el) return;
      // 目录跳转：强制顶部落地，跳过滚位置恢复
      if (tocJumpRef.current) {
        el.scrollTop = 0;
        tocJumpRef.current = false;
      } else {
        const max = el.scrollHeight - el.clientHeight; // 可滚动的最大距离
        if (max > 0 && pct > 0 && pct < 1) {
          // 之前读到中间位置：按百分比还原 scrollTop
          el.scrollTop = Math.round(max * pct);
        } else if (pct >= 1) {
          // 之前已经读完了 — 直接置底
          el.scrollTop = el.scrollHeight;
        }
      }
      setRestored(true);
      // 初始化顶栏/右侧进度条的实时值
      const finalMax = el.scrollHeight - el.clientHeight;
      setLiveProgress(finalMax > 0 ? el.scrollTop / finalMax : 0);
    });
  }, [bookId, chapterId, chapterQuery.data]); // 依赖数组：这三个值变化时重新执行

  // ---------- 滚位置保存 + 工具栏显隐（wheel + scroll 协同） ----------
  // 这是阅读器最复杂的副作用：同时处理 3 件事
  // 1. 根据滚动方向显示/隐藏顶栏（向上滚显示，向下滚隐藏）
  // 2. 将阅读进度 debounce 保存到 localStorage
  // 3. 实时更新进度百分比
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let lastY = el.scrollTop;          // 记录上次 scrollTop，用于计算 scroll 方向
    let progressTimer: number | undefined;  // 进度保存的 debounce 定时器
    let toolbarTimer: number | undefined;   // 工具栏自动显示的延迟定时器
    // 累计 wheel deltaY，超过阈值才认定为"用户在主动滚动"，
    // 避免滚轮微动一格就频繁触发工具栏显隐。
    let wheelDeltaAcc = 0;
    let wheelWindowTimer: number | undefined;
    const WHEEL_ACC_THRESHOLD = 10;   // 累计 deltaY 超过此值才触发方向判定
    const WHEEL_WINDOW_MS = 200;      // 累计窗口时间（毫秒），超时重置

    // showToolbar: 立即显示工具栏并清除待执行的隐藏定时器
    const showToolbar = () => {
      setToolbarVisible(true);
      clearTimeout(toolbarTimer);
    };
    // hideToolbar: 隐藏顶栏（不再自动重新出现）。
    const hideToolbar = () => {
      setToolbarVisible(false);
      clearTimeout(toolbarTimer);
    };

    const updateLiveProgress = () => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) {
        setLiveProgress(0);
        return;
      }
      setLiveProgress(el.scrollTop / max);
    };

    // onWheel: 鼠标滚轮/触控板手势事件处理器
    // 绑在 window 上而非 el：滚轮发生在工具栏/侧边栏覆盖区时也要响应
    const onWheel = (e: WheelEvent) => {
      // deltaY > 0 表示滚轮向下（内容上移），deltaY < 0 表示滚轮向上（内容下移）
      const dir = e.deltaY;
      if (dir === 0) return;

      // 累计策略：微小的 deltaY 不立即触发，而是在时间窗口内累加
      // 这样触控板的微小抖动不会导致工具栏频繁闪动
      const before = wheelDeltaAcc;
      wheelDeltaAcc += dir;
      if (Math.abs(wheelDeltaAcc) < WHEEL_ACC_THRESHOLD) {
        // 还没达到阈值，设置超时重置累计值
        clearTimeout(wheelWindowTimer);
        wheelWindowTimer = window.setTimeout(
          () => {
            wheelDeltaAcc = 0;
          },
          WHEEL_WINDOW_MS,
        );
        void before; // void 消除 ESLint no-unused-vars 警告
        return;
      }

      // 达到阈值，消费并重置累计值
      wheelDeltaAcc = 0;
      clearTimeout(wheelWindowTimer);

      const max = el.scrollHeight - el.clientHeight;
      const cur = el.scrollTop;
      const atBottom = max > 0 && cur >= max - SCROLL_DELTA_THRESHOLD; // 是否已到底部

      if (atBottom) {
        showToolbar();
      } else if (dir > 0) {
        // 滚轮向下滑（deltaY > 0 = 内容上移）→ 隐藏
        hideToolbar();
      } else {
        // 滚轮向上滑（deltaY < 0 = 内容下移）→ 显示
        showToolbar();
      }
    };

    // onScroll: 滚动事件处理器，处理所有导致滚动的输入（触控板惯性、键盘、触摸等）
    const onScroll = () => {
      const cur = el.scrollTop;
      const delta = cur - lastY; // 正值=向下滚动，负值=向上滚动
      if (Math.abs(delta) < SCROLL_DELTA_THRESHOLD) return; // 忽略微小抖动
      lastY = cur;

      const max = el.scrollHeight - el.clientHeight;
      const atBottom = max > 0 && cur >= max - SCROLL_DELTA_THRESHOLD;

      // 触控板惯性滚动、键盘 PageDown 等场景不一定经过 wheel 事件
      // 所以 scroll 事件也要独立判断方向来控制工具栏
      if (atBottom || cur === 0) {
        // 到底或到顶：强制显示工具栏，方便用户返回详情
        showToolbar();
      } else if (delta > 0) {
        // scrollTop 增加 = 向下滚动 = 隐藏工具栏（让阅读空间更大）
        hideToolbar();
      } else {
        // scrollTop 减小 = 向上滚动 = 显示工具栏
        showToolbar();
      }

      // 滚动进度：debounce 保存到 localStorage，避免高频写入
      clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => {
        const max2 = el.scrollHeight - el.clientHeight;
        if (max2 <= 0) return;
        // Math.max(0, Math.min(1, ...)) 将值限制在 [0, 1] 范围内
        const pct = Math.max(0, Math.min(1, el.scrollTop / max2));
        setChapterProgress(bookId, chapterId, pct);
      }, PROGRESS_SAVE_DEBOUNCE_MS);

      updateLiveProgress(); // 实时更新进度显示
    };

    // 注册事件监听器；{ passive: true } 告诉浏览器不会调用 preventDefault，允许优化滚动性能
    window.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    // useEffect 的清理函数：组件卸载或依赖变化时移除监听器和清除定时器，防止内存泄漏
    return () => {
      window.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      clearTimeout(progressTimer);
      clearTimeout(toolbarTimer);
      clearTimeout(wheelWindowTimer);
    };
  }, [bookId, chapterId, chapterQuery.data]);

  // ---------- 正文内首个标题去重 ----------
  // 有些章节 HTML 正文以标题开头（如导出 EPUB 时注入的 <h3>，或原书自带标题），
  // 内容与章节标题一致时隐藏它，避免与上方章节头部标题重复显示。
  // 放在 useEffect 而非 onLoad：没有图片的章节不会触发 load 事件。
  useEffect(() => {
    if (!chapterQuery.data) return;
    const root = scrollRef.current?.querySelector('article.scroll-article');
    if (!root) return;
    const norm = (s: string) => s.replace(/\s+/g, '');
    const heading = root.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading && norm(heading.textContent ?? '') === norm(chapter.title)) {
      (heading as HTMLElement).style.display = 'none';
    }
  }, [chapterId, chapterQuery.data]);

  // ---------- 加载 / 错误状态 ----------
  // 阅读器使用全屏 fixed 布局，加载态和错误态也用 fixed inset-0 占满屏幕
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

  // 计算进度标签，如 "3 / 12" 表示第 3 章共 12 章
  const chapter = chapterQuery.data;
  const progressLabel =
    currentIndex >= 0 ? `${currentIndex + 1} / ${sortedChapters.length}` : '';
  const progressPct = restored ? liveProgress : 0;

  return (
    // cssVars 作为 inline style 传入根 div，子元素通过 var(--fs) 等引用
    <div
      style={{ ...cssVars, backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      className="fixed inset-0 overflow-hidden"
    >
      {/* 顶栏：滚动到底/向上滚时出现；返回详情 + 书名 + 进度；窄屏含 目录/设置 入口 */}
      <ReaderTopBar
        bookId={bookId}
        bookTitle={bookQuery.data?.title ?? ''}
        chapterIndexLabel={progressLabel}
        progressPercent={progressPct}
        visible={toolbarVisible}
        onTocOpen={() => setTocOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />

      {/* 顶部细进度条（常驻，2px 高亮当前章节阅读进度） */}
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 right-0 z-10 h-0.5 bg-current opacity-10"
      >
        <div
          className="h-full bg-current opacity-60 transition-[width] duration-150"
          style={{ width: `${Math.round(progressPct * 100)}%` }}
        />
      </div>

      {/* 正文滚动容器：absolute inset-0 占满父级，py-20 给顶/底留出空间 */}
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-auto py-20 px-6"
        style={{ backgroundColor: 'var(--bg)' }}
        aria-label="章节正文"
      >
        {/* max-w-[680px] 限制行宽提升可读性 */}
        <div className="mx-auto max-w-[680px]">
          {/* 章节头部：大标题 + 书名/作者/字数/时间（随正文滚动） */}
          <ReaderChapterHeader
            title={chapter.title}
            bookTitle={bookQuery.data?.title ?? ''}
            bookHref={`/books/${bookId}`}
            authors={bookQuery.data?.authors ?? []}
            wordCount={currentChapterMeta?.word_count ?? 0}
            date={bookQuery.data?.created_at ?? ''}
          />

          {/* 正文：scroll-article 应用净化排版 */}
          <article
            className="scroll-article"
            style={{
              fontSize: 'var(--fs)',
              lineHeight: 'var(--lh)',
              fontFamily: 'var(--font-family)',
            }}
            // dangerouslySetInnerHTML：将服务端返回的 HTML 字符串直接插入 DOM
            // 这是 React 中渲染富文本的唯一方式；XSS 风险由服务端白名单重写控制（见文件头注释）
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: chapter.content }}
            // onLoad 在 article 及其子元素的资源加载完成时触发
            onLoad={(e) => {
              const root = e.currentTarget;
              // 遍历章节内所有 <img> 标签，设置自适应样式防止图片撑爆容器
              root.querySelectorAll('img').forEach((img) => {
                (img as HTMLElement).style.maxWidth = '100%';
                (img as HTMLElement).style.height = 'auto';
                (img as HTMLElement).style.display = 'block';
                (img as HTMLElement).style.margin = '1em auto';
                (img as HTMLElement).style.borderRadius = '4px';
              });
            }}
          />

          {/* 章节末尾：本章完 + 上一章 | 目录 | 下一章 */}
          <ReaderChapterEnd
            prevHref={prevHref}
            nextHref={nextHref}
            onTocOpen={() => setTocOpen(true)}
          />
        </div>
      </div>

      {/* 右侧常驻工具栏：目录/书详情/书架/夜间/设置/返回顶部 */}
      <ReaderSidebar
        bookId={bookId}
        theme={settings.theme}
        onTocOpen={() => setTocOpen(true)}
        onSettingsOpen={() => setSettingsOpen(true)}
        onToggleNight={handleToggleNight}
        onBackToTop={() =>
          scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
        }
      />

      {/* 正文滚动进度竖条（宽屏才显示，位于正文列右侧、侧边栏左侧） */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-[calc(50%+360px)] z-10 hidden w-[3px] overflow-hidden rounded-full bg-current opacity-10 xl:block"
      >
        <div
          className="w-full bg-current opacity-40 transition-[height] duration-150"
          style={{ height: `${Math.round(progressPct * 100)}%` }}
        />
      </div>

      {/* 目录面板（滑出式侧边面板）：受控于 tocOpen；onChapterSelect 标记 toc 跳转短路恢复逻辑 */}
      <ReaderTocPanel
        open={tocOpen}
        bookId={bookId}
        chapters={sortedChapters}
        currentChapterId={chapterId}
        onClose={() => setTocOpen(false)}
        onChapterSelect={handleTocSelect}
      />

      {/* 设置面板（滑出式侧边面板）：open 控制显隐，各 onXxxChange 回调由 useReaderSettings 提供 */}
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
