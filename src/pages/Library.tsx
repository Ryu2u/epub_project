// 书库页(参考图"书库"):封面双列网格 + 进度百分比/"新增"徽标 + 每条"···"菜单,
// 顶部:标题 + 排序菜单 + 更多菜单,底部导航(书库选中)。浅色/深色主题自适应。
// 搜索入口 = 底部导航的圆形搜索按钮(SearchSheet)。

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { MigrationDialog } from '../components/MigrationDialog';
import { BottomNav } from '../components/BottomNav';
import { SearchSheet } from '../components/SearchSheet';
import { ShellCover } from '../components/ShellCover';
import {
  CheckIcon,
  FilterIcon,
  MoreIcon,
  PlusIcon,
  ShelfIcon,
} from '../components/icons';
import { ThemeToggle } from '../lib/appTheme';
import { useBooks } from '../hooks/useBooks';
import type { BookSummary } from '../api/types';
import {
  BOOK_STATUS_EVENT,
  computeBookProgress,
  computeBookStatus,
  setBookStatus,
  type BookStatus,
} from '../hooks/useReaderProgress';

type SortKey = 'recent' | 'title' | 'progress';
const SORT_LABELS: Record<SortKey, string> = {
  recent: '最近添加',
  title: '按书名',
  progress: '按进度',
};

