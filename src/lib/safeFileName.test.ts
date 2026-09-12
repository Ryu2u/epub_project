// safeFileStem 单测:规则需与 Rust `storage::sanitize_file_stem` 保持一致
// (同名用例在 src-tauri/src/storage.rs 的 filename_tests 里)。

import { describe, expect, it } from 'vitest';
import { safeFileStem } from './safeFileName';

describe('safeFileStem', () => {
  it('非法字符与控制字符替换为下划线', () => {
    expect(safeFileStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileStem('换行\n书名')).toBe('换行_书名');
  });

  it('去掉结尾的点与空格(Windows 会静默丢弃)', () => {
    expect(safeFileStem('书名...')).toBe('书名');
    expect(safeFileStem('书名   ')).toBe('书名');
    expect(safeFileStem(' 书名 ')).toBe(' 书名'); // 前导空格合法
  });

  it('规避 Windows 保留设备名(带扩展名同样命中)', () => {
    expect(safeFileStem('NUL')).toBe('_NUL');
    expect(safeFileStem('nul')).toBe('_nul');
    expect(safeFileStem('CON.txt')).toBe('_CON.txt');
    expect(safeFileStem('LPT9')).toBe('_LPT9');
    expect(safeFileStem('CONSOLE')).toBe('CONSOLE');
  });

  it('空名兜底,超长按 UTF-8 字节截断', () => {
    expect(safeFileStem('')).toBe('book');
    expect(safeFileStem('...')).toBe('book');
    const long = '书'.repeat(200); // 每字 3 字节
    const out = safeFileStem(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(120);
    expect(out).toMatch(/^书+$/); // 没有把某个字截成半个
  });
});
