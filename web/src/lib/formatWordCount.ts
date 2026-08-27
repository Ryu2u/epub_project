// 字数人性化显示:与起点平台一致,以"万"为单位
// < 1 万显示原始数字(千分位);>= 1 万换算为"X.XX 万字"(最多 2 位小数,去尾零)
export function formatWordCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0 字';
  if (count < 10000) return `${count.toLocaleString('zh-CN')} 字`;
  const wan = count / 10000;
  const fixed = wan.toFixed(2).replace(/\.?0+$/, '');
  return `${fixed} 万字`;
}
