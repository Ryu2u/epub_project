// Reader 的顶栏。
// 极简风格：返回详情 + 书名 + 章节进度百分比。
// 宽屏（≥900px）时 目录/设置/夜间 等操作在右侧常驻工具栏（ReaderSidebar）；
// 窄屏侧边栏隐藏以让出正文宽度，顶栏内提供 目录/设置 图标按钮兜底。
// 上/下一章切换放在正文末尾（ReaderChapterEnd）。
// visible 控制显隐（滚轮向上滚/滚到底时显示，向下滚时隐藏）。

import { Link } from 'react-router-dom';
import { MenuIcon, SlidersIcon } from './ReaderSidebar';

export interface ReaderTopBarProps {
  bookId: string;           // 书籍 ID，用于构建返回详情页的链接
  bookTitle: string;        // 书名（顶栏展示）
  chapterIndexLabel: string;// 进度文字，例如 "3 / 19"（第 3 章 / 共 19 章），空字符串表示未知
  progressPercent: number;  // 本章滚动进度：0-1（0 表示顶部，1 表示底部）
  visible: boolean;         // 是否可见
  onTocOpen: () => void;    // 窄屏：打开目录面板
  onSettings: () => void;   // 窄屏：打开设置面板
}

export function ReaderTopBar({
  bookId,
  bookTitle,
  chapterIndexLabel,
  progressPercent,
  visible,
  onTocOpen,
  onSettings,
}: ReaderTopBarProps) {
  const pct = Math.round(progressPercent * 100);
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
      <div className="max-w-3xl mx-auto flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
        {/* 返回按钮：Link 用于客户端导航（不刷新页面） */}
        <Link
          to={`/books/${bookId}`}
          className="shrink-0 px-2.5 py-1.5 rounded-md text-sm hover:bg-black/5"
          aria-label="返回详情页"
        >
          ←
        </Link>
        {/* 书名：truncate 单行截断；次级信息降低存在感 */}
        <span className="min-w-0 flex-1 truncate text-sm font-medium opacity-80">
          {bookTitle}
        </span>
        {/* 窄屏（<900px）：侧边栏隐藏，目录/设置入口移到顶栏 */}
        <div className="flex shrink-0 items-center gap-1 min-[900px]:hidden">
          <button
            type="button"
            onClick={onTocOpen}
            className="p-2 rounded-md hover:bg-black/5"
            aria-label="打开目录"
            title="目录"
          >
            <MenuIcon />
          </button>
          <button
            type="button"
            onClick={onSettings}
            className="p-2 rounded-md hover:bg-black/5"
            aria-label="阅读设置"
            title="设置"
          >
            <SlidersIcon />
          </button>
        </div>
        {/* 进度（如 "3 / 19 · 42%"）：tabular-nums 防止数字宽度变化导致跳动 */}
        <span className="shrink-0 text-xs tabular-nums opacity-60">
          {chapterIndexLabel && `${chapterIndexLabel} · `}
          {pct}%
        </span>
      </div>
    </header>
  );
}
