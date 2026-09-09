// 分页引擎(layout-then-slice)。
//
// 核心思路(设计文档 §5):不做 CSS Multi-column,也不自己实现折行,
// 而是把章节 DOM 放进一个与页面容器「同 CSS 类、同内联宽度」的
// 离屏测量容器,让浏览器排版引擎排好每一行,然后用 Range +
// getClientRects 读行盒,通过二分查找确定每页能容纳的最大内容区间。
//
// 「测量 = 渲染」由构造保证:测量容器与页面容器共用 .paged-article
// 类与同一个 contentWidth 常量(README 记录的上次 Multi-column
// 回滚教训正是宽度来源不一致)。
//
// 与 BookReader PageFactory 的对应:
//   pageDown() 的逐段 breakText 攒行  →  paginate() 的行盒二分
//   curBeginPos/curEndPos             →  PageSlice.start/end(Boundary)
//   pageLast() 的 O(章) 重复扫描      →  一次性前向分页 + 缓存

import {
  boundaryFromPosition,
  endBoundary,
  resolveBoundary,
  startBoundary,
} from './anchor';
import type { DomPosition, LayoutParams, PageSlice } from './types';

/** 参与分页的原子:文本节点(按字符寻址)或不可分割的替换元素。 */
type Atom =
  | { kind: 'text'; node: Text; length: number }
  | { kind: 'replaced'; node: Element };

const REPLACED_TAGS = new Set([
  'IMG', 'SVG', 'VIDEO', 'CANVAS', 'HR', 'IFRAME', 'OBJECT', 'EMBED',
]);
const SKIP_PARENT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE']);

/**
 * 全局位置索引:把 atoms 摊平成 [0, total) 的整数坐标。
 * 文本节点占 length 个位置(每字符一个),替换元素占 1 个。
 * 位置 g 与 g+1 之间的内容永远属于同一页或被切分 —— 替换元素
 * 作为整体原子永远不会被腰斩(对应 break-inside: avoid)。
 */
export class PositionIndex {
  readonly atoms: Atom[] = [];
  private bases: number[] = [];
  readonly total: number;

  constructor(root: Element) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (n: Node): number => {
          if (n.nodeType === Node.TEXT_NODE) {
            const parent = n.parentElement;
            if (parent && SKIP_PARENT_TAGS.has(parent.tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            return (n.nodeValue?.length ?? 0) > 0
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
          const el = n as Element;
          if (REPLACED_TAGS.has(el.tagName)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP; // 容器:继续深入子节点
        },
      },
    );
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        this.atoms.push({ kind: 'text', node: t, length: t.nodeValue?.length ?? 0 });
      } else {
        this.atoms.push({ kind: 'replaced', node: node as Element });
      }
    }
    let acc = 0;
    for (const a of this.atoms) {
      this.bases.push(acc);
      acc += a.kind === 'text' ? a.length : 1;
    }
    this.total = acc;
  }

  /** 全局坐标 g(∈ [0, total])→ Range 语义的 DOM 位置。 */
  posAt(g: number): DomPosition {
    const clamped = Math.max(0, Math.min(g, this.total));
    // 二分找最后一个 base <= clamped 的 atom
    let lo = 0;
    let hi = this.atoms.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bases[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const atom = this.atoms[lo];
    const local = clamped - this.bases[lo];
    if (atom.kind === 'text') {
      return { node: atom.node, offset: Math.min(local, atom.length) };
    }
    // 替换元素:g == base → 元素之前;g == base+1 → 元素之后
    const parent = atom.node.parentNode;
    if (!parent) return { node: this.rootFallback(), offset: 0 };
    const idx = Array.prototype.indexOf.call(parent.childNodes, atom.node);
    return { node: parent, offset: local >= 1 ? idx + 1 : idx };
  }

  private rootFallback(): Node {
    return this.atoms.length > 0
      ? (this.atoms[0].node.ownerDocument ?? document).body
      : document.body;
  }

  /** 替换元素原子的全局坐标(用于几何并集)。 */
  replacedAtomPositions(): Array<{ g: number; el: Element }> {
    const out: Array<{ g: number; el: Element }> = [];
    this.atoms.forEach((a, i) => {
      if (a.kind === 'replaced') out.push({ g: this.bases[i], el: a.node });
    });
    return out;
  }
}

