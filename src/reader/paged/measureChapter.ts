// 章节测量共享逻辑:解析源树 + (缓存命中则跳过)离屏测量切页。
// 当前章(usePaginator)与邻章预分页(PagedReaderView 的跨章翻页准备)
// 共用,保证「测量=渲染」与缓存行为完全一致。

import {
  cacheKey,
  createBrowserGeometry,
  getCachedSlices,
  paginate,
  setCachedSlices,
} from './paginator';
import type { LayoutParams, PageSlice } from './types';

export interface MeasureChapterResult {
  /** 章节源树(渲染切片的母本,detached)。 */
  sourceRoot: HTMLDivElement;
  slices: PageSlice[];
}

/** 解析章节 HTML 为源树(类名与页面/测量容器一致)。
 *
 * 章节标题以 <h3> 注入正文首位(参与排版:第 1 页页首即标题,
 * 与纸质书一致),顶部小字标题栏因此取消。
 * 若正文自带与标题同名的首个标题,则提升/降级为 h3 而不重复注入
 * (与滚动模式的「首个标题去重」同源思路)。 */
export function parseChapterSource(html: string, title?: string): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'paged-article';
  root.innerHTML = html;
  const t = title?.trim();
  if (!t) return root;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const firstHeading = root.querySelector('h1, h2, h3, h4, h5, h6');
  if (firstHeading && norm(firstHeading.textContent ?? '') === norm(t)) {
    if (firstHeading.tagName !== 'H3') {
      const h3 = document.createElement('h3');
      h3.innerHTML = (firstHeading as HTMLElement).innerHTML;
      firstHeading.replaceWith(h3);
    }
    return root;
  }
  const h3 = document.createElement('h3');
  h3.textContent = t;
  root.prepend(h3);
  return root;
}

/** 等待测量容器内图片完成(布局稳定前提);总超时兜底。 */
export async function waitForImages(el: HTMLElement, timeoutMs: number): Promise<void> {
  const imgs = Array.from(el.querySelectorAll('img'));
  if (imgs.length === 0) return;
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

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * 测量一章并返回源树与页切片。
 * - 切片缓存命中:不触碰 measurer,直接返回(切章无感);
 * - 未命中:内容作为 measurer 子节点安装(与源树同构,Boundary 路径
 *   在两棵树上可互换),等图片/字体后行盒二分切页。
 * - isCancelled 在各 await 之间检查,取消返回 null。
 */
export async function measureChapter(
  html: string,
  chapterId: string,
  params: LayoutParams,
  measurer: HTMLDivElement,
  opts: { isCancelled?: () => boolean; title?: string } = {},
): Promise<MeasureChapterResult | null> {
  const sourceRoot = parseChapterSource(html, opts.title);
  const key = cacheKey(chapterId, params, html, opts.title ?? '');
  const cached = getCachedSlices(key);
  if (cached) return { sourceRoot, slices: cached };

  const check = () => opts.isCancelled?.() === true;
  if (check()) return null;

  // 「测量 = 渲染」:同一内联整数宽度注入测量容器;
  // 章节节点直接作为测量容器的子节点(与源树同构)
  measurer.style.width = `${params.width}px`;
  measurer.replaceChildren(
    ...Array.from(sourceRoot.childNodes).map((n) => n.cloneNode(true)),
  );
  await waitForImages(measurer, 4000);
  if (check()) return null;
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {
    /* 字体 Promise 异常不阻塞 */
  }
  if (check()) return null;

  let slices: PageSlice[];
  try {
    slices = await paginate(measurer, params.height, createBrowserGeometry(), {
      yieldEvery: 16,
      yieldFn: nextFrame,
    });
  } catch {
    // 测量异常(极端 DOM/环境问题):整章单页兜底,宁可多给内容不白屏
    slices = [
      {
        index: 0,
        start: { path: [], textOffset: 0, childIndex: 0 },
        end: { path: [], textOffset: 0, childIndex: measurer.childNodes.length },
      },
    ];
  }
  if (check()) return null;
  setCachedSlices(key, slices);
  return { sourceRoot, slices };
}
