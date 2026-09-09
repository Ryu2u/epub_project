// usePaginator —— 分页调度 hook(≈ BookReader ReadActivity 的章节装配 +
// PageFactory 的 openBook/pageDown 状态机)。
//
// 职责:
//   html → 离屏测量 → PageSlice[](measureChapter,带 LRU 缓存)→ 页导航/锚点恢复
//   - 章节变化:恢复 localStorage 里保存的锚点(无则页首)
//   - 排版参数变化(字号/行高/字体/尺寸):以当前页 start 锚点保位重排
//   - 缓存命中时跳过 measuring 态(跨章翻页/回跳无感切换)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boundaryFromPosition, findPageForBoundary } from './anchor';
import { measureChapter } from './measureChapter';
import { cacheKey, getCachedSlices, renderSlice } from './paginator';
import type { Boundary, LayoutParams, PageSlice } from './types';
import { readChapterAnchor } from './pagedProgress';
import { locateTextStart, type TextLocator } from '../../lib/locateText';

export type PaginatorStatus = 'idle' | 'measuring' | 'ready';

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
  /** 章节标题:注入正文首位为 <h3>(顶部标题栏已取消)。 */
  chapterTitle?: string;
  params: LayoutParams;
  /** 离屏测量容器(挂载在阅读器树内,继承全部排版 CSS 变量)。 */
  measurerRef: React.RefObject<HTMLDivElement | null>;
}

export function usePaginator({
  bookId,
  chapterId,
  html,
  chapterTitle,
  params,
  measurerRef,
}: UsePaginatorArgs) {
  const [status, setStatus] = useState<PaginatorStatus>('idle');
  const [slices, setSlices] = useState<PageSlice[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  /** 源树版本号:html 变化时自增,驱动页面重渲染 effect。 */
  const [sourceVersion, setSourceVersion] = useState(0);
  /** 当前 slices 实际所属的章节(与 chapterId 在切换过渡期不同步)。 */
  const [readyChapterId, setReadyChapterId] = useState<string>(chapterId);
  const sourceRootRef = useRef<HTMLDivElement | null>(null);
  /** 当前页 start 锚点(排版参数变化时保位用)。 */
  const lastAnchorRef = useRef<Boundary | null>(null);
  const prevChapterRef = useRef<string>(chapterId);
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

    // 初始锚点:章节变化 → 恢复保存的进度;参数变化 → 当前页保位
    let initialAnchor: Boundary | null = null;
    if (prevChapterRef.current !== chapterId) {
      initialAnchor = readSavedAnchor(bookId, chapterId);
      prevChapterRef.current = chapterId;
    } else {
      initialAnchor = lastAnchorRef.current;
    }

    const measurer = measurerRef.current;
    if (!measurer) return;

    // 缓存命中时不进入 measuring(避免跨章切换闪一帧"排版中")
    const willMeasure = !getCachedSlices(
      cacheKey(chapterId, params, html, chapterTitle ?? ''),
    );
    if (willMeasure) setStatus('measuring');

    void (async () => {
      const res = await measureChapter(html, chapterId, params, measurer, {
        isCancelled: () => cancelled,
        title: chapterTitle,
      });
      if (cancelled || !res) return;
      sourceRootRef.current = res.sourceRoot;
      setSourceVersion((v) => v + 1);
      setSlices(res.slices);
      setStatus('ready');
      setReadyChapterId(chapterId);
      const idx = initialAnchor
        ? findPageForBoundary(res.sourceRoot, res.slices, initialAnchor)
        : 0;
      const safe = Math.min(idx, res.slices.length - 1);
      lastAnchorRef.current = res.slices[safe]?.start ?? null;
      setPageIndex(safe);
    })();

    return () => {
      cancelled = true;
    };
    // params 用序列化 key:对象字面量每次渲染都是新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapterId, html, chapterTitle, paramsKey]);

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

  /**
   * 文本定位(搜索命中 → 页码):在源树里按「第 N 次出现 + 上下文」找到
   * 位置,换算成 Boundary 后跳到对应页。返回是否成功。
   */
  const goToTextLocator = useCallback(
    (loc: TextLocator): boolean => {
      const root = sourceRootRef.current;
      if (!root || slices.length === 0) return false;
      const pos = locateTextStart(root, loc);
      if (!pos) return false;
      const boundary = boundaryFromPosition(root, pos.node, pos.offset);
      setPageIndex(findPageForBoundary(root, slices, boundary));
      return true;
    },
    [slices],
  );

  return {
    status,
    slices,
    pageIndex,
    pageCount: slices.length,
    sourceVersion,
    /** 当前分页结果所属章节:与 chapterId 不一致 = 切换过渡期(勿持久化)。 */
    readyChapterId,
    setPageIndex,
    goToBoundary,
    goToTextLocator,
    renderPage,
    currentSlice: slices[pageIndex] ?? null,
  };
}
