// Boundary 寻址:DOM 位置 ↔ 可序列化路径 的互转。
//
// 为什么需要它:页码会随字号/行高/窗口尺寸漂移,不能作为持久化的
// 阅读位置;而「节点路径 + 偏移」在章节 HTML 不变时是稳定的,
// 重新分页后可以重新定位回同一处内容(等价于 BookReader 用字节
// 偏移恢复 curBeginPos,但没有 GBK/UTF-8 字节回退的坑)。

import type { Boundary, DomPosition, PageSlice } from './types';

/**
 * 从 DOM 位置构造 Boundary。
 * 要求 node 位于 root 内部;root 自身也可作为 node(childIndex 语义)。
 */
export function boundaryFromPosition(root: Element, node: Node, offset: number): Boundary {
  const path: number[] = [];
  let cur: Node = node;
  while (cur !== root) {
    const parent = cur.parentNode;
    if (!parent) break; // 不在 root 内:退化为根路径(clamp 由 resolve 兜底)
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, cur));
    cur = parent;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return { path, textOffset: offset, childIndex: 0 };
  }
  // 元素节点(含 root 自身):offset 是子节点序号
  return { path, textOffset: 0, childIndex: offset };
}

/**
 * 解析 Boundary 到 DOM 位置(root 应是与构造时同构的树,如克隆节点)。
 * 路径越界/结构不匹配时返回 null(调用方降级到页首)。
 */
export function resolveBoundary(root: Element, b: Boundary): DomPosition | null {
  let cur: Node = root;
  for (const idx of b.path) {
    if (cur.nodeType !== Node.ELEMENT_NODE) return null;
    const child = cur.childNodes[idx];
    if (!child) return null;
    cur = child;
  }
  if (cur.nodeType === Node.TEXT_NODE) {
    const len = cur.nodeValue?.length ?? 0;
    return { node: cur, offset: Math.max(0, Math.min(b.textOffset, len)) };
  }
  if (cur.nodeType === Node.ELEMENT_NODE) {
    const el = cur as Element;
    return {
      node: el,
      offset: Math.max(0, Math.min(b.childIndex, el.childNodes.length)),
    };
  }
  return null;
}

/** 章节内容最前的边界(root 第 0 个子节点之前)。 */
export function startBoundary(root: Element): Boundary {
  void root; // 参数仅为与 endBoundary 对称
  return { path: [], textOffset: 0, childIndex: 0 };
}

/** 章节内容最后的边界(root 所有子节点之后)。 */
export function endBoundary(root: Element): Boundary {
  return { path: [], textOffset: 0, childIndex: root.childNodes.length };
}

/**
 * 比较两个 Boundary 在同一棵树中的文档序。
 * 返回 -1/0/1;任一解析失败按「更靠前」处理(保守)。
 */
export function compareBoundaries(root: Element, a: Boundary, b: Boundary): number {
  const pa = resolveBoundary(root, a);
  const pb = resolveBoundary(root, b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return comparePositions(pa, pb);
}

/** 比较两个 DOM 位置的文档序(Range 语义)。 */
export function comparePositions(a: DomPosition, b: DomPosition): number {
  if (a.node === b.node) {
    return a.offset === b.offset ? 0 : a.offset < b.offset ? -1 : 1;
  }
  const rel = a.node.compareDocumentPosition(b.node);
  // Node.DOCUMENT_POSITION_FOLLOWING = 4:b 在 a 后面
  if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  // Node.DOCUMENT_POSITION_PRECEDING = 2:b 在 a 前面
  if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

/** 找到包含指定锚点的页(二分;锚点在某页 [start, end) 区间内)。 */
export function findPageForBoundary(
  root: Element,
  slices: PageSlice[],
  anchor: Boundary,
): number {
  if (slices.length === 0) return 0;
  let lo = 0;
  let hi = slices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // anchor >= slices[mid].end → 在后半段
    if (compareBoundaries(root, anchor, slices[mid].end) >= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
