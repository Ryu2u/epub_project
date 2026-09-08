// 搜索弹出层:底部导航的圆形搜索按钮打开,全屏接管。
// - 输入即查(≥1 字防抖 250ms),复用 useBooks 的 SearchResponse?—— 不,
//   这里直接查 /api/books?q= 列表接口,结果网格化展示,点击进详情。
// - Escape / 遮罩点击关闭;浅色/深色主题自适应。

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBooks } from '../hooks/useBooks';
import { ShellCover } from './ShellCover';
import { ArrowLeftIcon, SearchIcon } from './icons';

export function SearchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  // 防抖后的生效关键词;open 时清空,保证每次打开都是全新搜索
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q, open]);

  // key 变化驱动查询:空串查全库第一页,其余按关键词
  const { data, isLoading } = useBooks(debounced, 1, 30);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo(() => data?.items ?? [], [data]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-shell-bg" role="dialog" aria-modal="true">
      {/* 顶栏:返回 + 输入框 */}
      <div className="mx-auto w-full max-w-md px-4 pb-2 pt-4 sm:px-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭搜索"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-shell-line bg-shell-card text-shell-muted transition-colors hover:text-shell-text"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-shell-faint" />
            <input
              autoFocus
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索书名…"
              aria-label="搜索书名"
              className="w-full rounded-full border border-shell-line bg-shell-card py-2.5 pl-10 pr-4 text-sm text-shell-text placeholder:text-shell-faint focus:border-shell-accent focus:outline-none focus:ring-2 focus:ring-shell-accent/25"
            />
          </div>
        </div>
      </div>

      {/* 结果区 */}
      <div className="mx-auto w-full max-w-md flex-1 overflow-y-auto px-4 pb-10 pt-3 sm:px-6" data-noscroll>
        {isLoading ? (
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-[6px] bg-shell-track" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-20 text-center">
            <p className="text-sm text-shell-text">{debounced ? '未找到相关书籍' : '输入书名开始搜索'}</p>
            <p className="text-xs text-shell-muted">
              {debounced ? '换个关键词试试' : '搜索你书库里的 EPUB / TXT'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {items.map((b) => (
              <Link
                key={b.id}
                to={`/books/${b.id}`}
                onClick={onClose}
                className="group block focus:outline-none"
                aria-label={b.title}
              >
                <ShellCover
                  book={b}
                  className="aspect-[2/3] shadow-book transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-book-hover"
                />
                <p className="mt-1.5 line-clamp-1 text-xs text-shell-text">{b.title}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