export default function LibraryPage() {
  const navigate = useNavigate();
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [openMenu, setOpenMenu] = useState<'sort' | 'more' | null>(null);
  // Tauri 桌面端(迁移/备份入口)
  const isTauri = useMemo(
    () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    [],
  );

  const { data, isLoading, error } = useBooks('', 1, 100); // 书库页拉全量(≤100),分页按钮交给"加载更多"

  // 进度变化(标记已读完/重置)时刷新卡片的徽标与百分比
  const [, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    window.addEventListener(BOOK_STATUS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(BOOK_STATUS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const items = useMemo(() => {
    const src = data?.items ?? [];
    switch (sortKey) {
      case 'title':
        return [...src].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
      case 'progress':
        return [...src].sort(
          (a, b) =>
            computeBookProgress(b.id, b.chapter_count) -
            computeBookProgress(a.id, a.chapter_count),
        );
      default:
        return src; // 服务端已按创建时间倒序
    }
  }, [data, sortKey]);

  const total = data?.total ?? 0;
  const shownCount = items.length;
  const hasMore = shownCount < total;

  return (
    <div className="min-h-screen bg-shell-bg text-shell-text">
      <div className="mx-auto max-w-3xl px-4 pb-28 pt-5 sm:px-6">
        {/* ---------- 顶栏:标题 + 排序 + 更多 + 主题 ---------- */}
        {/* relative:下拉菜单(排序/更多)以此为定位上下文 */}
        <header className="relative flex items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">书库</h1>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'sort' ? null : 'sort')}
              aria-label="排序"
              className="grid h-10 w-10 place-items-center rounded-full border border-shell-line bg-shell-card text-shell-muted transition-colors hover:text-shell-text"
            >
              <FilterIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
              aria-label="更多"
              className="grid h-10 w-10 place-items-center rounded-full border border-shell-line bg-shell-card text-shell-muted transition-colors hover:text-shell-text"
            >
              <MoreIcon className="h-5 w-5" />
            </button>
            <ThemeToggle />
          </div>
        </header>

        {/* 排序菜单(下拉) */}
        {openMenu === 'sort' && (
          <>
            <button className="fixed inset-0 z-30 cursor-default" aria-label="关闭排序菜单" onClick={() => setOpenMenu(null)} />
            <div className="absolute right-0 top-12 z-40 w-44 rounded-2xl border border-shell-line bg-shell-card p-1.5 shadow-float">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setSortKey(k);
                    setOpenMenu(null);
                  }}
                  className={
                    'flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors hover:bg-shell-track ' +
                    (sortKey === k ? 'font-medium text-shell-accentStrong' : 'text-shell-text')
                  }
                >
                  {SORT_LABELS[k]}
                  {sortKey === k && <CheckIcon className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </>
        )}

        {/* 更多菜单(下拉) */}
        {openMenu === 'more' && (
          <>
            <button className="fixed inset-0 z-30 cursor-default" aria-label="关闭更多菜单" onClick={() => setOpenMenu(null)} />
            <div className="absolute right-0 top-12 z-40 w-52 rounded-2xl border border-shell-line bg-shell-card p-1.5 shadow-float">
              <MenuItem
                icon={<PlusIcon className="h-4 w-4" />}
                label="上传 EPUB / TXT"
                onClick={() => {
                  setOpenMenu(null);
                  navigate('/upload');
                }}
              />
              <MenuItem
                icon={<FilterIcon className="h-4 w-4" />}
                label={'排序: ' + SORT_LABELS[sortKey]}
                onClick={() => {
                  setOpenMenu('sort');
                }}
              />
              <MenuItem
                icon={<ShelfIcon className="h-4 w-4" />}
                label="书库迁移 / 备份"
                hint="仅桌面端"
                disabled={!isTauri}
                onClick={() => {
                  setOpenMenu(null);
                  setMigrationOpen(true);
                }}
              />
            </div>
          </>
        )}

        <ErrorBanner error={error} />

        {/* ---------- 主体 ---------- */}
        {isLoading ? (
          <ShelfSkeleton />
        ) : items.length === 0 ? (
          <EmptyShelf />
        ) : (
          <>
            {/* 统计行 */}
            <p className="mt-3 text-xs text-shell-muted">
              共 {total} 本
              {shownCount < total && <span className="text-shell-faint"> · 已显示 {shownCount} 本</span>}
            </p>

            {/* 封面双列网格;sm+ 加宽 */}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
              {items.map((b) => (
                <ShelfCard key={b.id} book={b} />
              ))}
            </div>

            {hasMore && (
              <div className="mt-8 text-center">
                <span className="rounded-full border border-shell-line px-5 py-2 text-xs text-shell-faint">
                  已显示 {shownCount}/{total} 本
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <BottomNav active="library" onSearch={() => setSearchOpen(true)} />
      <SearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} />
      <MigrationDialog open={migrationOpen} onClose={() => setMigrationOpen(false)} />
    </div>
  );
}

// ---------- 单张书架卡片 ----------
function ShelfCard({ book }: { book: BookSummary }) {
  const [status, setStatus] = useState<BookStatus>(() =>
    computeBookStatus(book.id, book.chapter_count),
  );
  const [progress, setProgress] = useState<number>(() =>
    computeBookProgress(book.id, book.chapter_count),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const refresh = () => {
      setStatus(computeBookStatus(book.id, book.chapter_count));
      setProgress(computeBookProgress(book.id, book.chapter_count));
    };
    window.addEventListener(BOOK_STATUS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(BOOK_STATUS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [book.id, book.chapter_count]);

  const pct = Math.round(progress * 100);
  const isNew = Date.now() - Date.parse(book.created_at) < 7 * 24 * 3600 * 1000;

  return (
    <div className="relative">
      <Link to={`/books/${book.id}`} className="group block focus:outline-none" aria-label={book.title}>
        <ShellCover
          book={book}
          className="aspect-[2/3] shadow-book transition-all duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-book-hover"
        />
      </Link>

      {/* 底行:百分比/新增徽标 + ··· 菜单 */}
      <div className="mt-2 flex items-center justify-between">
        {isNew && status === 'unread' ? (
          <span className="inline-flex items-center gap-1 rounded bg-shell-accent/10 px-1.5 py-0.5 text-[0.68rem] font-medium text-shell-accentStrong">
            <span className="h-1.5 w-1.5 rounded-full bg-shell-accent" aria-hidden="true" />
            新增
          </span>
        ) : status === 'finished' ? (
          <span className="inline-flex items-center gap-1 text-[0.68rem] font-medium text-shell-accentStrong">
            <CheckIcon className="h-3 w-3" />
            已读完
          </span>
        ) : (
          <span className="text-[0.68rem] text-shell-muted tabular-nums">{pct}%</span>
        )}
        <button
          type="button"
          aria-label={`${book.title} 更多`}
          onClick={() => setMenuOpen((v) => !v)}
          className="grid h-7 w-7 place-items-center rounded-full text-shell-faint transition-colors hover:bg-shell-track hover:text-shell-text"
        >
          <MoreIcon className="h-4 w-4" />
        </button>
      </div>

      {menuOpen && (
        <>
          <button
            className="fixed inset-0 z-30 cursor-default"
            aria-label="关闭菜单"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute -top-1 right-0 z-40 w-44 rounded-2xl border border-shell-line bg-shell-card p-1.5 shadow-float">
            <Link
              to={`/books/${book.id}`}
              onClick={() => setMenuOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm transition-colors hover:bg-shell-track"
            >
              查看详情
            </Link>
            {status === 'finished' ? (
              <button
                type="button"
                onClick={() => {
                  setBookStatus(book.id, 'unread');
                  setMenuOpen(false);
                }}
                className="block w-full rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-shell-track"
              >
                重置进度
              </button>
            ) : status === 'reading' ? (
              <button
                type="button"
                onClick={() => {
                  setBookStatus(book.id, 'finished');
                  setMenuOpen(false);
                }}
                className="block w-full rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-shell-track"
              >
                标记已读完
              </button>
            ) : (
              <button
                type="button"
                disabled
                className="block w-full rounded-xl px-3 py-2 text-left text-sm text-shell-faint"
              >
                未开始阅读
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors enabled:hover:bg-shell-track disabled:cursor-not-allowed disabled:text-shell-faint"
    >
      <span className="text-shell-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[0.6rem] text-shell-faint">{hint}</span>}
    </button>
  );
}

// ---------- 加载 / 空状态 ----------
function ShelfSkeleton() {
  return (
    <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="aspect-[2/3] animate-pulse rounded-[6px] bg-shell-track" />
      ))}
    </div>
  );
}

function EmptyShelf() {
  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-shell-card text-shell-accent shadow-float">
        <ShelfIcon className="h-8 w-8" />
      </span>
      <p className="mt-3 text-base font-semibold">还没有书</p>
      <p className="text-sm text-shell-muted">上传 EPUB / TXT，开始你的藏书阁</p>
      <Link
        to="/upload"
        className="mt-5 flex items-center gap-2 rounded-full bg-shell-cta px-6 py-2.5 text-sm font-medium text-shell-onCta"
      >
        <PlusIcon className="h-4 w-4" />
        上传书籍
      </Link>
    </div>
  );
}
