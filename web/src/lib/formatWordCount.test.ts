import { describe, expect, it } from 'vitest';
import { formatWordCount } from './formatWordCount';

describe('formatWordCount', () => {
  it('不足 1 万:显示千分位原始数字', () => {
    expect(formatWordCount(0)).toBe('0 字');
    expect(formatWordCount(150)).toBe('150 字');
    expect(formatWordCount(9999)).toBe('9,999 字');
  });

  it('万级:保留 2 位小数', () => {
    expect(formatWordCount(10000)).toBe('1 万字');
    expect(formatWordCount(12345)).toBe('1.23 万字');
    expect(formatWordCount(5885165)).toBe('588.52 万字');
  });

  it('小数去除尾随零', () => {
    expect(formatWordCount(1000000)).toBe('100 万字');
    expect(formatWordCount(105000)).toBe('10.5 万字');
  });

  it('非法值兜底', () => {
    expect(formatWordCount(-1)).toBe('0 字');
    expect(formatWordCount(NaN)).toBe('0 字');
    expect(formatWordCount(Infinity)).toBe('0 字');
  });
});
