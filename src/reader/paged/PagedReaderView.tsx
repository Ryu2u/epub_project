// PagedReaderView —— 分页模式视图(≈ BookReader 的 BaseReadView 装配)。
//
// 分层:
//   stage(页面舞台:当前页/被揭示页,左右平移翻页)
//     ← gestures(指针状态机)
//     ← SlideFlip(平移/覆盖/无动画)
//     ← usePaginator(分页引擎:测量/切片/锚点)
//   measurer(离屏测量容器,与页面共用 .paged-article + 同一内联宽度)
//
// 章节边界:章末向前翻 → 无翻页目标 → 点击/键盘触发 onNavigateChapter;
// 预取邻章(React Query)让跨章基本零等待。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChapter } from '../../hooks/useBooks';
import { apiGet } from '../../api/client';
import type { ChapterContent, ChapterOut } from '../../api/types';
import type { FlipHost } from './flip/FlipStrategy';
import { SlideFlip } from './flip/SlideFlip';
import { attachGestures } from './gestures';
import { savePagedProgress } from './pagedProgress';
import type { FlipStyle, LayoutParams } from './types';
import { usePaginator } from './usePaginator';

export interface PagedReaderViewProps {
  bookId: string;
  /** 路由章节 id(TOC/外部跳转时变化 → 内部同步切换) */
  routeChapterId: string;
  /** 按 spine_order 排序的章节元数据 */
  chapters: ChapterOut[];
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  theme: { bg: string; fg: string };
  flipStyle: FlipStyle;
  onCenterClick: () => void;
  onNavigateChapter: (chapterId: string) => void;
}

// 页面内边距(内容区 = 舞台 − 这些值;测量容器同宽)
const PAD_X = 30;
const PAD_T = 26;
const PAD_B = 36;
const HEAD_H = 40;
const FOOT_H = 34;
const STAGE_MAX_W = 880;
const STAGE_MIN_W = 280;
const STAGE_MIN_H = 320;
const SAVE_DEBOUNCE_MS = 500;
const FLIP_DURATION: Record<FlipStyle, number> = {
  slide: 260, // 平移(默认,左右轮播式滑动)
  cover: 320, // 覆盖(新页滑入盖住当前页)
  none: 0, // 瞬翻
};

