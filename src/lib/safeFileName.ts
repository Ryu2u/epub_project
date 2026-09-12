// 导出文件名的前端清洗 —— 与 Rust `storage::sanitize_file_stem` 同一套规则。
//
// 为什么两边都要有:文件名由前端作为「另存为」的默认值交给原生对话框,
// 而最终写盘由 Rust 负责 —— 任何一边漏了,书名里的 `/` 会改变对话框的起始
// 目录,`NUL.epub` 这类 Windows 保留设备名会让写盘「成功」但磁盘上没有文件。
// 书名来自用户上传的 EPUB,属于不可信输入。

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_BYTES = 120;
const ILLEGAL = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return n;
}

function truncateToBytes(s: string, maxBytes: number): string {
  if (utf8Len(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

function trimTrailingDotsSpaces(s: string): string {
  return s.replace(/[. ]+$/, '');
}

/**
 * 清洗文件名主干(不含扩展名)。规则与 Rust 侧一致:
 * 非法字符与控制字符 → `_`;去掉结尾的点/空格;保留设备名加 `_` 前缀;
 * 空名兜底 `book`;超过 120 字节按 UTF-8 边界截断。
 */
export function safeFileStem(stem: string): string {
  let out = '';
  for (const ch of stem) {
    const cp = ch.codePointAt(0) ?? 0;
    // eslint-disable-next-line no-control-regex
    out += ILLEGAL.has(ch) || cp < 0x20 || cp === 0x7f ? '_' : ch;
  }

  out = trimTrailingDotsSpaces(out);
  if (!out) out = 'book';

  const head = (out.split('.')[0] ?? '').toUpperCase();
  if (RESERVED.has(head)) out = `_${out}`;

  if (utf8Len(out) > MAX_BYTES) {
    out = trimTrailingDotsSpaces(truncateToBytes(out, MAX_BYTES));
    if (!out) out = 'book';
  }
  return out;
}
