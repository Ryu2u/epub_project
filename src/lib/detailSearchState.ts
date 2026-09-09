// 详情页搜索状态的暂存与恢复。
//
// 场景:在详情页搜索 → 翻了很多条结果 → 点进阅读页 → 返回,
// 期望回到刚才的搜索状态(关键词、展开的章节、滚动位置),
// 而不是从零开始重新搜索。
//
// 用 sessionStorage(标签页/窗口级,关掉即失效,不污染长期存储),
// 按 bookId 隔离;读取即消费(take),避免下次正常打开书籍时
// 莫名其妙地弹出一堆旧搜索结果。

export interface DetailSearchState {
  /** 搜索关键词 */
  query: string;
  /** 展开的章节 id 列表 */
  expanded: string[];
  /** 结果容器(scroll container)的滚动位置 */
  scrollTop: number;
  /** 页面级滚动位置(窄屏时容器不滚动,整页滚动) */
  windowScrollY: number;
}

const PREFIX = 'epub_reader:detailSearch:';

function key(bookId: string): string {
  return `${PREFIX}${bookId}`;
}

function session(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null; // 隐私模式等场景可能抛 SecurityError
  }
}

/** 暂存搜索状态(点击搜索结果、即将跳转阅读页时调用)。 */
export function saveDetailSearch(bookId: string, state: DetailSearchState): void {
  const s = session();
  if (!s) return;
  try {
    s.setItem(key(bookId), JSON.stringify(state));
  } catch {
    /* 配额/隐私模式:静默失败,不影响跳转 */
  }
}

/** 取出并清除暂存的搜索状态(详情页挂载时调用)。 */
export function takeDetailSearch(bookId: string): DetailSearchState | null {
  const s = session();
  if (!s) return null;
  try {
    const raw = s.getItem(key(bookId));
    if (!raw) return null;
    s.removeItem(key(bookId));
    const parsed = JSON.parse(raw) as Partial<DetailSearchState>;
    if (typeof parsed.query !== 'string' || !parsed.query) return null;
    return {
      query: parsed.query,
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded : [],
      scrollTop: typeof parsed.scrollTop === 'number' ? parsed.scrollTop : 0,
      windowScrollY: typeof parsed.windowScrollY === 'number' ? parsed.windowScrollY : 0,
    };
  } catch {
    return null;
  }
}

/** 清除暂存(如用户主动清空搜索时)。 */
export function clearDetailSearch(bookId: string): void {
  const s = session();
  if (!s) return;
  try {
    s.removeItem(key(bookId));
  } catch {
    /* 同上 */
  }
}
