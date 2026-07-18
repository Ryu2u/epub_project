// Reader 偏好设置的共享类型 + 默认值 + localStorage key 命名常量。
// 之所以独立文件：useReaderSettings 之外的组件（如 ReaderSettings sheet）
// 都需要相同的类型 + 标签映射，把它们集中在这里避免循环引用。

// ---------- 字号范围常量 ----------
export const FONT_SIZE_MIN = 12;       // 最小字号 12px
export const FONT_SIZE_MAX = 28;       // 最大字号 28px
export const FONT_SIZE_DEFAULT = 16;   // 默认字号 16px（正文阅读的舒适大小）

// ---------- 字面量联合类型 ----------
// 用 type 定义字符串字面量联合类型，比 enum 更轻量（编译后只是普通 JS 对象比较）。
// 只能赋值为列出的三个字符串之一。
export type LineHeight = 'small' | 'medium' | 'large';
export type Theme = 'light' | 'sepia' | 'dark';
export type Font = 'system' | 'serif' | 'sans';

// ---------- 配置映射表 ----------
// Record<K, V> 是 TypeScript 内置工具类型，表示"键为 K、值为 V 的对象"。
// 这里将每个枚举值映射到对应的 CSS 行高数值字符串。

export const LINE_HEIGHTS: Record<LineHeight, string> = {
  small: '1.4',     // 紧凑：适合速读
  medium: '1.7',    // 适中：默认
  large: '2.0',     // 宽松：适合精读
};

// 主题配置：每个主题定义背景色、前景色（文字颜色）和显示标签
export const THEMES: Record<Theme, { bg: string; fg: string; label: string }> = {
  light: { bg: '#ffffff', fg: '#1a1a1a', label: '浅色' },
  sepia: { bg: '#f4ecd8', fg: '#3d2f1f', label: '米色' },
  dark: { bg: '#1a1a1a', fg: '#e6e6e6', label: '深色' },
};

// 字体配置：family 是 CSS font-family 属性值，包含中文和西文回退字体
export const FONTS: Record<Font, { family: string; label: string }> = {
  system: {
    family: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif',
    label: '系统',       // 跟随操作系统的默认字体
  },
  serif: {
    family: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
    label: '衬线',       // 衬线字体：类似纸质书排版效果
  },
  sans: {
    family: '"Helvetica Neue", Arial, "Microsoft YaHei", sans-serif',
    label: '无衬线',     // 无衬线字体：适合屏幕阅读
  },
};

// 行间距的中文显示标签
export const LINE_HEIGHT_LABELS: Record<LineHeight, string> = {
  small: '紧凑',
  medium: '适中',
  large: '宽松',
};

// ---------- localStorage key 命名常量 ----------
// 所有 key 用统一前缀 'epub_reader:'，便于在浏览器 DevTools 中区分/批量清理。
// ':global' 后缀表示这是全局偏好（不区分书籍）。
const K_PREFIX = 'epub_reader:';
export const KEY_FONT_SIZE = `${K_PREFIX}fontSize:global`;
export const KEY_LINE_HEIGHT = `${K_PREFIX}lineHeight:global`;
export const KEY_THEME = `${K_PREFIX}theme:global`;
export const KEY_FONT = `${K_PREFIX}font:global`;

// 按书籍隔离的进度 key，每本书的进度独立存储
export function progressKey(bookId: string): string {
  return `${K_PREFIX}progress:${bookId}`;
}

// "最近阅读章节"的 key
export function lastReadKey(bookId: string): string {
  return `${K_PREFIX}lastRead:${bookId}`;
}

// ---------- 安全的 localStorage 读写 ----------
// 为什么需要 safeGet/safeSet：
//   1. SSR 环境（如 Next.js）没有 window 对象，直接访问会报错
//   2. 隐私/无痕模式下 localStorage 可能不可用或抛出 QuotaExceededError
//   3. 统一的 try/catch 包装，调用方无需关心异常

// 安全读取：SSR 或异常时返回 null（而不是抛错）
export function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null; // SSR 安全检查
  try {
    return window.localStorage.getItem(key);       // 返回字符串或 null
  } catch {
    return null; // 隐私模式等场景可能抛出 SecurityError
  }
}

// 安全写入：配额满或隐私模式下静默失败（不中断应用）
export function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return; // SSR 安全检查
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式 — 静默失败
  }
}