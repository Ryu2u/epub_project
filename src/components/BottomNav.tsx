// 底部导航(主页 / 书库 + 右侧圆形搜索按钮)—— 参考图样式。
// 固定在页面底部,悬浮白色胶囊;浅色/深色主题自适应(shell 令牌)。
// active: 'home' | 'library' 控制当前 tab 高亮;onSearch 触发搜索行为。

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { HomeIcon, SearchIcon, ShelfIcon } from './icons';

export type ShellTab = 'home' | 'library';

export function BottomNav({
  active,
  onSearch,
}: {
  active: ShellTab;
  onSearch: () => void;
}) {
  return (
    <nav
      aria-label="底部导航"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
    >
      <div className="pointer-events-auto mx-auto flex max-w-md items-center justify-center gap-3 px-5">
        {/* 胶囊:两个 tab 居中 */}
        <div className="flex flex-1 items-center justify-center gap-1 rounded-full border border-shell-line bg-shell-card py-1.5 shadow-float">
          <TabLink to="/" active={active === 'home'} label="主页" icon={<HomeIcon className="h-5 w-5" />} />
          <TabLink
            to="/library"
            active={active === 'library'}
            label="书库"
            icon={<ShelfIcon className="h-5 w-5" />}
          />
        </div>
        {/* 圆形搜索按钮 */}
        <button
          type="button"
          onClick={onSearch}
          aria-label="搜索"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-shell-line bg-shell-card text-shell-text shadow-float transition-transform active:scale-95"
        >
          <SearchIcon className="h-5 w-5" />
        </button>
      </div>
    </nav>
  );
}

function TabLink({
  to,
  active,
  label,
  icon,
}: {
  to: string;
  active: boolean;
  label: string;
  icon: ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={
        'flex min-w-[4.5rem] flex-col items-center gap-0.5 rounded-full px-3 py-1.5 text-[0.7rem] transition-colors ' +
        (active
          ? 'bg-shell-accent/10 font-medium text-shell-accentStrong'
          : 'text-shell-muted hover:text-shell-text')
      }
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
