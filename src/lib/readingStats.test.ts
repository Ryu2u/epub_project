// readingStats 记录层测试:仅覆盖写入端 addTodayMinutes。
// (原「今日分钟 / 目标 / 周历 / 连续阅读 / 最长记录」展示层随主页移除,
//  其断言原本经由 getTodayMinutes 等读取函数,现改为直接校验 localStorage。)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTodayMinutes } from './readingStats';

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function stored(date: Date): string | null {
  return localStorage.getItem(`epub_reader:readMinutes:${dayKey(date)}`);
}

function today(): Date {
  return new Date();
}

describe('readingStats(记录层)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T10:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('addTodayMinutes 累计当天分钟数', () => {
    addTodayMinutes(15);
    addTodayMinutes(10.5);
    expect(stored(today())).toBe('25.5');
  });

  it('负数/零/非法值不写入', () => {
    addTodayMinutes(-5);
    addTodayMinutes(0);
    addTodayMinutes(NaN);
    addTodayMinutes(Infinity);
    expect(stored(today())).toBeNull();
  });

  it('结果保留一位小数', () => {
    addTodayMinutes(1.234);
    expect(stored(today())).toBe('1.2');
  });

  it('跨天分别累计,互不影响', () => {
    addTodayMinutes(10);

    vi.setSystemTime(new Date('2026-02-18T10:00:00'));
    addTodayMinutes(20);

    expect(stored(new Date('2026-02-17T10:00:00'))).toBe('10');
    expect(stored(new Date('2026-02-18T10:00:00'))).toBe('20');
  });
});
