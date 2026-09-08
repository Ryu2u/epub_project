// 文件大小人性化显示:自动切换 B / KB / MB / GB
// 阈值:1024 进位,KB/MB/GB 保留 1 位小数(去掉尾随零)
const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const fixed = value.toFixed(1).replace(/\.0$/, '');
  return `${fixed} ${UNITS[unitIndex]}`;
}