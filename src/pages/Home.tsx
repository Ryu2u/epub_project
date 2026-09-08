// 主页(参考图"主页"):之前读过横排 / 阅读目标(半圆进度环+周历+连续阅读)/
// 今年读过的图书网格,底部导航。浅色蓝调 + 深色金调可切换(useAppTheme)。
// 数据全部本地(localStorage 进度 + 阅读统计),无后端新增接口。

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBanner } from '../components/ErrorBanner';
import { BottomNav } from '../components/BottomNav';
import { SearchSheet } from '../components/SearchSheet';
import { ShellCover } from '../components/ShellCover';
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  MoreIcon,
  ShelfIcon,
  TargetIcon,
} from '../components/icons';
import { ThemeToggle } from '../lib/appTheme';
import { useBooks } from '../hooks/useBooks';
import type { BookSummary } from '../api/types';
import {
  BOOK_STATUS_EVENT,
  computeBookProgress,
  computeBookStatus,
  getLastReadAt,
  getLastReadChapter,
  type BookStatus,
} from '../hooks/useReaderProgress';
import {
  getCurrentStreak,
  getGoalMinutes,
  getLongestStreak,
  getTodayMinutes,
  getWeekStats,
  READING_STATS_EVENT,
  setGoalMinutes,
} from '../lib/readingStats';

const YEAR_GOAL = 20; // 今年阅读目标:20 本(参考图"再读 4 本即可达成目标")
const STATS_EVENTS = [READING_STATS_EVENT, BOOK_STATUS_EVENT] as const;

