// 阅读器目录面板：右侧滑入的 sheet（仿 iOS Books）。
// 复用 bookQuery.data.chapters 缓存，零新后端端点。
// 与 ReaderSettings 同架构：遮罩 + transform 滑入；受控组件模式。

import { useEffect, useRef } from 'react';
import type { ChapterOut } from '../api/types';

export interface ReaderTocPanelProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  chapters: ChapterOut[]; // 已按 spine_order 排序
  currentChapterId: string;
  onChapterSelect: (id: string) => void;
}

export function ReaderTocPanel({
  open,
  onClose,
  chapters,
  currentChapterId,
  onChapterSelect,
}: ReaderTocPanelProps) {
  const currentRef = useRef<HTMLButtonElement | null>(null);

  // ESC 键关闭面板（与 ReaderSettings 同模式）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时自动滚动到当前章节（视区中央）
  useEffect(() => {
    if (!open) return;
    const el = currentRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' });
    }
  }, [open, currentChapterId]);

  return (
    <>
      {/* 背景遮罩：点击可关闭。data-testid 让 Task 1 测试选择器更稳定。 */}
      <div
        onClick={onClose}
        data-testid="toc-overlay"
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        aria-hidden="true"
      />
      {/* Sheet 面板 */}
      <aside
        role="dialog"
        aria-label="目录"
        className={[
          'fixed top-0 right-0 bottom-0 z-50',
          'w-[85%] sm:w-[360px]',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <div className="h-full flex flex-col">
          <header className="flex items-center justify-between px-4 py-3 border-b border-black/10">
            <h2 className="font-display text-lg font-semibold">目录</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭目录"
              className="px-3 py-1 rounded-md text-sm hover:bg-black/5"
            >
              ✕
            </button>
          </header>

          <ul role="list" className="flex-1 overflow-y-auto py-2">
            {chapters.map((ch, idx) => {
              const isCurrent = ch.id === currentChapterId;
              return (
                <li key={ch.id}>
                  <button
                    ref={isCurrent ? currentRef : undefined}
                    type="button"
                    onClick={() => onChapterSelect(ch.id)}
                    className={[
                      'flex items-center gap-3 px-4 py-3 w-full text-left',
                      'border-l-2 transition-colors',
                      isCurrent
                        ? 'border-gold-400 bg-black/5 font-medium'
                        : 'border-transparent hover:bg-black/5',
                    ].join(' ')}
                  >
                    <span className="text-xs tabular-nums text-cream-faint w-6 shrink-0">
                      {idx + 1}
                    </span>
                    <span className="truncate text-sm">{ch.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </>
  );
}