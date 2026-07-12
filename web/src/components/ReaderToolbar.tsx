// Reader 的顶栏 / 底栏。
// iOS Books 风格：圆角半透明背景、清晰的图标 + 文字。

import { Link } from 'react-router-dom';

export interface ReaderTopBarProps {
  bookId: string;
  chapterTitle: string;
  visible: boolean;
  onSettings: () => void;
}

export function ReaderTopBar({
  bookId,
  chapterTitle,
  visible,
  onSettings,
}: ReaderTopBarProps) {
  return (
    <header
      className={[
        'fixed top-0 left-0 right-0 z-30 transition-all duration-200 ease-out',
        'border-b border-black/10',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none',
      ].join(' ')}
      style={{ backgroundColor: 'color-mix(in oklab, var(--bg) 92%, transparent)' }}
    >
      <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 py-3">
        <Link
          to={`/books/${bookId}`}
          className="shrink-0 px-2 py-1 rounded-md text-sm hover:bg-black/5"
          aria-label="返回详情页"
        >
          ←
        </Link>
        <h1 className="flex-1 truncate text-sm font-medium" title={chapterTitle}>
          {chapterTitle}
        </h1>
        <button
          type="button"
          onClick={onSettings}
          className="shrink-0 px-2 py-1 rounded-md text-sm hover:bg-black/5"
          aria-label="阅读设置"
        >
          设置
        </button>
      </div>
    </header>
  );
}

export interface ReaderBottomBarProps {
  visible: boolean;
  prevHref: string | null;
  nextHref: string | null;
  progressLabel: string; // 例如 "3 / 19"
  progressPercent: number; // 0-1；本章进度
}

export function ReaderBottomBar({
  visible,
  prevHref,
  nextHref,
  progressLabel,
  progressPercent,
}: ReaderBottomBarProps) {
  return (
    <footer
      className={[
        'fixed bottom-0 left-0 right-0 z-30 transition-all duration-200 ease-out',
        'border-t border-black/10',
        visible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-2 pointer-events-none',
      ].join(' ')}
      style={{ backgroundColor: 'color-mix(in oklab, var(--bg) 92%, transparent)' }}
    >
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        <NavButton href={prevHref} disabled={prevHref === null} direction="prev" />
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 h-1 bg-black/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-current opacity-50"
              style={{ width: `${Math.round(progressPercent * 100)}%` }}
            />
          </div>
          <span className="text-xs tabular-nums opacity-70">{progressLabel}</span>
        </div>
        <NavButton href={nextHref} disabled={nextHref === null} direction="next" />
      </div>
    </footer>
  );
}

function NavButton({
  href,
  disabled,
  direction,
}: {
  href: string | null;
  disabled: boolean;
  direction: 'prev' | 'next';
}) {
  const label = direction === 'prev' ? '上一章' : '下一章';
  const symbol = direction === 'prev' ? '‹' : '›';
  // disabled 时渲染成 button（不跳转）但视觉上一致
  if (disabled || href === null) {
    return (
      <button
        type="button"
        disabled
        className="px-3 py-1.5 rounded-md text-sm opacity-30 cursor-not-allowed"
      >
        {symbol} {label}
      </button>
    );
  }
  return (
    <Link
      to={href}
      className="px-3 py-1.5 rounded-md text-sm hover:bg-black/5"
      aria-label={label}
    >
      {symbol} {label}
    </Link>
  );
}