// 章节末尾区（仿起点中文网阅读页末尾）：
// "—— 本章完 ——"分隔线 + 上一章 | 目录 | 下一章 三段式按钮。
// 渲染在滚动容器内、正文 <article> 之后，随内容一起滚动。

import { Link } from 'react-router-dom';

export interface ReaderChapterEndProps {
  prevHref: string | null;   // 上一章链接；null 表示已是第一章（禁用态）
  nextHref: string | null;   // 下一章链接；null 表示已是最后一章（禁用态）
  onTocOpen: () => void;     // 中间"目录"按钮：打开目录面板
}

export function ReaderChapterEnd({ prevHref, nextHref, onTocOpen }: ReaderChapterEndProps) {
  return (
    <div className="mt-14">
      {/* 本章结束标记 */}
      <div className="flex items-center gap-4 text-xs opacity-45" aria-hidden="true">
        <span className="h-px flex-1 bg-current opacity-30" />
        <span className="shrink-0 whitespace-nowrap">—— 本章完 ——</span>
        <span className="h-px flex-1 bg-current opacity-30" />
      </div>

      {/* 切换章节：等宽三段，两侧按钮为链接、中间打开目录 */}
      <nav
        aria-label="章节导航"
        className="mt-6 grid grid-cols-3 divide-x divide-black/10 overflow-hidden rounded-2xl border border-black/10 bg-black/[0.03] text-sm"
      >
        <EndNav href={prevHref} label="上一章" />
        <button
          type="button"
          onClick={onTocOpen}
          className="py-3.5 font-medium transition-colors hover:bg-black/5"
        >
          目录
        </button>
        <EndNav href={nextHref} label="下一章" />
      </nav>

      <p className="mt-5 text-center text-xs opacity-45">阅读进度已自动保存</p>
    </div>
  );
}

// 上/下一章单片：有链接时跳转，无链接（首/末章）渲染灰态不可点
function EndNav({ href, label }: { href: string | null; label: string }) {
  if (href === null) {
    return (
      <span className="flex items-center justify-center py-3.5 opacity-30 cursor-not-allowed select-none">
        {label}
      </span>
    );
  }
  return (
    <Link
      to={href}
      className="flex items-center justify-center py-3.5 transition-colors hover:bg-black/5"
    >
      {label}
    </Link>
  );
}