export function PagedReaderView(props: PagedReaderViewProps) {
  const {
    bookId,
    routeChapterId,
    chapters,
    fontSize,
    lineHeight,
    fontFamily,
    theme,
    flipStyle,
    onCenterClick,
    onNavigateChapter,
  } = props;

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const curPageRef = useRef<HTMLDivElement>(null);
  const nextPageRef = useRef<HTMLDivElement>(null);
  const measurerRef = useRef<HTMLDivElement>(null);

  // ---------- 章节状态(内部持有,路由变化时同步) ----------
  const [activeChapterId, setActiveChapterId] = useState(routeChapterId);
  useEffect(() => {
    setActiveChapterId((cur) => (cur === routeChapterId ? cur : routeChapterId));
  }, [routeChapterId]);

  const chapterQuery = useChapter(bookId, activeChapterId, 'html');
  const html = chapterQuery.data?.content;

  const sortedChapters = useMemo(
    () => [...chapters].sort((a, b) => a.spine_order - b.spine_order),
    [chapters],
  );
  const chapterIdx = sortedChapters.findIndex((c) => c.id === activeChapterId);
  const prevMeta = chapterIdx > 0 ? sortedChapters[chapterIdx - 1] : null;
  const nextMeta =
    chapterIdx >= 0 && chapterIdx < sortedChapters.length - 1
      ? sortedChapters[chapterIdx + 1]
      : null;

  // 邻章预取(≈ BookReader 的 chapter±3 预缓存;Web 端 HTML 较大先 ±1)
  const queryClient = useQueryClient();
  useEffect(() => {
    for (const n of [prevMeta, nextMeta]) {
      if (!n) continue;
      void queryClient.prefetchQuery({
        queryKey: ['chapter', bookId, n.id, 'html'],
        queryFn: () =>
          apiGet<ChapterContent>(`/api/books/${bookId}/chapters/${n.id}?format=html`),
        staleTime: 60_000,
      });
    }
  }, [bookId, prevMeta, nextMeta, queryClient]);

  // ---------- 舞台尺寸(整数,测量与渲染共用) ----------
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let timer: number | undefined;
    const measure = () => {
      // clientWidth 为 0 时回退窗口尺寸(初始化早期/测试环境)
      const vw = Math.floor(vp.clientWidth || window.innerWidth || 0);
      const vh = Math.floor(vp.clientHeight || window.innerHeight || 0);
      if (vw <= 0 || vh <= 0) return;
      const w = Math.max(STAGE_MIN_W, Math.min(vw - 48, STAGE_MAX_W));
      const h = Math.max(STAGE_MIN_H, vh - HEAD_H - FOOT_H - 16);
      setStageSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return; // 环境无 RO:仅初始测量兜底
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 200); // resize 防抖(重排代价高)
    });
    ro.observe(vp);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const params: LayoutParams | null = useMemo(() => {
    if (!stageSize) return null;
    return {
      width: Math.max(160, stageSize.w - PAD_X * 2),
      height: Math.max(200, stageSize.h - PAD_T - PAD_B),
      fontSize,
      lineHeight,
      fontFamily,
    };
  }, [stageSize, fontSize, lineHeight, fontFamily]);

  const paramsKey = params
    ? `${params.width}x${params.height}@${fontSize}/${lineHeight}/${fontFamily}`
    : '';

  const paginator = usePaginator({
    bookId,
    chapterId: activeChapterId,
    html,
    params: params ?? { width: 0, height: 0, fontSize, lineHeight, fontFamily },
    measurerRef,
  });
  const { status, pageIndex, pageCount, setPageIndex, renderPage, currentSlice } = paginator;

  // ---------- 翻页策略(平移/覆盖/无动画) ----------
  const flipRef = useRef<SlideFlip | null>(null);
  const dirRef = useRef<1 | -1>(1);
  const pageIndexRef = useRef(pageIndex);
  const pageCountRef = useRef(pageCount);

  useEffect(() => {
    pageIndexRef.current = pageIndex;
    pageCountRef.current = pageCount;
  }, [pageIndex, pageCount]);

  const hostRef = useRef<FlipHost | null>(null);
  if (hostRef.current === null) {
    // host 为可变对象:宽高/时长由后续 effect 更新,元素经 getter 实时读取
    hostRef.current = {
      width: 0,
      height: 0,
      durationMs: FLIP_DURATION[flipStyle],
      get curPage() {
        return curPageRef.current as HTMLElement;
      },
      get nextPage() {
        return nextPageRef.current as HTMLElement;
      },
    };
  }
  // 尺寸/风格变化同步 host 与策略实例
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !stageSize) return;
    host.width = stageSize.w;
    host.height = stageSize.h;
    host.durationMs = FLIP_DURATION[flipStyle];
    flipRef.current?.cancelNow();
    flipRef.current = new SlideFlip(
      host,
      { onSettled: handleSettledRef.current },
      flipStyle === 'cover' ? 'cover' : 'slide',
    );
  }, [stageSize, flipStyle]);

  const handleSettledRef = useRef<(completed: boolean) => void>(() => undefined);
  handleSettledRef.current = (completed: boolean) => {
    if (!completed) return;
    const target = pageIndexRef.current + dirRef.current;
    const cur = curPageRef.current;
    if (target >= 0 && target < pageCountRef.current && cur) {
      // 原子交接(同一同步块内完成,浏览器只在块结束后绘制,
      // 旧页文字不会露出 —— 修复「翻页完成闪一下上个页面」):
      // 1) 新页此刻仍盖在最终位置(next 可见);
      //    把目标页内容写进 cur —— cover 模式在 next 之下,
      //    slide 模式 cur 还平移在屏幕外,变化都不可见
      const frag = renderPage(target);
      if (frag) cur.replaceChildren(frag);
      cur.style.transform = '';
      cur.style.boxShadow = '';
      // 2) 同步页码 ref:防止动画结束后立刻起新手势读到旧值
      pageIndexRef.current = target;
      // 3) 复位并隐藏垫底的 next(清变换/z-index)
      flipRef.current?.cleanup();
      // 4) React 状态同步:页面渲染 effect 会幂等地重写同样内容
      setPageIndex(target);
    } else {
      flipRef.current?.cleanup();
    }
  };

  // 卸载清理
  useEffect(() => {
    return () => flipRef.current?.cancelNow();
  }, []);

  // ---------- 翻页入口(手势 + 键盘共用) ----------
  const beginFlip = useCallback(
    (dir: 1 | -1, x: number, y: number): boolean => {
      const target = pageIndexRef.current + dir;
      if (target < 0 || target >= pageCountRef.current) return false;
      // 填充被揭示页(克隆+裁剪,小 DOM 操作,同步即可)
      const el = nextPageRef.current;
      const frag = renderPage(target);
      if (el && frag) {
        el.replaceChildren(frag);
        dirRef.current = dir;
        return flipRef.current?.begin(dir, x, y) ?? false;
      }
      return false;
    },
    [renderPage],
  );

  const handleBoundaryTap = useCallback(
    (dir: 1 | -1) => {
      const target = dir === 1 ? nextMeta : prevMeta;
      if (target) onNavigateChapter(target.id);
    },
    [nextMeta, prevMeta, onNavigateChapter],
  );

  // 手势挂载(stage 上:点击区域/中央区按舞台计算)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    return attachGestures(stage, {
      getWidth: () => hostRef.current?.width ?? stage.clientWidth,
      getHeight: () => hostRef.current?.height ?? stage.clientHeight,
      onCenterClick,
      onFlipStart: (dir, x, y) => beginFlip(dir, x, y),
      onFlipMove: (x, y) => flipRef.current?.update(x, y),
      onFlipEnd: (cancel) => {
        if (cancel) flipRef.current?.restore();
        else flipRef.current?.finish();
      },
      onBoundaryTap: handleBoundaryTap,
    });
  }, [beginFlip, onCenterClick, handleBoundaryTap]);

  // 键盘(≈ Android 音量键翻页的桌面等价物)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const go = (dir: 1 | -1) => {
        e.preventDefault();
        const x = rect.left + rect.width * (dir === 1 ? 0.72 : 0.28);
        const y = rect.top + rect.height * 0.75;
        if (!beginFlip(dir, x, y)) handleBoundaryTap(dir);
        else flipRef.current?.finish(); // 键盘=自动完成翻页(none 风格 0ms 瞬翻)
      };
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'Home') {
        e.preventDefault();
        setPageIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setPageIndex(Math.max(0, pageCountRef.current - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [beginFlip, handleBoundaryTap, setPageIndex]);

  // ---------- 页面渲染(当前页 + 前视揭示页) ----------
  useEffect(() => {
    const cur = curPageRef.current;
    if (!cur) return;
    const frag = status === 'ready' ? renderPage(pageIndex) : null;
    if (frag) cur.replaceChildren(frag);
    else cur.replaceChildren();
    // 复位翻页残留样式(模式切换/跳页后)
    cur.style.transform = '';
    cur.style.boxShadow = '';
    const next = nextPageRef.current;
    if (next) {
      next.style.transform = '';
      next.style.boxShadow = '';
      next.style.zIndex = '';
      next.style.visibility = 'hidden';
      const nextFrag = renderPage(pageIndex + 1);
      if (nextFrag) next.replaceChildren(nextFrag);
      else next.replaceChildren();
    }
  }, [status, pageIndex, renderPage, paginator.sourceVersion]);

  // ---------- 进度保存(翻页落定后防抖;修正原版逐帧落盘的高频写) ----------
  // 最新落盘载荷走 ref:卸载 flush 的 effect 依赖 [] 不闭包过期值
  const latestSaveRef = useRef<{
    chapterId: string;
    anchor: NonNullable<typeof currentSlice>['start'];
    pageIndex: number;
  } | null>(null);
  useEffect(() => {
    if (status !== 'ready' || !currentSlice) {
      latestSaveRef.current = null;
      return;
    }
    latestSaveRef.current = {
      chapterId: activeChapterId,
      anchor: currentSlice.start,
      pageIndex,
    };
    const timer = window.setTimeout(() => {
      const latest = latestSaveRef.current;
      if (latest) {
        savePagedProgress(bookId, { ...latest, paramsHash: paramsKey });
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [bookId, activeChapterId, status, currentSlice, pageIndex, paramsKey]);

  // 卸载时立即落盘(读 ref,避免过期闭包)
  useEffect(() => {
    return () => {
      const latest = latestSaveRef.current;
      if (latest) {
        savePagedProgress(bookId, {
          chapterId: latest.chapterId,
          anchor: latest.anchor,
          pageIndex: latest.pageIndex,
          paramsHash: paramsKey,
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 渲染 ----------
  const chapterTitle = chapterQuery.data?.title ?? '';
  const measuring = status === 'measuring' || !stageSize;
  const chapterLabel =
    chapterIdx >= 0 ? `${chapterIdx + 1} / ${sortedChapters.length}` : '';
  const pageLabel = pageCount > 0 ? `${pageIndex + 1} / ${pageCount}` : '';
  const inChapterPct =
    pageCount > 0 ? Math.round(((pageIndex + 1) / pageCount) * 100) : 0;

  return (
    <div
      ref={viewportRef}
      className="paged-viewport"
      style={{ backgroundColor: theme.bg, color: theme.fg }}
    >
      <div className="paged-head">
        <span className="truncate">{chapterTitle}</span>
        <span className="paged-head-meta opacity-60">{chapterLabel}</span>
      </div>
      <div className="paged-stage-wrap">
        {stageSize && (
          <div
            ref={stageRef}
            className="paged-stage"
            style={{ width: stageSize.w, height: stageSize.h }}
            aria-label="分页正文"
          >
            <div ref={nextPageRef} className="paged-article paged-page paged-page-next" />
            <div ref={curPageRef} className="paged-article paged-page paged-page-cur" />
            {measuring && (
              <div className="paged-loading">
                <span className="paged-loading-dot" />
                排版中…
              </div>
            )}
            {!measuring && pageCount === 0 && (
              <div className="paged-loading">本章无内容</div>
            )}
          </div>
        )}
      </div>
      <div className="paged-foot">
        <span className="opacity-60">{pageLabel}</span>
        <span className="opacity-60">本章 {inChapterPct}%</span>
      </div>
      {/* 离屏测量容器:与页面同 CSS 变量树 + 同内联宽度,「测量=渲染」 */}
      <div
        ref={measurerRef}
        className="paged-article paged-measurer"
        style={params ? { width: params.width } : undefined}
        aria-hidden="true"
      />
    </div>
  );
}
