// Reader 阅读偏好（字号 / 行间距 / 主题 / 字体）— 持久化到 localStorage。

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
  type Font,
  type LineHeight,
  type Theme,
} from '../lib/readerPrefs';

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)));
}

function readFontSize(): number {
  const raw = safeGet(KEY_FONT_SIZE);
  if (raw === null) return FONT_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return clampFontSize(n);
}

function readLineHeight(): LineHeight {
  const raw = safeGet(KEY_LINE_HEIGHT);
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
  return 'medium';
}

function readTheme(): Theme {
  const raw = safeGet(KEY_THEME);
  if (raw === 'light' || raw === 'sepia' || raw === 'dark') return raw;
  return 'sepia';
}

function readFont(): Font {
  const raw = safeGet(KEY_FONT);
  if (raw === 'system' || raw === 'serif' || raw === 'sans') return raw;
  return 'serif';
}

export interface ReaderSettings {
  fontSize: number;
  lineHeight: LineHeight;
  theme: Theme;
  font: Font;
}

export interface UseReaderSettingsResult extends ReaderSettings {
  setFontSize: (n: number) => void;
  setLineHeight: (v: LineHeight) => void;
  setTheme: (v: Theme) => void;
  setFont: (v: Font) => void;
}

export function useReaderSettings(): UseReaderSettingsResult {
  const [fontSize, setFontSizeState] = useState(readFontSize);
  const [lineHeight, setLineHeightState] = useState(readLineHeight);
  const [theme, setThemeState] = useState(readTheme);
  const [font, setFontState] = useState(readFont);

  // 跨标签页同步：监听 storage 事件
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY_FONT_SIZE) setFontSizeState(readFontSize());
      else if (e.key === KEY_LINE_HEIGHT) setLineHeightState(readLineHeight());
      else if (e.key === KEY_THEME) setThemeState(readTheme());
      else if (e.key === KEY_FONT) setFontState(readFont());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setFontSize = useCallback((n: number) => {
    const clamped = clampFontSize(n);
    setFontSizeState(clamped);
    safeSet(KEY_FONT_SIZE, String(clamped));
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