/** 几何读取(可注入:浏览器实现走 Range,测试用假行盒)。 */
export interface Geometry {
  /** [start, end) 内容的行盒并集;top/bottom 为视口坐标;空返回 null。 */
  rangeBox(start: DomPosition, end: DomPosition): { top: number; bottom: number } | null;
  /** 替换元素的盒子(图片等)。 */
  elementBox(el: Element): { top: number; bottom: number };
}

/** 浏览器几何:Range.getClientRects 的并集(行盒 = 浏览器排好的行)。 */
export function createBrowserGeometry(): Geometry {
  return {
    rangeBox(start, end) {
      const r = document.createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      // 某些环境(如 jsdom)的 Range 没有 getClientRects → 视为无几何,
      // 分页引擎走「整章单页」兜底
      if (typeof r.getClientRects !== 'function') return null;
      let top = Infinity;
      let bottom = -Infinity;
      for (const rect of Array.from(r.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.top < top) top = rect.top;
        if (rect.bottom > bottom) bottom = rect.bottom;
      }
      return Number.isFinite(top) ? { top, bottom } : null;
    },
    elementBox(el) {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    },
  };
}

const EPS = 0.5; // 行盒比较容差(亚像素)

export interface PaginateOptions {
  /** 每处理若干页让出主线程一次(长章节防卡顿)。 */
  yieldEvery?: number;
  /** 让出函数;默认微任务。 */
  yieldFn?: () => Promise<void>;
}

/**
 * 前向分页:返回章内全部页区间。
 *
 * 算法:每页从当前全局坐标 g 出发,先取首行 top(该页容量基准),
 * 再二分找最大 h 使 [g, g+h) 的内容 bottom ≤ 首行 top + height。
 * 二分收敛保证页边界落在行边界上(整行进页,行不会被劈成两页)。
 */
export async function paginate(
  root: Element,
  height: number,
  geometry: Geometry,
  opts: PaginateOptions = {},
): Promise<PageSlice[]> {
  const idx = new PositionIndex(root);
  const replaced = idx.replacedAtomPositions();
  const yieldEvery = opts.yieldEvery ?? 24;
  const yieldFn = opts.yieldFn ?? (() => Promise.resolve());

  if (idx.total === 0) {
    return [{ index: 0, start: startBoundary(root), end: endBoundary(root) }];
  }

  // [gStart, gEnd) 的内容盒子 = Range 行盒并集 ∪ 完整包含的替换元素盒
  const boxOf = (gStart: number, gEnd: number): { top: number; bottom: number } | null => {
    const rangeBox = geometry.rangeBox(idx.posAt(gStart), idx.posAt(gEnd));
    let top = rangeBox?.top ?? Infinity;
    let bottom = rangeBox?.bottom ?? -Infinity;
    for (const { g, el } of replaced) {
      if (g >= gStart && g + 1 <= gEnd) {
        const b = geometry.elementBox(el);
        if (b.top < top) top = b.top;
        if (b.bottom > bottom) bottom = b.bottom;
      }
    }
    return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
  };

  const slices: PageSlice[] = [];
  let g = 0;
  while (g < idx.total) {
    // 首行/首元素 top = 本页容量基准(不是固定网格:行高不均匀)
    const first = boxOf(g, Math.min(g + 1, idx.total));
    if (!first) {
      // 几何不可用(jsdom / 显示:none):整章一页兜底
      if (slices.length === 0 && g === 0) {
        return [{ index: 0, start: startBoundary(root), end: endBoundary(root) }];
      }
      break;
    }
    const pageBottom = first.top + height;

    // 二分最大 h:fits(h) = boxOf(g, g+h).bottom ≤ pageBottom
    let lo = 0;
    let hi = idx.total - g;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const box = boxOf(g, g + mid);
      if (box && box.bottom <= pageBottom + EPS) lo = mid;
      else hi = mid - 1;
    }
    let h = lo;
    if (h === 0) h = 1; // 单原子高于一页(巨图/巨字号):独占一页,避免死循环

    const startPos = idx.posAt(g);
    const endPos = idx.posAt(g + h);
    slices.push({
      index: slices.length,
      start: boundaryFromPosition(root, startPos.node, startPos.offset),
      end: boundaryFromPosition(root, endPos.node, endPos.offset),
    });
    g += h;
    if (slices.length % yieldEvery === 0) await yieldFn();
  }
  if (slices.length === 0) {
    slices.push({ index: 0, start: startBoundary(root), end: endBoundary(root) });
  }
  return slices;
}

