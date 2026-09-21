// 阅读时长记录(本地数据源)。基于 localStorage,不依赖 React:
//   每日阅读分钟数:key = epub_reader:readMinutes:YYYY-MM-DD
//
// 注意:原「阅读目标 / 本周周历 / 连续阅读 / 最长记录」等**展示层**已随主页一并移除,
// 现仅保留写入端(阅读器调用 addTodayMinutes)。历史数据继续累积,将来若恢复统计
// 界面可直接读用;需要展示逻辑时从 git 历史取回,不要在这里重新长出半套 UI 依赖。

import { safeGet, safeSet } from './readerPrefs';

const K_PREFIX = 'epub_reader:';

function dayKey(d: Date): string {
  // 本地时区的 YYYY-MM-DD(避免 toISOString 的 UTC 偏移问题)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readMinKey(key: string): string {
  return `${K_PREFIX}readMinutes:${key}`;
}

function readMinutes(date: Date): number {
  const raw = safeGet(readMinKey(dayKey(date)));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/// 累加「今天」的阅读分钟数(阅读器按实际阅读时长调用)。
/// 保留一位小数;非正数与非有限值一律忽略(不写入、不创建当天记录)。
export function addTodayMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const today = new Date();
  const key = readMinKey(dayKey(today));
  const next = readMinutes(today) + minutes;
  safeSet(key, String(Math.round(next * 10) / 10));
}
