// 底部导航(书库 + 右侧圆形搜索按钮)—— 参考图样式。
// 固定在页面底部,悬浮白色胶囊;浅色/深色主题自适应(shell 令牌)。
// onSearch 触发搜索行为。
// (原「主页」入口已随主页移除,胶囊里只剩书库一项)

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SearchIcon, ShelfIcon } from './icons';

export function BottomNav({ onSearch }: { onSearch: () => void }) {
  return (
    <nav
      aria-label="底部导航"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
    >
      <div className="pointer-events-auto mx-auto flex max-w-md items-center justify-center gap-3 px-5">
        {/* 胶囊:仅剩书库一项,居中 */}
        <div className="flex flex-1 items-center justify-center gap-1 rounded-full border border-shell-line bg-shell-card py-1.5 shadow-float">
          <TabLink
            to="/library"
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
  label,
  icon,
}: {
  to: string;
  label: string;
  icon: ReactNode;
}) {
  // 只剩一个 tab,恒定高亮为当前页
  return (
    <Link
      to={to}
      aria-current="page"
      className="flex min-w-[4.5rem] flex-col items-center gap-0.5 rounded-full bg-shell-accent/10 px-3 py-1.5 text-[0.7rem] font-medium text-shell-accentStrong transition-colors"
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