/**
 * 渲染一页:克隆章节根,删除区间外内容(先删尾部再删头部,避免
 * 位置漂移),再清理空壳元素。页面元素与测量元素同构,故 Boundary
 * 可直接在克隆树上解析。
 */
export function renderSlice(sourceRoot: Element, slice: PageSlice): Element {
  const clone = sourceRoot.cloneNode(true) as Element;
  const endPos =
    resolveBoundary(clone, slice.end) ?? {
      node: clone,
      offset: clone.childNodes.length,
    };
  const startPos = resolveBoundary(clone, slice.start) ?? { node: clone, offset: 0 };

  // 删 [end, 章末) —— 先删尾部:删后文不影响 start/end 的位置
  const rAfter = document.createRange();
  rAfter.selectNodeContents(clone);
  try {
    rAfter.setStart(endPos.node, endPos.offset);
    rAfter.deleteContents();
  } catch {
    /* 边界异常时放弃裁剪,整章渲染(宁可多给内容也不白屏) */
  }
  // 删 [章首, start)
  const rBefore = document.createRange();
  rBefore.selectNodeContents(clone);
  try {
    rBefore.setEnd(startPos.node, startPos.offset);
    rBefore.deleteContents();
  } catch {
    /* 同上 */
  }
  pruneEmpty(clone, startPos.node);
  return clone;
}

/**
 * 清理切片留下的空壳元素(整块内容都在别的页的容器)。
 * 保留 startPos 的祖先链与含 img/svg/hr/br 的元素。
 */
function pruneEmpty(clone: Element, keepNode: Node): void {
  const keepAncestors = new Set<Node>();
  let cur: Node | null = keepNode;
  while (cur && cur !== clone) {
    keepAncestors.add(cur);
    cur = cur.parentNode;
  }
  // 不可当空壳删除的元素:替换元素自身往往没有文本(如 <img>)
  const KEEP_SELECTOR = 'img,svg,video,canvas,hr,br,iframe,object,embed';
  const els = Array.from(clone.querySelectorAll('*'));
  for (const el of els) {
    if (el === clone) continue;
    if (keepAncestors.has(el)) continue;
    if (el.matches(KEEP_SELECTOR)) continue;
    if (el.querySelector(KEEP_SELECTOR)) continue;
    if ((el.textContent ?? '').trim().length > 0) continue;
    el.remove();
  }
}

// ---------- 分页结果缓存(跨组件挂载存活,LRU) ----------

interface CacheEntry {
  slices: PageSlice[];
}

const sliceCache = new Map<string, CacheEntry>();
const SLICE_CACHE_MAX = 8;

/** 廉价内容指纹:djb2(100KB 字符串 < 1ms,章节编辑后必然变化)。 */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(
  chapterId: string,
  params: LayoutParams,
  html: string,
): string {
  const p = `${params.width}x${params.height}:${params.fontSize}:${params.lineHeight}:${params.fontFamily}`;
  return `${chapterId}|${p}|${hashString(html)}`;
}

export function getCachedSlices(key: string): PageSlice[] | undefined {
  const entry = sliceCache.get(key);
  if (entry) {
    // LRU 触碰:删了重插
    sliceCache.delete(key);
    sliceCache.set(key, entry);
  }
  return entry?.slices;
}

export function setCachedSlices(key: string, slices: PageSlice[]): void {
  sliceCache.set(key, { slices });
  while (sliceCache.size > SLICE_CACHE_MAX) {
    const oldest = sliceCache.keys().next().value;
    if (oldest === undefined) break;
    sliceCache.delete(oldest);
  }
}

export function clearSliceCache(): void {
  sliceCache.clear();
}
