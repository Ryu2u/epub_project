// 阅读器右侧常驻工具栏（仿起点中文网阅读页侧边栏）：
// 目录 / 书详情 / 书架 / 夜间 / 设置，底部附"返回顶部"。
// 与顶栏不同，它不随滚动自动隐藏 —— 阅读中随时可跳转、切换夜间模式或调设置。
// 背景用 color-mix 半透明 + backdrop-blur，跟随主题（--bg/--fg）变化。

import { Link } from 'react-router-dom';
import type { Theme } from '../lib/readerPrefs';

export interface ReaderSidebarProps {
  bookId: string;         // 构建"书详情"链接
  theme: Theme;           // 当前主题，用于高亮"夜间"项
  onTocOpen: () => void;      // 打开目录面板
  onSettingsOpen: () => void; // 打开设置面板
  onToggleNight: () => void;  // 白天/夜间主题切换
  onBackToTop: () => void;    // 滚动回正文顶部
}

export function ReaderSidebar({
  bookId,
  theme,
  onTocOpen,
  onSettingsOpen,
  onToggleNight,
  onBackToTop,
}: ReaderSidebarProps) {
  const night = theme === 'dark';
  // 每个按钮的公共样式：图标在上、小字标签在下（与起点侧边栏一致）
  const itemClass =
    'flex flex-col items-center gap-1 rounded-xl px-3 pt-2.5 pb-1.5 ' +
    'transition-colors hover:bg-black/5';

  return (
    <nav
      aria-label="阅读工具栏"
      className={[
        'fixed right-3 top-1/2 z-20 -translate-y-1/2',   // 右侧垂直居中
        // 窄屏（<900px）隐藏：正文列 max-w-680 居中，侧边栏会压住文字；
        // 移动端改用顶栏中的 目录/设置 入口（见 ReaderTopBar）。
        'hidden min-[900px]:flex flex-col items-center gap-0.5',
        'rounded-2xl border border-black/10 px-1 py-2.5 shadow-lg backdrop-blur',
      ].join(' ')}
      style={{ backgroundColor: 'color-mix(in oklab, var(--bg) 88%, transparent)' }}
    >
      {/* 目录：打开滑出式目录面板 */}
      <ToolbarButton
        label="目录"
        ariaLabel="打开目录"
        onClick={onTocOpen}
        className={itemClass}
      >
        <MenuIcon />
      </ToolbarButton>

      {/* 书详情：返回书籍详情页 */}
      <ToolbarLink label="书详情" ariaLabel="书详情" to={`/books/${bookId}`} className={itemClass}>
        <BookIcon />
      </ToolbarLink>

      {/* 书架：返回书籍库首页 */}
      <ToolbarLink label="书架" ariaLabel="返回书架" to="/" className={itemClass}>
        <ShelfIcon />
      </ToolbarLink>

      {/* 夜间：亮/暗主题一键切换（当前为暗色时高亮） */}
      <ToolbarButton
        label="夜间"
        ariaLabel="夜间模式"
        onClick={onToggleNight}
        className={`${itemClass} ${night ? 'bg-black/5' : ''}`}
      >
        <MoonIcon />
      </ToolbarButton>

      {/* 设置：字号/行距/主题/字体 */}
      <ToolbarButton
        label="设置"
        ariaLabel="阅读设置"
        onClick={onSettingsOpen}
        className={itemClass}
      >
        <SlidersIcon />
      </ToolbarButton>

      <div className="my-1 h-px w-8 rounded-full bg-current opacity-15" aria-hidden="true" />

      {/* 返回顶部：平滑滚回本章开头 */}
      <ToolbarButton
        label="顶部"
        ariaLabel="返回顶部"
        onClick={onBackToTop}
        className={itemClass}
      >
        <ArrowUpIcon />
      </ToolbarButton>
    </nav>
  );
}

// 图标 + 小标签的按钮（onClick 型）
function ToolbarButton({
  label,
  ariaLabel,
  onClick,
  className,
  children,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={ariaLabel} title={label} onClick={onClick} className={className}>
      {children}
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  );
}

// 图标 + 小标签的跳转项（Link 型）
function ToolbarLink({
  label,
  ariaLabel,
  to,
  className,
  children,
}: {
  label: string;
  ariaLabel: string;
  to: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <Link to={to} aria-label={ariaLabel} title={label} className={className}>
      {children}
      <span className="text-[10px] leading-none">{label}</span>
    </Link>
  );
}

// ---------- 图标（线性 SVG，跟随 currentColor） ----------

export function MenuIcon() {
  return (
    <Svg>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </Svg>
  );
}

function BookIcon() {
  return (
    <Svg>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  );
}

function ShelfIcon() {
  return (
    <Svg>
      <rect x="4" y="4" width="6" height="16" rx="1" />
      <rect x="14" y="4" width="6" height="15" rx="1" />
      <line x1="2.5" y1="20.5" x2="21.5" y2="20.5" />
    </Svg>
  );
}

function MoonIcon() {
  return (
    <Svg>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </Svg>
  );
}

export function SlidersIcon() {
  return (
    <Svg>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </Svg>
  );
}

function ArrowUpIcon() {
  return (
    <Svg>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Svg>
  );
}

// 统一的 SVG 容器：20px、线性描边、不填充
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
