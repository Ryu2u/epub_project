// Library 页:列表 + 搜索 + 上传按钮 + 分页
// 深色图书馆风:暖金点缀的炭黑书架,衬线字标题,错落入场。
import { useState, type ReactNode } from 'react'; // type 关键字仅导入类型，不会打入最终 bundle
import { Link } from 'react-router-dom'; // React Router 的声明式导航组件，渲染为 <a> 标签
import { BookCard } from '../components/BookCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBooks } from '../hooks/useBooks'; // 自定义 Hook，封装 TanStack Query 的数据请求逻辑

const PAGE_SIZE = 20; // 每页显示的书籍数量，全局常量

export default function LibraryPage() {
  // q: 搜索框中用户正在输入的值（受控组件）
  // submitted: 用户按回车后真正提交的搜索词，与 q 分离避免每次按键都触发请求
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  // useBooks 返回 TanStack Query 的结果对象：data（响应体）、isLoading（首次加载）、error（请求错误）
  const { data, isLoading, error } = useBooks(submitted, page, PAGE_SIZE);

  // data 可能为 undefined（尚未返回），用空值合并运算符 ?? 提供默认值
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE)); // 至少 1 页

  // 翻页时回到页面顶部，体验更好
  const goToPage = (p: number) => {
    setPage(p);
    window.scrollTo({ top: 0 });
  };

  return (
    <div
      className="app-shell relative min-h-screen bg-ink-900 text-cream"
      style={{ colorScheme: 'dark' }}
    >
      <div className="shell-atmosphere" aria-hidden="true" />

      {/* ---------- 顶栏:半透明吸顶,暖金细线 ---------- */}
      {/* sticky + backdrop-blur 实现滚动时顶栏"粘"在顶部且带有毛玻璃效果 */}
      <header className="sticky top-0 z-20 border-b border-gold-400/10 bg-ink-900/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:gap-5 sm:px-6">
          <h1 className="flex shrink-0 items-center gap-2.5">
            <span className="font-display text-2xl tracking-tight text-cream">
              EPUB <span className="text-gold-400">库</span>
            </span>
            {/* 竖线分隔符，仅 sm 及以上屏幕显示（hidden sm:block 是响应式断点写法） */}
            <span className="hidden h-4 w-px bg-gold-400/25 sm:block" />
            <span className="hidden font-display text-xs italic text-cream-muted sm:block">
              藏书阁
            </span>
          </h1>

          {/* 搜索表单：preventDefault 阻止表单默认提交（页面刷新），改用状态驱动搜索 */}
          <form
            className="relative flex-1 max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(q);  // 将当前输入"提交"为搜索词，触发 useBooks 重新请求
              goToPage(1);       // 搜索时重置到第一页
            }}
          >
            {/* 搜索图标用 absolute 定位覆盖在 input 左侧 */}
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cream-faint" />
            <input
              type="search"
              placeholder="搜索书名…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full rounded-full border border-gold-400/15 bg-ink-800/70 py-2 pl-10 pr-4 text-sm text-cream placeholder:text-cream-faint transition-colors focus:border-gold-400/50 focus:outline-none focus:ring-2 focus:ring-gold-400/20"
            />
          </form>

          {/* Link 组件：点击不会触发整页刷新，而是由 React Router 接管路由切换 */}
          <Link
            to="/upload"
            className="group inline-flex shrink-0 items-center gap-1.5 rounded-full bg-gold-400 px-4 py-2 text-sm font-medium text-ink-900 shadow-[0_0_22px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200 hover:shadow-[0_0_28px_-4px_rgba(212,168,87,0.85)]"
          >
            {/* group-hover:rotate-90 表示当父元素带 group 类被 hover 时，图标旋转 90 度 */}
            <PlusIcon className="h-4 w-4 transition-transform group-hover:rotate-90" />
            上传
          </Link>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <ErrorBanner error={error} />

        {/* 条件渲染：loading → 骨架屏；无数据 → 空状态；有数据 → 书卡网格 */}
        {isLoading ? (
          <SkeletonGrid />
        ) : !data || data.items.length === 0 ? (
          <EmptyState submitted={submitted} />
        ) : (
          <>
            {/* 统计栏："共 N 册" + 页码信息，装饰性短线用 aria-hidden 避免屏幕阅读器读出 */}
            <div className="mb-7 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-cream-muted">
              <span className="h-px w-8 bg-gold-400/40" aria-hidden="true" />
              <span>
                共{' '}
                <span className="font-display text-base normal-case tracking-normal text-gold-200">
                  {total}
                </span>{' '}
                册
              </span>
              {/* 仅在多于 1 页时显示页码提示 */}
              {totalPages > 1 && (
                <span className="text-cream-faint normal-case tracking-normal">
                  · 第 {page}/{totalPages} 页
                </span>
              )}
            </div>

            {/* 响应式网格：手机 2 列 → sm 3 列 → md 4 列 → lg 5 列 */}
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {data.items.map((b, idx) => (
                <div
                  key={b.id}
                  className="shell-reveal"
                  style={{ animationDelay: `${Math.min(idx, 8) * 45}ms` }}
                >
                  <BookCard book={b} />
                </div>
              ))}
            </div>

            {/* 分页控件：仅在多页时显示 */}
            {totalPages > 1 && (
              <div className="mt-14 flex items-center justify-center gap-3">
                <PagerButton
                  onClick={() => goToPage(Math.max(1, page - 1))}
                  disabled={page <= 1}  // 第一页时禁用"上一页"
                >
                  ‹ 上一页
                </PagerButton>
                <PageNumbers page={page} totalPages={totalPages} onGo={goToPage} />
                <PagerButton
                  onClick={() => goToPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}  // 最后一页时禁用"下一页"
                >
                  下一页 ›
                </PagerButton>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** 加载态:暖色微光扫过的骨架卡片网格。 */
function SkeletonGrid() {
  // Array.from({ length: 10 }) 创建 10 个占位卡片，模拟真实布局的宽高比
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3">
          {/* aspect-[2/3] 强制封面图片 2:3 比例，shell-shimmer 是自定义闪烁动画 */}
          <div className="shell-shimmer aspect-[2/3] rounded-md" />
          <div className="shell-shimmer h-3 w-3/4 rounded" />
          <div className="shell-shimmer h-2.5 w-1/2 rounded" />
        </div>
      ))}
    </div>
  );
}

