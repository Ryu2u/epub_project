// 换肤主题:浅色蓝调(参考图) / 深色金调(原有藏书阁风格)。
// 通过 React Context 提供,状态持久化到 localStorage;
// AppThemeProvider 把 data-shell-theme 挂在 <html> 上(CSS 变量在
// src/index.css 定义),**全站**页面与弹窗随主题切换。

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { safeGet, safeSet } from './readerPrefs';
import { MoonIcon, SunIcon } from '../components/icons';

// ---------- 类型与常量 ----------
export type ShellTheme = 'light' | 'dark';
export const SHELL_THEME_KEY = 'epub_reader:shellTheme';
const THEME_DEFAULT: ShellTheme = 'light';

interface AppThemeValue {
  theme: ShellTheme;
  setTheme: (t: ShellTheme) => void;
  toggle: () => void;
}

const AppThemeContext = createContext<AppThemeValue>({
  theme: THEME_DEFAULT,
  setTheme: () => {},
  toggle: () => {},
});

// ---------- Provider ----------
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ShellTheme>(() =>
    safeGet(SHELL_THEME_KEY) === 'dark' ? 'dark' : THEME_DEFAULT,
  );

  // 把主题标记挂到 <html>:全站 CSS 变量随之切换(浅色蓝调 / 深色金调)。
  // useLayoutEffect:在浏览器绘制前同步设置,避免深色用户看到一帧浅色闪白。
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-shell-theme', theme);
    return () => el.removeAttribute('data-shell-theme');
  }, [theme]);

  const setTheme = useCallback((t: ShellTheme) => {
    setThemeState(t);
    safeSet(SHELL_THEME_KEY, t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: ShellTheme = prev === 'light' ? 'dark' : 'light';
      safeSet(SHELL_THEME_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

// ---------- Hook ----------
export function useAppTheme(): AppThemeValue {
  return useContext(AppThemeContext);
}

// ---------- 主题切换按钮 ----------
// 图钉在主页头部:点击在浅色蓝调 / 深色金调之间切换。
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useAppTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="切换主题"
      title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
      className={
        'grid h-10 w-10 place-items-center rounded-full border border-shell-line bg-shell-card text-shell-muted transition-colors hover:text-shell-text ' +
        className
      }
    >
      {theme === 'light' ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
    </button>
  );
}
