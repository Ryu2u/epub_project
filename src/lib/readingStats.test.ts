// readingStats 纯函数测试:今日分钟 / 目标 / 周历 / 连续阅读 / 最长记录
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentStreak,
  getGoalMinutes,
  getLongestStreak,
  getTodayMinutes,
  getWeekStats,
  setGoalMinutes,
  GOAL_MINUTES_DEFAULT,
  GOAL_MINUTES_KEY,
  addTodayMinutes,
} from './readingStats';

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function seed(date: Date, minutes: number) {
  localStorage.setItem(`epub_reader:readMinutes:${dayKey(date)}`, String(minutes));
}

describe('readingStats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T10:00:00')); // 周二
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('addTodayMinutes 累计当天分钟数', () => {
    addTodayMinutes(15);
    addTodayMinutes(10.5);
    expect(getTodayMinutes()).toBe(25.5);
  });

  it('负数/非法值不写入', () => {
    addTodayMinutes(-5);
    addTodayMinutes(NaN);
    expect(getTodayMinutes()).toBe(0);
  });

  it('目标默认 120,可修改且下限 10', () => {
    expect(getGoalMinutes()).toBe(GOAL_MINUTES_DEFAULT);
    setGoalMinutes(60);
    expect(localStorage.getItem(GOAL_MINUTES_KEY)).toBe('60');
    expect(getGoalMinutes()).toBe(60);
    setGoalMinutes(5); // 非法,不写入
    expect(getGoalMinutes()).toBe(60);
  });

  it('getWeekStats:7 天,今日标记为当天星期', () => {
    seed(new Date('2026-02-17T09:00:00'), 30); // 周二
    const week = getWeekStats();
    expect(week).toHaveLength(7);
    expect(week[0].label).toBe('周日');
    expect(week[2].label).toBe('周二');
    expect(week[2].isToday).toBe(true);
    expect(week[2].minutes).toBe(30);
    expect(week.filter((d) => d.isToday)).toHaveLength(1);
  });

  it('连续阅读:从今天往回数,今天无记录从昨天下手', () => {
    // 今天没有 → 昨天开始
    seed(new Date('2026-02-16T09:00:00'), 10); // 周一
    seed(new Date('2026-02-15T09:00:00'), 10); // 周日
    expect(getCurrentStreak()).toBe(2);

    // 加上今天 → 3
    seed(new Date('2026-02-17T09:00:00'), 10);
    expect(getCurrentStreak()).toBe(3);
  });

  it('连续阅读:断档后重新计数', () => {
    seed(new Date('2026-02-17T09:00:00'), 10); // 今天
    seed(new Date('2026-02-14T09:00:00'), 10); // 周六(断档)
    expect(getCurrentStreak()).toBe(1);
  });

  it('最长记录:跨断档的历史最长', () => {
    seed(new Date('2026-02-10T09:00:00'), 5);
    seed(new Date('2026-02-11T09:00:00'), 5);
    seed(new Date('2026-02-12T09:00:00'), 5);
    seed(new Date('2026-02-14T09:00:00'), 5); // 13 日缺
    seed(new Date('2026-02-15T09:00:00'), 5);
    seed(new Date('2026-02-16T09:00:00'), 5);
    seed(new Date('2026-02-17T09:00:00'), 5);
    expect(getLongestStreak()).toBe(4);
  });
});
