import { describe, expect, it } from 'vitest';
import { formatFileSize } from './formatFileSize';

describe('formatFileSize', () => {
  it('字节', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('KB 边界(刚好 1024 进位)', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1024 * 500)).toBe('500 KB');
    expect(formatFileSize(1024 * 1023)).toBe('1023 KB');
  });

  it('MB(超过 1024 KB 显示 MB)', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(1024 * 1024 * 8.5)).toBe('8.5 MB');
    expect(formatFileSize(1024 * 1024 * 100)).toBe('100 MB');
  });

  it('GB', () => {
    expect(formatFileSize(1024 ** 3)).toBe('1 GB');
    expect(formatFileSize(1024 ** 3 * 2.5)).toBe('2.5 GB');
  });

  it('小数去除尾随零', () => {
    expect(formatFileSize(1024 * 1024 * 5)).toBe('5 MB');
    expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });

  it('非法值兜底', () => {
    expect(formatFileSize(-1)).toBe('0 B');
    expect(formatFileSize(NaN)).toBe('0 B');
    expect(formatFileSize(Infinity)).toBe('0 B');
  });
});