// 阅读进度：按 (bookId, chapterId) 存滚位置百分比 + 最近读过的章节。
// 纯函数（不依赖 React），可以在非组件代码里调用（如 LibraryPage 显示"继续阅读"）。
// 之所以不做成 React hook，是因为进度读写不需要触发组件重渲染，
// 直接调用函数即可，更灵活。

// 从 readerPrefs.ts 导入 localStorage 的 key 生成函数和安全读写工具
import { lastReadKey, progressKey, safeGet, safeSet } from '../lib/readerPrefs';

// Record<K, V> 是 TypeScript 内置工具类型，等价于 { [key: K]: V }。
// 这里表示一个"章节ID -> 滚动百分比"的映射对象。
export type ProgressMap = Record<string, number>; // { chapterId: percent }

// 从 localStorage 读取某本书的全部章节进度。
// 返回一个对象，如 { "chapter-1": 0.45, "chapter-3": 0.82 }。
export function readProgressMap(bookId: string): ProgressMap {
  const raw = safeGet(progressKey(bookId)); // 获取 JSON 字符串
  if (!raw) return {};                       // 无数据时返回空对象
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // 过滤非有限数：遍历所有键值对，只保留合法的有限数值（排除 NaN、Infinity）
      const out: ProgressMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        // Object.entries 返回 [key, value] 数组，v 的类型是 unknown
        if (typeof v === 'number' && Number.isFinite(v)) {
          // 将进度值限制在 [0, 1] 范围内
          out[k] = Math.max(0, Math.min(1, v));
        }
      }
      return out;
    }
  } catch {
    // 坏数据（JSON 格式损坏），忽略并返回空对象
  }
  return {};
}

// 将进度映射对象序列化为 JSON 后写入 localStorage
export function writeProgressMap(bookId: string, map: ProgressMap): void {
  safeSet(progressKey(bookId), JSON.stringify(map));
}

// 获取单个章节的阅读进度（0~1 的百分比），不存在时返回 0
export function getChapterProgress(bookId: string, chapterId: string): number {
  return readProgressMap(bookId)[chapterId] ?? 0;
  // ?? 是 TypeScript/JS 的"空值合并运算符"，当左侧为 null 或 undefined 时使用右侧的默认值
}

// 设置单个章节的阅读进度。
// 每次调用都会读取-修改-写入整个映射（简单但对少量章节够用）。
export function setChapterProgress(
  bookId: string,
  chapterId: string,
  percent: number,
): void {
  const map = readProgressMap(bookId);
  // 将百分比限制在 [0, 1] 范围
  const clamped = Math.max(0, Math.min(1, percent));
  if (clamped > 0) {
    map[chapterId] = clamped;  // 保存进度
  } else {
    delete map[chapterId];     // 进度为 0 时清除该章节记录，保持存储整洁
  }
  writeProgressMap(bookId, map);

  // 同步"最近读"：记录最后一次有进度的章节，方便"继续阅读"功能定位
  if (clamped > 0) {
    safeSet(lastReadKey(bookId), chapterId);
  }
}

// 获取某本书最近阅读的章节 ID，不存在时返回 null
export function getLastReadChapter(bookId: string): string | null {
  return safeGet(lastReadKey(bookId));
}