/** 空状态:印章 + 衬线提示 + (无搜索时)上传引导。 */
function EmptyState({ submitted }: { submitted: string }) {
  // submitted 有值说明是搜索无结果；否则是书库为空，显示上传引导
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <span className="mb-5 font-display text-5xl text-gold-400/45">❦</span>
      {submitted ? (
        <>
          <p className="font-display text-xl text-cream">未寻得此卷</p>
          <p className="mt-2 text-sm text-cream-muted">换个关键词再试试</p>
        </>
      ) : (
        <>
          <p className="font-display text-xl text-cream">还没有书</p>
          <p className="mt-2 text-sm text-cream-muted">上传第一本 EPUB，开启你的藏书阁</p>
          <Link
            to="/upload"
            className="mt-7 inline-flex items-center gap-1.5 rounded-full bg-gold-400 px-5 py-2.5 text-sm font-medium text-ink-900 shadow-[0_0_22px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200"
          >
            <PlusIcon className="h-4 w-4" /> 上传 EPUB
          </Link>
        </>
      )}
    </div>
  );
}

/** 分页 prev/next:幽灵文字按钮。 */
function PagerButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** 页码按钮:显示首尾 + 当前页附近,超出用省略号。 */
function PageNumbers({
  page,
  totalPages,
  onGo,
}: {
  page: number;
  totalPages: number;
  onGo: (p: number) => void;
}) {
  // 算法：始终显示第 1 页、最后一页、当前页及其前后各 1 页
  // 用 Set 自动去重，再排序、过滤出有效范围内的页码
  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  // 在不连续的页码之间插入省略号 "…"
  const nodes: (number | '…')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) nodes.push('…');
    nodes.push(sorted[i]);
  }

  return (
    <div className="flex items-center gap-1">
      {/* 用 map 渲染：省略号用 span，页码用按钮；tabular-nums 保证数字等宽，切换页码时不会跳动 */}
      {nodes.map((n, i) =>
        n === '…' ? (
          <span key={`e${i}`} className="px-1.5 text-sm text-cream-faint">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            onClick={() => onGo(n)}
            className={
              'min-w-[2.25rem] rounded-full px-2 py-1.5 text-sm tabular-nums transition-colors ' +
              (n === page
                ? 'bg-gold-400 font-medium text-ink-900'  // 当前页：金色实底高亮
                : 'text-cream-muted hover:bg-ink-700/60 hover:text-gold-200') // 非当前页：幽灵样式
            }
          >
            {n}
          </button>
        ),
      )}
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
