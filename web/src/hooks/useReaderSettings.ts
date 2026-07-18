// Reader 阅读偏好（字号 / 行间距 / 主题 / 字体）— 持久化到 localStorage。
// 为什么抽成 hook：
//   1. 将 localStorage 的读写逻辑封装，组件只需调用 hook 即可获取/修改设置
//   2. 使用 useState 管理内存状态，修改后组件自动重渲染
//   3. 支持跨标签页同步（监听 storage 事件）
//   4. 设置值自动校验（clampFontSize / 类型守卫），防止脏数据

import { useCallback, useEffect, useState } from 'react';
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  KEY_FONT,
  KEY_FONT_SIZE,
  KEY_LINE_HEIGHT,
  KEY_THEME,
  safeGet,
  safeSet,
  type Font,          // type-only 导入：仅导入类型信息，编译后不产生运行时代码
  type LineHeight,
  type Theme,
} from '../lib/readerPrefs';

// 将字号限制在合法范围内，并四舍五入为整数。
// !Number.isFinite(n) 处理 NaN / Infinity 等异常输入。
function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)));
}

// 从 localStorage 读取字号，解析为整数后 clamp 到合法范围。
// localStorage 存储的都是字符串，需要 parseInt 转为数字。
function readFontSize(): number {
  const raw = safeGet(KEY_FONT_SIZE);
  if (raw === null) return FONT_SIZE_DEFAULT; // 首次使用，返回默认值
  const n = parseInt(raw, 10);                // 10 表示十进制
  return clampFontSize(n);
}

// 读取行间距设置。用类型守卫检查值是否为合法的 LineHeight 枚举值。
function readLineHeight(): LineHeight {
  const raw = safeGet(KEY_LINE_HEIGHT);
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
  return 'medium'; // 默认值
}

// 读取主题设置
function readTheme(): Theme {
  const raw = safeGet(KEY_THEME);
  if (raw === 'light' || raw === 'sepia' || raw === 'dark') return raw;
  return 'sepia'; // 默认值：米色护眼
}

// 读取字体设置
function readFont(): Font {
  const raw = safeGet(KEY_FONT);
  if (raw === 'system' || raw === 'serif' || raw === 'sans') return raw;
  return 'serif'; // 默认值：衬线字体（更接近纸质书阅读体验）
}

// hook 的返回类型：包含所有设置值 + 对应的 setter 函数
export interface ReaderSettings {
  fontSize: number;
  lineHeight: LineHeight;
  theme: Theme;
  font: Font;
}

// 扩展接口：在 ReaderSettings 基础上添加 setter 函数
export interface UseReaderSettingsResult extends ReaderSettings {
  setFontSize: (n: number) => void;
  setLineHeight: (v: LineHeight) => void;
  setTheme: (v: Theme) => void;
  setFont: (v: Font) => void;
}

export function useReaderSettings(): UseReaderSettingsResult {
  // useState 的参数可以是函数（惰性初始化），只在首次渲染时执行读取，
  // 避免每次渲染都读 localStorage（性能优化）。
  const [fontSize, setFontSizeState] = useState(readFontSize);
  const [lineHeight, setLineHeightState] = useState(readLineHeight);
  const [theme, setThemeState] = useState(readTheme);
  const [font, setFontState] = useState(readFont);

  // 跨标签页同步：监听浏览器的 storage 事件。
  // storage 事件只在"其他标签页"修改 localStorage 时触发（当前标签页不会触发）。
  // 这样用户在标签页 A 修改设置后，标签页 B 的阅读器会自动同步。
  useEffect(() => {
    if (typeof window === 'undefined') return; // SSR 安全检查
    const onStorage = (e: StorageEvent) => {
      // e.key 是被修改的 localStorage key，只处理我们关心的 key
      if (e.key === KEY_FONT_SIZE) setFontSizeState(readFontSize());
      else if (e.key === KEY_LINE_HEIGHT) setLineHeightState(readLineHeight());
      else if (e.key === KEY_THEME) setThemeState(readTheme());
      else if (e.key === KEY_FONT) setFontState(readFont());
    };
    window.addEventListener('storage', onStorage);
    // effect cleanup：组件卸载时移除事件监听，防止内存泄漏
    return () => window.removeEventListener('storage', onStorage);
  }, []); // 空依赖数组：只在组件挂载时注册一次

  // useCallback 缓存 setter 函数，确保引用稳定（不会每次渲染都创建新函数）。
  // 空依赖数组 [] 表示函数内部不依赖任何外部变量，所以永远是同一个引用。
  // 这避免了将 setter 作为子组件 props 时触发不必要的重渲染。
  const setFontSize = useCallback((n: number) => {
    const clamped = clampFontSize(n);
    setFontSizeState(clamped);       // 更新 React 状态，触发重渲染
    safeSet(KEY_FONT_SIZE, String(clamped)); // 同步持久化到 localStorage
  }, []);

  const setLineHeight = useCallback((v: LineHeight) => {
    setLineHeightState(v);
    safeSet(KEY_LINE_HEIGHT, v);
  }, []);

  const setTheme = useCallback((v: Theme) => {
    setThemeState(v);
    safeSet(KEY_THEME, v);
  }, []);

  const setFont = useCallback((v: Font) => {
    setFontState(v);
    safeSet(KEY_FONT, v);
  }, []);

  return { fontSize, lineHeight, theme, font, setFontSize, setLineHeight, setTheme, setFont };
}