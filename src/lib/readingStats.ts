// 阅读统计(主页"阅读目标"模块的本地数据源)。
// 纯函数 + localStorage,不依赖 React:
//   - 每日阅读分钟数:key = epub_reader:readMinutes:YYYY-MM-DD
//   - 每日阅读目标(分钟):epub_reader:readingGoal
//   - 本周 7 天(周日→周六)逐日分钟数
//   - 连续阅读天数(从今天往回数,断档即停)与历史最长记录
// 与 useReaderProgress 一样,改动经 READING_STATS_EVENT 事件通知同 tab 组件重算。

import { safeGet, safeSet } from './readerPrefs';

export const READING_STATS_EVENT = 'reading-stats-change';

const K_PREFIX = 'epub_reader:';
export const GOAL_MINUTES_DEFAULT = 120; // 默认每日目标 120 分钟(参考图:169 分钟已达成)
export const GOAL_MINUTES_KEY = `${K_PREFIX}readingGoal`;

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

export function getTodayMinutes(): number {
  return readMinutes(new Date());
}

export function addTodayMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const today = new Date();
  const key = readMinKey(dayKey(today));
  const next = readMinutes(today) + minutes;
  safeSet(key, String(Math.round(next * 10) / 10));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(READING_STATS_EVENT));
  }
}

export function getGoalMinutes(): number {
  const raw = safeGet(GOAL_MINUTES_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 10 ? n : GOAL_MINUTES_DEFAULT;
}

export function setGoalMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < 10) return;
  safeSet(GOAL_MINUTES_KEY, String(Math.round(minutes)));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(READING_STATS_EVENT));
  }
}

// ---------- 本周 7 天(周日 → 周六) ----------
export interface WeekDayStat {
  label: string;   // 周日 / 周一 ...
  key: string;     // YYYY-MM-DD
  minutes: number; // 当天阅读分钟
  isToday: boolean;
}

export function getWeekStats(): WeekDayStat[] {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const now = new Date();
  // JS getDay(): 0=周日 .. 6=周六,与界面顺序一致
  const mondayOffset = now.getDay();
  const out: WeekDayStat[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - mondayOffset + i); // 从本周日到周六
    out.push({
      label: labels[i],
      key: dayKey(d),
      minutes: readMinutes(d),
      isToday: i === mondayOffset,
    });
  }
  return out;
}

// ---------- 连续阅读 ----------
// 今日有记录 → 从今天往回数;今日无记录 → 从昨天往回数(今天的还没读,不打断)。
function countBackFrom(start: Date): number {
  let streak = 0;
  const d = new Date(start);
  while (readMinutes(d) > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function getCurrentStreak(): number {
  const now = new Date();
  if (readMinutes(now) > 0) return countBackFrom(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return countBackFrom(yesterday);
}

export function getLongestStreak(): number {
  // 遍历 localStorage 中所有 readMinutes:* 前缀的 key,按日期排序后扫描
  if (typeof window === 'undefined') return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(`${K_PREFIX}readMinutes:`)) keys.push(k);
    }
  } catch {
    return 0;
  }
  if (keys.length === 0) return 0;
  const days = keys
    .map((k) => k.slice(`${K_PREFIX}readMinutes:`.length))
    .sort(); // YYYY-MM-DD 字符串排序即时间排序
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(`${days[i - 1]}T00:00:00`);
    prev.setDate(prev.getDate() + 1);
    if (dayKey(prev) === days[i]) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  return longest;
}
