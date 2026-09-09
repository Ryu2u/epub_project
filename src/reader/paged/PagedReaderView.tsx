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
import { findPageForBoundary } from './anchor';
import type { FlipHost } from './flip/FlipStrategy';
import { SlideFlip } from './flip/SlideFlip';
import { attachGestures } from './gestures';
import { measureChapter } from './measureChapter';
import { readChapterAnchor, savePagedProgress } from './pagedProgress';
import { renderSlice } from './paginator';
import type { Boundary, FlipStyle, LayoutParams, PageSlice } from './types';
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

/** 邻章预分页结果(跨章翻页的预备内容)。 */
interface NeighborInfo {
  chapterId: string;
  sourceRoot: HTMLDivElement;
  slices: PageSlice[];
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
  // 邻章预分页专用测量容器(与本章容器分离,互不干扰)
  const neighborMeasurerRef = useRef<HTMLDivElement>(null);

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
  // 切换过渡期(章节 id 已变、切片还是旧章的):一切持久化暂停
  const chapterInTransition = paginator.readyChapterId !== activeChapterId;

  // ---------- 翻页策略(平移/覆盖/无动画) ----------
  const flipRef = useRef<SlideFlip | null>(null);
  const dirRef = useRef<1 | -1>(1);
  const pageIndexRef = useRef(pageIndex);
  const pageCountRef = useRef(pageCount);
  // 跨章翻页:目标章节 id + 落地锚点(begin 时计算,settle 时消费)
  const crossChapterRef = useRef<string | null>(null);
  const crossLandingRef = useRef<{ anchor: Boundary; pageIndex: number } | null>(null);
  // 邻章预分页结果(空闲时准备,跨章翻页的"被揭示页"内容来源)
  const neighborsRef = useRef<{ next: NeighborInfo | null; prev: NeighborInfo | null }>({
    next: null,
    prev: null,
  });

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
      // 关键:必须传「调用时转发」而不是 handleSettledRef.current 的当前值 ——
      // 策略实例只在 stageSize/flipStyle 变化时重建,若钉死构造时的旧闭包
      // (彼时 slices 尚为空,renderPage 恒返回 null),原子交接会静默失效,
      // 退回 post-paint 换内容 → 旧页闪现(实测第二轮「还是会闪」的根因)
      { onSettled: (completed) => handleSettledRef.current(completed) },
      flipStyle === 'cover' ? 'cover' : 'slide',
    );
  }, [stageSize, flipStyle]);

  const handleSettledRef = useRef<(completed: boolean) => void>(() => undefined);
  handleSettledRef.current = (completed: boolean) => {
    if (!completed) {
      // 回弹:跨章状态作废(下次 beginFlip 重新计算)
      crossChapterRef.current = null;
      crossLandingRef.current = null;
      return;
    }
    const crossId = crossChapterRef.current;
    const cur = curPageRef.current;
    const next = nextPageRef.current;

    // ---- 跨章落定:邻章目标页已滑到位,原子交接后导航 ----
    if (crossId) {
      crossChapterRef.current = null;
      if (cur && next) {
        // 同一同步块内把 next(邻章目标页)内容搬进 cur,浏览器
        // 只在块结束后绘制,不产生中间帧
        cur.replaceChildren(...Array.from(next.childNodes));
        cur.style.transform = '';
        cur.style.boxShadow = '';
      }
      flipRef.current?.cleanup();
      const landing = crossLandingRef.current;
      crossLandingRef.current = null;
      pageIndexRef.current = landing?.pageIndex ?? 0;
      // 落地锚点先落盘:paginator 章节切换恢复时 readSavedAnchor 命中它,
      // 保证「落地页 == 翻页预览页」(不受旧 recent 影响)
      if (landing) {
        savePagedProgress(bookId, {
          chapterId: crossId,
          anchor: landing.anchor,
          pageIndex: landing.pageIndex,
          paramsHash: paramsKey,
        });
      }
      onNavigateChapter(crossId);
      return;
    }

    // ---- 章内落定 ----
    const target = pageIndexRef.current + dirRef.current;
    if (target >= 0 && target < pageCountRef.current && cur) {
      const frag = renderPage(target);
      if (frag) {
        // 原子交接(同一同步块内完成,浏览器只在块结束后绘制,
        // 旧页文字不会露出):新页此刻仍盖在最终位置(next 可见),
        // 把目标页内容写进 cur —— cover 模式在 next 之下、
        // slide 模式 cur 还平移在屏幕外,变化都不可见
        cur.replaceChildren(frag);
        cur.style.transform = '';
        cur.style.boxShadow = '';
        // 同步页码 ref:防止动画结束后立刻起新手势读到旧值
        pageIndexRef.current = target;
        // 复位并隐藏垫底的 next(清变换/z-index)
        flipRef.current?.cleanup();
        // React 状态同步:页面渲染 effect 幂等地重写同样内容
        setPageIndex(target);
        return;
      }
    }
    // 异常兜底(无切片/无元素):交给 React effect 换内容
    flipRef.current?.cleanup();
    if (target >= 0 && target < pageCountRef.current) setPageIndex(target);
  };

  // 卸载清理
  useEffect(() => {
    return () => flipRef.current?.cancelNow();
  }, []);

  // ---------- 跨章翻页:邻章预分页(空闲时) ----------
  useEffect(() => {
    neighborsRef.current = { next: null, prev: null };
    if (status !== 'ready' || !params) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void (async () => {
        const jobs: Array<[1 | -1, ChapterOut | null]> = [
          [1, nextMeta],
          [-1, prevMeta],
        ];
        for (const [dir, meta] of jobs) {
          if (cancelled || !meta || !params) continue;
          const measurer = neighborMeasurerRef.current;
          if (!measurer) continue;
          const data = queryClient.getQueryData<ChapterContent>([
            'chapter',
            bookId,
            meta.id,
            'html',
          ]);
          if (!data?.content) continue; // html 未预取到:该方向回落点击直跳
          try {
            const res = await measureChapter(data.content, meta.id, params, measurer, {
              isCancelled: () => cancelled,
            });
            if (cancelled || !res) continue;
            neighborsRef.current[dir === 1 ? 'next' : 'prev'] = {
              chapterId: meta.id,
              sourceRoot: res.sourceRoot,
              slices: res.slices,
            };
          } catch {
            /* 邻章准备失败:该方向跨章翻页回落直跳 */
          }
        }
      })();
    };
    let cancelSchedule: () => void;
    if (typeof requestIdleCallback === 'function') {
      const h = requestIdleCallback(run);
      cancelSchedule = () => cancelIdleCallback(h);
    } else {
      const h = window.setTimeout(run, 300);
      cancelSchedule = () => window.clearTimeout(h);
    }
    return () => {
      cancelled = true;
      cancelSchedule();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, paramsKey, activeChapterId, nextMeta?.id, prevMeta?.id, queryClient]);

  /** 邻章目标页渲染:前进=保存锚点页或第 0 页;后退=保存锚点页或末页。 */
  const renderNeighborTarget = useCallback(
    (dir: 1 | -1): { chapterId: string; frag: Element; slice: PageSlice; pageIndex: number } | null => {
      const n = dir === 1 ? neighborsRef.current.next : neighborsRef.current.prev;
      if (!n || n.slices.length === 0) return null;
      const saved = readChapterAnchor(bookId, n.chapterId);
      const idx = Math.min(
        saved
          ? findPageForBoundary(n.sourceRoot, n.slices, saved.anchor)
          : dir === 1
            ? 0
            : n.slices.length - 1,
        n.slices.length - 1,
      );
      const slice = n.slices[idx];
      if (!slice) return null;
      try {
        return {
          chapterId: n.chapterId,
          frag: renderSlice(n.sourceRoot, slice),
          slice,
          pageIndex: idx,
        };
      } catch {
        return null;
      }
    },
    [bookId],
  );

  // ---------- 翻页入口(手势 + 键盘共用) ----------
  const beginFlip = useCallback(
    (dir: 1 | -1, x: number, y: number): boolean => {
      crossChapterRef.current = null;
      crossLandingRef.current = null;
      const el = nextPageRef.current;
      if (!el) return false;
      const target = pageIndexRef.current + dir;
      if (target >= 0 && target < pageCountRef.current) {
        // 章内:填充被揭示页(克隆+裁剪,小 DOM 操作,同步即可)
        const frag = renderPage(target);
        if (frag) {
          el.replaceChildren(frag);
          dirRef.current = dir;
          return flipRef.current?.begin(dir, x, y) ?? false;
        }
        return false;
      }
      // 章边界:邻章就绪 → 平滑跨章翻页(与章内同一条动画路径)
      const neighbor = renderNeighborTarget(dir);
      if (neighbor) {
        el.replaceChildren(neighbor.frag);
        dirRef.current = dir;
        crossChapterRef.current = neighbor.chapterId;
        crossLandingRef.current = { anchor: neighbor.slice.start, pageIndex: neighbor.pageIndex };
        return flipRef.current?.begin(dir, x, y) ?? false;
      }
      return false; // 邻章未就绪/书末:手势无效,点击走 boundary tap 直跳
    },
    [renderPage, renderNeighborTarget],
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
    if (status !== 'ready' || !currentSlice || chapterInTransition) {
      // 过渡期不得把「新章节 id + 旧章节锚点」混存(锚点会被错误
      // 夹进新章节的树,跨章翻回时落在错误页 —— 实测 bug)
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
  }, [bookId, activeChapterId, status, currentSlice, pageIndex, paramsKey, chapterInTransition]);

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
      {/* 邻章预分页测量容器(空闲时复用,与本章容器分离) */}
      <div ref={neighborMeasurerRef} className="paged-article paged-measurer" aria-hidden="true" />
    </div>
  );
}
