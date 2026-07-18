// Reader 的顶栏 / 底栏。
// iOS Books 风格：圆角半透明背景、清晰的图标 + 文字。
// 顶栏显示返回按钮、章节标题和设置按钮；
// 底栏显示上/下章导航和阅读进度条。
// 两个栏都支持 visible 控制显隐（点击屏幕中央切换时使用）。

import { Link } from 'react-router-dom';

// ---------- 顶栏 ----------
// visible 控制顶栏是否显示，通过 CSS transition 实现平滑的淡入/滑入效果
export interface ReaderTopBarProps {
  bookId: string;          // 书籍 ID，用于构建返回详情页的链接
  chapterTitle: string;    // 当前章节标题
  visible: boolean;        // 是否可见
  onSettings: () => void;  // 点击"设置"按钮的回调
}

export function ReaderTopBar({
  bookId,
  chapterTitle,
  visible,
  onSettings,
}: ReaderTopBarProps) {
  return (
    <header
      // 用数组 join 拼接 className：根据 visible 切换不同的样式组合
      className={[
        'fixed top-0 left-0 right-0 z-30 transition-all duration-200 ease-out',
        'border-b border-black/10',
        // 可见时：不透明 + 原位；隐藏时：透明 + 向上偏移 + 禁止鼠标事件
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none',
      ].join(' ')}
      // color-mix() 是 CSS 颜色函数，将背景色与 92% 不透明度混合，
      // 实现半透明毛玻璃效果，让下方内容隐约可见
      style={{ backgroundColor: 'color-mix(in oklab, var(--bg) 92%, transparent)' }}
    >
      <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 py-3">
        {/* 返回按钮：Link 用于客户端导航（不刷新页面） */}
        <Link
          to={`/books/${bookId}`}
          className="shrink-0 px-2 py-1 rounded-md text-sm hover:bg-black/5"
          aria-label="返回详情页"
        >
          ←
        </Link>
        {/* 章节标题：flex-1 填满剩余空间，truncate 单行截断 */}
        <h1
          className="flex-1 truncate font-display text-sm font-medium"
          title={chapterTitle}  // 悬停显示完整标题
        >
          {chapterTitle}
        </h1>
        {/* 设置按钮 */}
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

// ---------- 底栏 ----------
export interface ReaderBottomBarProps {
  visible: boolean;         // 是否可见（与顶栏联动）
  prevHref: string | null;  // 上一章链接，null 表示已是第一章
  nextHref: string | null;  // 下一章链接，null 表示已是最后一章
  progressLabel: string;    // 进度文字，例如 "3 / 19"（第 3 章 / 共 19 章）
  progressPercent: number;  // 本章滚动进度：0-1（0 表示顶部，1 表示底部）
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
        // 可见时：不透明 + 原位；隐藏时：透明 + 向下偏移
        visible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-2 pointer-events-none',
      ].join(' ')}
      style={{ backgroundColor: 'color-mix(in oklab, var(--bg) 92%, transparent)' }}
    >
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        {/* 上一章按钮 */}
        <NavButton href={prevHref} disabled={prevHref === null} direction="prev" />

        {/* 进度条区域 */}
        <div className="flex-1 flex items-center gap-2">
          {/* 进度条：外层灰色轨道 + 内层彩色填充 */}
          <div className="flex-1 h-1 bg-black/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-current opacity-50"
              // 宽度由 progressPercent 动态计算，如 0.5 变为 50%
              style={{ width: `${Math.round(progressPercent * 100)}%` }}
            />
          </div>
          {/* 进度文字（如 "3 / 19"）：tabular-nums 防止数字宽度变化导致跳动 */}
          <span className="text-xs tabular-nums opacity-70">{progressLabel}</span>
        </div>

        {/* 下一章按钮 */}
        <NavButton href={nextHref} disabled={nextHref === null} direction="next" />
      </div>
    </footer>
  );
}

// 导航按钮子组件。
// disabled 时渲染 <button>（不可点击），否则渲染 <Link>（可跳转）。
// 两种情况视觉一致，只是语义不同。
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