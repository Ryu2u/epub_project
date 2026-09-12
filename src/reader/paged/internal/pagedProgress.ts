// 内部实现,勿从外部直接导入 —— 对外入口见 ../index.ts(只公开 PagedReaderView / FlipStyle)。
// 分页进度持久化(锚点模型)。
//
// 与滚动模式的 progressKey 分开存储,互不污染。
// 结构:current(书内最新位置)+ recent(最近读过的若干章的锚点,
// 翻回上一章时能落回离开时的页,对应 BookReader 上一章末页体验)。

import { pagedProgressKey, safeGet, safeSet } from '../../../lib/readerPrefs';
import type { Boundary, PagedProgress } from './types';

interface PagedProgressStore {
  current: PagedProgress;
  recent: Record<string, PagedProgress>;
}

const RECENT_MAX = 12;

function readStore(bookId: string): PagedProgressStore | null {
  try {
    const raw = safeGet(pagedProgressKey(bookId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PagedProgressStore>;
    if (!parsed.current?.anchor?.path) return null;
    return { current: parsed.current, recent: parsed.recent ?? {} };
  } catch {
    return null;
  }
}

/** 写入进度:current + recent 双更新。 */
export function savePagedProgress(bookId: string, p: PagedProgress): void {
  const prev = readStore(bookId);
  const recent = { ...(prev?.recent ?? {}) };
  recent[p.chapterId] = p;
  // 只保留最近 RECENT_MAX 章(按插入序粗略淘汰)
  const keys = Object.keys(recent);
  if (keys.length > RECENT_MAX) {
    for (const k of keys.slice(0, keys.length - RECENT_MAX)) delete recent[k];
  }
  safeSet(
    pagedProgressKey(bookId),
    JSON.stringify({ current: p, recent } satisfies PagedProgressStore),
  );
}

/** 读取章节锚点:优先 current,其次 recent。 */
export function readChapterAnchor(
  bookId: string,
  chapterId: string,
): { anchor: Boundary; pageIndex: number } | null {
  const store = readStore(bookId);
  if (!store) return null;
  if (store.current.chapterId === chapterId) {
    return { anchor: store.current.anchor, pageIndex: store.current.pageIndex };
  }
  const r = store.recent[chapterId];
  if (r) return { anchor: r.anchor, pageIndex: r.pageIndex };
  return null;
}
