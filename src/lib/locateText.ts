// 文本定位:把「搜索命中」映射回 DOM 位置。
//
// 搜索结果给的是「章内第 N 次出现 + 命中前上下文」,阅读器据此定位。
// 关键点:章节在数据库里存的是纯文本(换行/空白与渲染后的 DOM 不一致),
// 所以不能直接用字符偏移;这里在渲染后的 DOM 里重建一份文本 + 节点映射,
// 再按「第 N 次出现 + 上下文校验」定位,天然与渲染结果对齐。

export interface TextLocator {
  /** 命中的原文(大小写不敏感匹配) */
  term: string;
  /** 章内第几次出现(1 起);越界时取最后一次 */
  index: number;
  /** 命中前上下文(可选;用于消歧,优先选前文匹配的那一次) */
  before?: string;
}

interface Segment {
  node: Text;
  /** 在拼接文本中的起始偏移 */
  start: number;
  end: number;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

/** 元素是否被隐藏(内联 display:none / hidden 属性)—— 隐藏文本不参与定位。 */
function isHidden(node: Node | null, root: Node): boolean {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (el.hasAttribute?.('hidden')) return true;
      if (el.style?.display === 'none') return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

/** 把子树内的文本节点拼成一条文本,并记录每段对应的节点区间。 */
function buildIndex(root: Node): { text: string; segs: Segment[] } {
  const segs: Segment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const t = n as Text;
    const parent = t.parentElement;
    if (parent && SKIP_TAGS.has(parent.tagName)) continue;
    if (isHidden(t, root)) continue;
    const v = t.nodeValue ?? '';
    if (!v) continue;
    segs.push({ node: t, start: text.length, end: text.length + v.length });
    text += v;
  }
  return { text, segs };
}

/** 拼接文本中的偏移 → (文本节点, 节点内偏移)。 */
function offsetToNode(segs: Segment[], offset: number): { node: Text; offset: number } | null {
  if (segs.length === 0) return null;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo];
  if (offset < seg.start || offset > seg.end) return null;
  return { node: seg.node, offset: Math.min(offset - seg.start, seg.node.nodeValue?.length ?? 0) };
}

/** 找出所有出现位置(大小写不敏感,重叠不重复计数)。 */
function findAll(text: string, needle: string): number[] {
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const out: number[] = [];
  if (!target) return out;
  let from = 0;
  for (;;) {
    const i = lower.indexOf(target, from);
    if (i < 0) break;
    out.push(i);
    from = i + target.length;
  }
  return out;
}

/**
 * 定位命中处,返回 [start, end) 的 Range(可直接用于选中高亮/滚动)。
 * 定位策略:优先「第 N 次出现 + 前文上下文一致」→ 第 N 次出现 →
 * 上下文唯一匹配 → 第一次出现;都找不到返回 null。
 */
export function locateTextRange(root: Node, loc: TextLocator): Range | null {
  const term = loc.term;
  if (!term) return null;
  const { text, segs } = buildIndex(root);
  if (!text) return null;

  const positions = findAll(text, term);
  if (positions.length === 0) return null;

  const wantIndex = Math.min(Math.max(loc.index, 1), positions.length);
  const nth = positions[wantIndex - 1];
  let start = nth;

  const before = loc.before ?? '';
  if (before) {
    const b = before.toLowerCase();
    const matchesBefore = (p: number) => {
      const s = Math.max(0, p - b.length);
      return text.slice(s, p).toLowerCase().endsWith(b);
    };
    // 第 N 次若上下文不符(空白差异导致计数漂移),退化为「上下文唯一匹配」
    if (!matchesBefore(nth)) {
      const hit = positions.find(matchesBefore);
      if (hit !== undefined) start = hit;
    }
  }

  const startPos = offsetToNode(segs, start);
  const endPos = offsetToNode(segs, start + term.length);
  if (!startPos || !endPos) return null;
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  return range;
}

/** 定位命中处的起始位置(供分页模式的 Boundary 使用)。 */
export function locateTextStart(
  root: Node,
  loc: TextLocator,
): { node: Text; offset: number } | null {
  const range = locateTextRange(root, loc);
  if (!range) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  return { node: node as Text, offset: range.startOffset };
}

/** 选中并滚动到命中处(滚动模式的高亮/定位)。 */
export function selectAndScrollIntoView(range: Range, scrollRoot?: HTMLElement | null): void {
  const sel = window.getSelection?.();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const el =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as Element | null);
  if (!el) return;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center' });
    return;
  }
  // jsdom 等环境无滚动实现时的兜底:按容器 scrollTop 估算
  if (scrollRoot && typeof range.getBoundingClientRect === 'function') {
    const rect = range.getBoundingClientRect();
    const rootRect = scrollRoot.getBoundingClientRect();
    scrollRoot.scrollTop += rect.top - rootRect.top - scrollRoot.clientHeight / 2;
  }
}
