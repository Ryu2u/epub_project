// 阅读进度：按 (bookId, chapterId) 存滚位置百分比 + 最近读过的章节。
// 纯函数（不依赖 React），可以在非组件代码里调用（如 LibraryPage 显示"继续阅读"）。

import { lastReadKey, progressKey, safeGet, safeSet } from '../lib/readerPrefs';

export type ProgressMap = Record<string, number>; // { chapterId: percent }

export function readProgressMap(bookId: string): ProgressMap {
  const raw = safeGet(progressKey(bookId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // 过滤非有限数
      const out: ProgressMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[k] = Math.max(0, Math.min(1, v));
        }
      }
      return out;
    }
  } catch {
    // 坏数据，忽略
  }
  return {};
}

export function writeProgressMap(bookId: string, map: ProgressMap): void {
  safeSet(progressKey(bookId), JSON.stringify(map));
}

export function getChapterProgress(bookId: string, chapterId: string): number {
  return readProgressMap(bookId)[chapterId] ?? 0;
}

export function setChapterProgress(
  bookId: string,
  chapterId: string,
  percent: number,
): void {
  const map = readProgressMap(bookId);
  const clamped = Math.max(0, Math.min(1, percent));
  if (clamped > 0) {
    map[chapterId] = clamped;
  } else {
    delete map[chapterId];
  }
  writeProgressMap(bookId, map);

  // 同步"最近读"
  if (clamped > 0) {
    safeSet(lastReadKey(bookId), chapterId);
  }
}

export function getLastReadChapter(bookId: string): string | null {
  return safeGet(lastReadKey(bookId));
}