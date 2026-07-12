// Reader 偏好设置的共享类型 + 默认值 + localStorage key 命名常量。
// 之所以独立文件：useReaderSettings 和 useReaderSettings 之外的组件（如 ReaderSettings sheet）
// 都需要相同的类型 + 标签映射，把它们集中在这里避免循环引用。

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const FONT_SIZE_DEFAULT = 16;

export type LineHeight = 'small' | 'medium' | 'large';
export type Theme = 'light' | 'sepia' | 'dark';
export type Font = 'system' | 'serif' | 'sans';

export const LINE_HEIGHTS: Record<LineHeight, string> = {
  small: '1.4',
  medium: '1.7',
  large: '2.0',
};

export const THEMES: Record<Theme, { bg: string; fg: string; label: string }> = {
  light: { bg: '#ffffff', fg: '#1a1a1a', label: '浅色' },
  sepia: { bg: '#f4ecd8', fg: '#3d2f1f', label: '米色' },
  dark: { bg: '#1a1a1a', fg: '#e6e6e6', label: '深色' },
};

export const FONTS: Record<Font, { family: string; label: string }> = {
  system: {
    family: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif',
    label: '系统',
  },
  serif: {
    family: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
    label: '衬线',
  },
  sans: {
    family: '"Helvetica Neue", Arial, "Microsoft YaHei", sans-serif',
    label: '无衬线',
  },
};

export const LINE_HEIGHT_LABELS: Record<LineHeight, string> = {
  small: '紧凑',
  medium: '适中',
  large: '宽松',
};

// localStorage key 全部用同一前缀，便于区分 / 清理
const K_PREFIX = 'epub_reader:';
export const KEY_FONT_SIZE = `${K_PREFIX}fontSize:global`;
export const KEY_LINE_HEIGHT = `${K_PREFIX}lineHeight:global`;
export const KEY_THEME = `${K_PREFIX}theme:global`;
export const KEY_FONT = `${K_PREFIX}font:global`;

export function progressKey(bookId: string): string {
  return `${K_PREFIX}progress:${bookId}`;
}

export function lastReadKey(bookId: string): string {
  return `${K_PREFIX}lastRead:${bookId}`;
}

// 安全的 localStorage 读写（隐私模式 / SSR 不可用时返回 fallback）
export function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式 — 静默失败
  }
}