// usePaginator —— 分页调度 hook(≈ BookReader ReadActivity 的章节装配 +
// PageFactory 的 openBook/pageDown 状态机)。
//
// 职责:
//   html → 离屏测量 → PageSlice[](带 LRU 缓存)→ 页导航/锚点恢复
//   - 章节变化:恢复 localStorage 里保存的锚点(无则页首)
//   - 排版参数变化(字号/行高/字体/尺寸):以当前页 start 锚点保位重排
//   - 长章节分页按帧让出主线程,UI 不卡

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findPageForBoundary } from './anchor';
import {
  cacheKey,
  createBrowserGeometry,
  getCachedSlices,
  paginate,
  renderSlice,
  setCachedSlices,
} from './paginator';
import type { Boundary, LayoutParams, PageSlice } from './types';
import { readChapterAnchor } from './pagedProgress';

export type PaginatorStatus = 'idle' | 'measuring' | 'ready';

/** 等待测量容器内图片完成(布局稳定前提);总超时兜底。 */
function waitForImages(el: HTMLElement, timeoutMs: number): Promise<void> {
  const imgs = Array.from(el.querySelectorAll('img'));
  if (imgs.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = imgs.length;
    const done = () => resolve();
    const timer = window.setTimeout(done, timeoutMs);
    const dec = () => {
      pending -= 1;
      if (pending <= 0) {
        window.clearTimeout(timer);
        done();
      }
    };
    for (const img of imgs) {
      if (img.complete) dec();
      else {
        img.addEventListener('load', dec, { once: true });
        img.addEventListener('error', dec, { once: true });
      }
    }
  });
}

/** 读取本书保存的分页进度锚点(章节匹配才有)。 */
export function readSavedAnchor(
  bookId: string,
  chapterId: string,
): Boundary | null {
  return readChapterAnchor(bookId, chapterId)?.anchor ?? null;
}

export interface UsePaginatorArgs {
  bookId: string;
  chapterId: string;
  html: string | undefined;
  params: LayoutParams;
  /** 离屏测量容器(挂载在阅读器树内,继承全部排版 CSS 变量)。 */
  measurerRef: React.RefObject<HTMLDivElement | null>;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function usePaginator({
  bookId,
  chapterId,
  html,
  params,
  measurerRef,
}: UsePaginatorArgs) {
  const [status, setStatus] = useState<PaginatorStatus>('idle');
  const [slices, setSlices] = useState<PageSlice[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  /** 源树版本号:html 变化时自增,驱动页面重渲染 effect。 */
  const [sourceVersion, setSourceVersion] = useState(0);
  const sourceRootRef = useRef<HTMLDivElement | null>(null);
  /** 当前页 start 锚点(排版参数变化时保位用)。 */
  const lastAnchorRef = useRef<Boundary | null>(null);
  const prevChapterRef = useRef<string>(chapterId);
  // 帧让出:每 16 页让出一帧
  const paramsKey = useMemo(
    () => `${params.width}x${params.height}@${params.fontSize}/${params.lineHeight}/${params.fontFamily}`,
    [params.width, params.height, params.fontSize, params.lineHeight, params.fontFamily],
  );

  useEffect(() => {
    if (!html) {
      setStatus('idle');
      setSlices([]);
      return;
    }
    let cancelled = false;

    // 1) 解析章节 HTML 为源树(渲染切片的母本)
    const root = document.createElement('div');
    root.className = 'paged-article';
    root.innerHTML = html;
    sourceRootRef.current = root;
    setSourceVersion((v) => v + 1);

    // 2) 初始锚点:章节变化 → 恢复保存的进度;参数变化 → 当前页保位
    let initialAnchor: Boundary | null = null;
    if (prevChapterRef.current !== chapterId) {
      initialAnchor = readSavedAnchor(bookId, chapterId);
      prevChapterRef.current = chapterId;
    } else {
      initialAnchor = lastAnchorRef.current;
    }

    const key = cacheKey(chapterId, params, html);
    const finish = (result: PageSlice[]) => {
      if (cancelled) return;
      setSlices(result);
      setStatus('ready');
      const idx = initialAnchor
        ? findPageForBoundary(root, result, initialAnchor)
        : 0;
      lastAnchorRef.current = result[Math.min(idx, result.length - 1)]?.start ?? null;
      setPageIndex(Math.min(idx, result.length - 1));
    };

    const cached = getCachedSlices(key);
    if (cached) {
      finish(cached);
      return () => {
        cancelled = true;
      };
    }

    setStatus('measuring');
    void (async () => {
      const measurer = measurerRef.current;
      if (!measurer) return;
      // 「测量 = 渲染」:同一内联整数宽度注入测量容器;
      // 章节节点直接作为测量容器的子节点(与源树同构 —— Boundary
      // 路径在两棵树上可互换,renderSlice 才能正确解析)
      measurer.style.width = `${params.width}px`;
      measurer.replaceChildren(
        ...Array.from(root.childNodes).map((n) => n.cloneNode(true)),
      );
      await waitForImages(measurer, 4000);
      if (cancelled) return;
      try {
        if (document.fonts?.ready) await document.fonts.ready;
      } catch {
        /* 字体 Promise 异常不阻塞 */
      }
      if (cancelled) return;
      let result: PageSlice[];
      try {
        result = await paginate(measurer, params.height, createBrowserGeometry(), {
          yieldEvery: 16,
          yieldFn: nextFrame,
        });
      } catch {
        // 测量异常(极端 DOM/环境问题):整章单页兜底,宁可多给内容不白屏
        result = [
          {
            index: 0,
            start: { path: [], textOffset: 0, childIndex: 0 },
            end: { path: [], textOffset: 0, childIndex: measurer.childNodes.length },
          },
        ];
      }
      if (cancelled) return;
      setCachedSlices(key, result);
      finish(result);
    })();

    return () => {
      cancelled = true;
    };
    // params 用序列化 key:对象字面量每次渲染都是新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterId, html, paramsKey]);

  // 页变化时滚动锚点
  useEffect(() => {
    const s = slices[pageIndex];
    if (s) lastAnchorRef.current = s.start;
  }, [slices, pageIndex]);

  /** 渲染第 index 页(克隆源树 + 区间裁剪)。 */
  const renderPage = useCallback(
    (index: number): Element | null => {
      const root = sourceRootRef.current;
      const slice = slices[index];
      if (!root || !slice) return null;
      return renderSlice(root, slice);
    },
    [slices],
  );

  /** 跳到指定锚点(目录跳转/进度恢复)。 */
  const goToBoundary = useCallback(
    (b: Boundary) => {
      const root = sourceRootRef.current;
      if (!root || slices.length === 0) return;
      setPageIndex(findPageForBoundary(root, slices, b));
    },
    [slices],
  );

  return {
    status,
    slices,
    pageIndex,
    pageCount: slices.length,
    sourceVersion,
    setPageIndex,
    goToBoundary,
    renderPage,
    currentSlice: slices[pageIndex] ?? null,
  };
}