export default function HomePage() {
  const { data, isLoading, error } = useBooks('', 1, 100); // 主页聚合需要全量书目(≤100 足够个人书库)
  const [searchOpen, setSearchOpen] = useState(false);
  // 阅读统计/进度变化时强制重算(同 tab 事件)
  const [, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    STATS_EVENTS.forEach((ev) => window.addEventListener(ev, refresh));
    window.addEventListener('storage', refresh); // 跨 tab
    return () => {
      STATS_EVENTS.forEach((ev) => window.removeEventListener(ev, refresh));
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const books = useMemo(() => data?.items ?? [], [data]);

  // ---------- 之前读过:状态 != 未读,按最近阅读时间倒序 ----------
  const previouslyRead = useMemo(
    () =>
      books
        .map((b) => ({
          book: b,
          status: computeBookStatus(b.id, b.chapter_count),
          at: getLastReadAt(b.id),
        }))
        .filter((r) => r.status !== 'unread')
        .sort((a, b) => b.at - a.at),
    [books],
  );

  // ---------- 继续阅读:最近读的一本 ----------
  const continueTarget = previouslyRead[0];
  const continueHref = (() => {
    if (!continueTarget) return null;
    const ch = getLastReadChapter(continueTarget.book.id);
    if (ch) return `/books/${continueTarget.book.id}/chapters/${encodeURIComponent(ch)}`;
    return `/books/${continueTarget.book.id}`;
  })();

  // ---------- 阅读目标(每次渲染读取,事件触发重渲染) ----------
  const todayMinutes = getTodayMinutes();
  const goalMinutes = getGoalMinutes();
  const goalPct = goalMinutes > 0 ? todayMinutes / goalMinutes : 0;
  const week = getWeekStats();
  const streak = getCurrentStreak();
  const longest = getLongestStreak();

  // ---------- 今年读过的图书 ----------
  const yearBooks = useMemo(
    () =>
      books
        .filter((b) => {
          const at = getLastReadAt(b.id);
          if (at > 0) return new Date(at).getFullYear() === new Date().getFullYear();
          // 老数据没有时间戳:有进度/已读完也算读过(诚实降级)
          const p = computeBookProgress(b.id, b.chapter_count);
          return p > 0 || computeBookStatus(b.id, b.chapter_count) === 'finished';
        })
        .sort((a, b) => getLastReadAt(b.id) - getLastReadAt(a.id))
        .slice(0, YEAR_GOAL),
    [books],
  );

  const remaining = Math.max(0, YEAR_GOAL - yearBooks.length);

  return (
    <div className="min-h-screen bg-shell-bg text-shell-text">
      <div className="mx-auto max-w-md px-5 pb-32 pt-5">
        {/* ---------- 顶栏:日期 + 主题切换 ---------- */}
        <header className="mb-1 flex items-center justify-between">
          <div>
            <p className="text-xs text-shell-muted">
              {new Date().getMonth() + 1}月{new Date().getDate()}日
            </p>
            <h1 className="font-display text-2xl font-bold tracking-tight">我的书库</h1>
          </div>
          <ThemeToggle />
        </header>

        <ErrorBanner error={error} />

        {isLoading ? (
          <HomeSkeleton />
        ) : books.length === 0 ? (
          <EmptyHome />
        ) : (
          <>
            {/* ---------- 之前读过 ---------- */}
            <RecentRow items={previouslyRead} />

            {/* ---------- 阅读目标 ---------- */}
            <GoalCard
              todayMinutes={todayMinutes}
              goalMinutes={goalMinutes}
              goalPct={goalPct}
              week={week}
              streak={streak}
              longest={longest}
              continueHref={continueHref}
              continueTitle={continueTarget?.book.title ?? null}
            />

            {/* ---------- 今年读过的图书 ---------- */}
            <section className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold">今年读过的图书</h2>
                <Link
                  to="/library"
                  className="flex items-center gap-0.5 text-xs text-shell-muted transition-colors hover:text-shell-text"
                >
                  全部
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </Link>
              </div>
              <YearGrid books={yearBooks} readCount={yearBooks.length} total={YEAR_GOAL} />
              <p className="mt-4 text-center">
                <span className="text-sm font-semibold">
                  {remaining > 0 ? (
                    <>再读 {remaining} 本图书即可达成目标</>
                  ) : (
                    <>今年目标已达成</>
                  )}
                </span>
                <ChevronRightIcon className="ml-1 inline h-4 w-4 translate-y-0.5 text-shell-faint" />
              </p>
              <p className="mt-0.5 text-center text-xs text-shell-muted">继续阅读！</p>
            </section>
          </>
        )}
      </div>

      <BottomNav active="home" onSearch={() => setSearchOpen(true)} />
      <SearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

// ---------- 之前读过(横排卡片) ----------
interface RecentItem {
  book: BookSummary;
  status: BookStatus;
  at: number;
}

function RecentRow({ items }: { items: RecentItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-2">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-bold">之前读过</h2>
        <Link
          to="/library"
          className="flex items-center gap-0.5 text-xs text-shell-muted transition-colors hover:text-shell-text"
        >
          全部
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1" data-noscroll>
        {items.slice(0, 8).map(({ book, status }) => {
          const pct = Math.round(computeBookProgress(book.id, book.chapter_count) * 100);
          return (
            <Link
              key={book.id}
              to={`/books/${book.id}`}
              className="group flex w-[15.5rem] shrink-0 items-center gap-3 rounded-2xl border border-shell-line bg-shell-card p-3 shadow-float transition-transform active:scale-[0.98]"
            >
              <ShellCover book={book} className="h-20 w-14 shrink-0 shadow-book" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[0.8rem] font-medium leading-snug text-shell-text">
                  {book.title}
                </p>
                <p className="mt-0.5 line-clamp-1 text-[0.68rem] text-shell-muted">
                  {book.authors.join(', ') || '未知作者'}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-[0.68rem] text-shell-faint">
                  {status === 'finished' ? (
                    <>
                      <span className="rounded bg-shell-accent/10 px-1 py-px font-medium text-shell-accentStrong">
                        已读完
                      </span>
                      <span>· {pct}%</span>
                    </>
                  ) : (
                    <>图书 · {pct}%</>
                  )}
                </p>
              </div>
              <MoreIcon className="h-4 w-4 shrink-0 text-shell-faint" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ---------- 阅读目标 ----------
function GoalCard({
  todayMinutes,
  goalMinutes,
  goalPct,
  week,
  streak,
  longest,
  continueHref,
  continueTitle,
}: {
  todayMinutes: number;
  goalMinutes: number;
  goalPct: number;
  week: ReturnType<typeof getWeekStats>;
  streak: number;
  longest: number;
  continueHref: string | null;
  continueTitle: string | null;
}) {
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState(goalMinutes);
  useEffect(() => {
    setGoalDraft(goalMinutes);
  }, [goalMinutes]);

  return (
    <section className="mt-8" aria-label="阅读目标">
      <h2 className="text-center text-base font-bold">阅读目标</h2>
      <p className="mt-1 text-center text-xs text-shell-muted">
        坚持每天阅读，提升你的数据，以激励你读完更多图书。
      </p>

      {/* 半圆进度环(中心内容绝对定位) */}
      <div className="relative mx-auto mt-2 w-full max-w-[19rem]">
        <GoalRing pct={goalPct} />
        <div className="absolute inset-x-0 top-[36%] flex flex-col items-center gap-1.5 text-center">
          <p className="text-xs font-medium text-shell-text">今日阅读进度</p>
          <span
            className={
              'grid h-9 w-9 place-items-center rounded-full ' +
              (goalPct >= 1
                ? 'bg-shell-accent text-shell-onAccent'
                : 'border-2 border-shell-accent/40 text-shell-accent')
            }
          >
            <CheckIcon className="h-4 w-4" />
          </span>
          <p className="text-xl font-bold tabular-nums">
            {Math.round(todayMinutes)}{' '}
            <span className="text-sm font-medium text-shell-muted">分钟</span>
          </p>
          <button
            type="button"
            onClick={() => setGoalOpen(true)}
            className="mt-0.5 flex items-center gap-0.5 text-xs text-shell-muted transition-colors hover:text-shell-text"
          >
            调整目标
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 继续阅读:主色胶囊大按钮 */}
      {continueHref ? (
        <Link
          to={continueHref}
          className="mt-5 block rounded-full bg-shell-cta py-3.5 text-center text-shell-onCta shadow-float transition-transform active:scale-[0.99]"
        >
          <span className="block text-sm font-semibold">继续阅读</span>
          {continueTitle && (
            <span className="mt-0.5 block text-[0.68rem] opacity-70">{continueTitle}</span>
          )}
        </Link>
      ) : (
        <Link
          to="/library"
          className="mt-5 block rounded-full bg-shell-cta py-3.5 text-center text-shell-onCta shadow-float"
        >
          <span className="block text-sm font-semibold">去书库选一本开始阅读</span>
        </Link>
      )}

      {/* 周历 */}
      <div className="mt-6 grid grid-cols-7 gap-1 text-center">
        {week.map((d) => (
          <div key={d.key}>
            <span
              className={
                'mx-auto grid h-10 w-10 place-items-center rounded-full ' +
                (d.minutes > 0
                  ? 'bg-shell-accent text-shell-onAccent'
                  : d.isToday
                    ? 'border-2 border-shell-accent bg-shell-card text-shell-accent'
                    : 'border border-shell-line bg-shell-card text-shell-faint')
              }
            >
              {d.minutes > 0 ? (
                <CheckIcon className="h-4 w-4" />
              ) : (
                <span className="text-[0.6rem]">{d.isToday ? '今' : '·'}</span>
              )}
            </span>
            <p
              className={
                'mt-1.5 text-[0.62rem] ' +
                (d.isToday ? 'font-semibold text-shell-accentStrong' : 'text-shell-faint')
              }
            >
              {d.label}
            </p>
          </div>
        ))}
      </div>

      {/* 连续阅读 */}
      <div className="mt-5 text-center">
        <p className="text-sm font-semibold">
          连续阅读 {streak} 天
          <ChevronRightIcon className="ml-1 inline h-4 w-4 translate-y-0.5 text-shell-faint" />
        </p>
        <p className="mt-0.5 text-xs text-shell-muted">最长记录是 {longest} 天。</p>
      </div>

      {goalOpen && (
        <GoalDialog
          value={goalDraft}
          setValue={setGoalDraft}
          onClose={() => setGoalOpen(false)}
          onSave={() => {
            const n = Number(goalDraft);
            if (Number.isFinite(n) && n >= 10) setGoalMinutes(Math.round(n));
            setGoalOpen(false);
          }}
        />
      )}
    </section>
  );
}

/** 半圆进度环:左→右 180° 圆弧,双端圆头。 */
function GoalRing({ pct }: { pct: number }) {
  const r = 84;
  const cy = 100;
  const cx = 100;
  const len = Math.PI * r; // 半圆周长
  const filled = Math.max(0, Math.min(1, pct)) * len;
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  return (
    <svg viewBox="0 0 200 112" className="w-full" role="img" aria-label="今日阅读进度环">
      <path d={d} fill="none" strokeWidth="22" strokeLinecap="round" className="stroke-shell-track" />
      <path
        d={d}
        fill="none"
        strokeWidth="22"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${len}`}
        className="stroke-shell-accent"
      />
    </svg>
  );
}

// ---------- 今年读过的图书(网格 + 占位序号) ----------
function YearGrid({
  books,
  readCount,
  total,
}: {
  books: BookSummary[];
  readCount: number;
  total: number;
}) {
  const cells: (BookSummary | number)[] = [];
  books.forEach((b) => cells.push(b));
  // 占位格从 readCount+1 编号到 total
  for (let n = readCount + 1; n <= total; n++) cells.push(n);

  return (
    <div className="mt-3 grid grid-cols-5 gap-2">
      {cells.map((c) =>
        typeof c === 'number' ? (
          // 占位格:浅灰块 + 序号
          <div
            key={`p${c}`}
            className="flex aspect-[2/3] items-end justify-center rounded-[6px] bg-shell-track pb-2 text-xs tabular-nums text-shell-faint"
          >
            {c}
          </div>
        ) : (
          <Link
            key={c.id}
            to={`/books/${c.id}`}
            className="group relative block focus:outline-none"
            aria-label={c.title}
          >
            <ShellCover book={c} className="aspect-[2/3] shadow-book" />
            {/* 中央对勾徽章 */}
            <span className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-shell-accent text-shell-onAccent shadow-md">
                <CheckIcon className="h-3.5 w-3.5" />
              </span>
            </span>
          </Link>
        ),
      )}
    </div>
  );
}

// ---------- 调整目标 ----------
function GoalDialog({
  value,
  setValue,
  onClose,
  onSave,
}: {
  value: number;
  setValue: (v: number) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const presets = [30, 60, 90, 120, 180, 240];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-xs rounded-2xl border border-shell-line bg-shell-card p-5 shadow-float">
        <h3 className="flex items-center gap-2 text-base font-bold">
          <TargetIcon className="h-4 w-4 text-shell-accent" />
          调整每日阅读目标
        </h3>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setValue(p)}
              className={
                'rounded-lg border py-2 text-sm tabular-nums transition-colors ' +
                (value === p
                  ? 'border-shell-accent bg-shell-accent/10 font-semibold text-shell-accentStrong'
                  : 'border-shell-line text-shell-muted hover:text-shell-text')
              }
            >
              {p} 分
            </button>
          ))}
        </div>
        <label className="mt-3 block text-xs text-shell-muted">
          自定义(分钟)
          <input
            type="number"
            min={10}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-shell-line bg-shell-bg px-3 py-2 text-sm tabular-nums text-shell-text focus:border-shell-accent focus:outline-none"
          />
        </label>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-shell-line py-2 text-sm text-shell-muted transition-colors hover:text-shell-text"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSave}
            className="flex-1 rounded-full bg-shell-cta py-2 text-sm font-medium text-shell-onCta"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 加载 / 空状态 ----------
function HomeSkeleton() {
  return (
    <div className="mt-4 space-y-6">
      <div className="h-24 animate-pulse rounded-2xl bg-shell-track" />
      <div className="mx-auto h-40 w-full max-w-[19rem] animate-pulse rounded-2xl bg-shell-track" />
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-[2/3] animate-pulse rounded-[6px] bg-shell-track" />
        ))}
      </div>
    </div>
  );
}

function EmptyHome() {
  return (
    <div className="mt-10 flex flex-col items-center gap-2 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-shell-card text-shell-accent shadow-float">
        <ShelfIcon className="h-8 w-8" />
      </span>
      <p className="mt-3 text-base font-semibold">书库还是空的</p>
      <p className="text-sm text-shell-muted">上传你的第一本 EPUB 或 TXT 吧</p>
      <Link
        to="/upload"
        className="mt-5 flex items-center gap-2 rounded-full bg-shell-cta px-6 py-2.5 text-sm font-medium text-shell-onCta"
      >
        <ClockIcon className="h-4 w-4" />
        上传书籍
      </Link>
    </div>
  );
}
