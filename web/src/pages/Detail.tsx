// Detail 页:封面 + 元数据 + 章节目录 + 资源 + 删除 —— 深色图书馆风。
import { useMemo, useRef, useState } from 'react'; // useMemo 缓存排序结果；useRef 获取隐藏 input 的 DOM 引用
import { Link, useNavigate, useParams } from 'react-router-dom';
// useParams: 从 URL 路径中提取动态参数（如 /books/:id → id）
// useNavigate: 编程式导航，用于跳转和返回
import { assetUrl } from '../api/client'; // 拼接资源文件（如封面图）的完整 URL
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBook, useDeleteBook, useDeleteCover, useUploadCover } from '../hooks/useBooks';
import { getChapterProgress } from '../hooks/useReaderProgress'; // 从 localStorage 读取章节阅读进度

export default function DetailPage() {
  // useParams 从路由 /books/:id 提取 id 参数，类型泛型指定参数的 TypeScript 类型
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // useBook 是封装了 useQuery 的 hook，根据 id 获取单本书的详情数据
  const { data: book, isLoading, error } = useBook(id);
  // 以下三个都是 useMutation 封装的 hook，分别处理删除书籍、上传封面、删除封面
  const deleteBook = useDeleteBook();
  const uploadCover = useUploadCover();
  const removeCover = useDeleteCover();
  const [confirmOpen, setConfirmOpen] = useState(false); // 控制确认删除弹窗的显隐
  const fileInputRef = useRef<HTMLInputElement>(null);   // 隐藏的文件上传 input 的引用

  // useMemo 缓存排序后的章节列表：只有 book 变化时才重新排序，避免每次渲染都执行
  const sortedChapters = useMemo(
    () => (book ? [...book.chapters].sort((a, b) => a.spine_order - b.spine_order) : []),
    [book], // 依赖数组：仅当 book 变化时重新计算
  );

  // 通过 ref 触发隐藏的 file input 的点击事件，打开文件选择对话框
  const handleSelectFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 清空 input 的值，确保即使选择同一个文件也能再次触发 onChange
    if (!file) return;
    try {
      await uploadCover.mutateAsync({ bookId: id, file });
    } catch {
      // 错误已通过 mutation.error 暴露，下面渲染
    }
  };

  const handleDeleteCover = async () => {
    try {
      await removeCover.mutateAsync(id);
    } catch {
      // 同上
    }
  };

  // 条件渲染：loading 态显示加载提示；error 或无数据时显示错误 + 返回按钮
  if (isLoading) {
    return (
      <div
        className="app-shell flex min-h-screen items-center justify-center bg-ink-900 text-cream-faint"
        style={{ colorScheme: 'dark' }}
      >
        <span className="font-display text-lg text-cream-muted">加载中…</span>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div
        className="app-shell min-h-screen bg-ink-900 px-6 py-10 text-cream"
        style={{ colorScheme: 'dark' }}
      >
        <div className="mx-auto max-w-3xl">
          <ErrorBanner error={error ?? new Error('书不存在')} />
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-sm text-gold-400 transition-colors hover:text-gold-200"
          >
            ← 返回书库
          </button>
        </div>
      </div>
    );
  }

  // 在 assets 中查找标记为封面的资源
  const cover = book.assets.find((a) => a.is_cover);

  return (
    <div
      className="app-shell relative min-h-screen bg-ink-900 text-cream md:flex md:h-screen md:flex-col md:overflow-hidden"
      style={{ colorScheme: 'dark' }}
    >
      <div className="shell-atmosphere" aria-hidden="true" />

      {/* ---------- 顶栏 ---------- */}
      <header className="relative z-20 shrink-0 border-b border-gold-400/10 bg-ink-900/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200"
            >
              ← 返回
            </button>
            <h1
              className="truncate font-display text-xl text-cream"
              title={book.title}
            >
              {book.title}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={`/api/books/${book.id}/export`}
              download
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              导出 EPUB
            </a>
            <button
              onClick={() => setConfirmOpen(true)}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
            >
              删除
            </button>
          </div>
        </div>
      </header>

      {/* ---------- 主体:左封面+元数据 / 右目录(各自独立滚动) ---------- */}
      {/* md 以上使用 CSS Grid 两列布局：左列固定 280px（封面），右列自动填充（目录） */}
      {/* md:min-h-0 + md:overflow-y-auto 让左右两列各自独立滚动，而不是整页一起滚 */}
      <main className="relative z-10 mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-8 px-4 py-8 sm:px-6 md:min-h-0 md:grid-cols-[280px_1fr] md:grid-rows-[minmax(0,1fr)]">
        {/* 左:封面 + 元数据 */}
        <aside className="space-y-5 md:min-h-0 md:overflow-y-auto md:pr-2">
          {/* 封面容器：group 类让子元素可以用 group-hover 触发悬停效果 */}
          <div className="group relative aspect-[2/3] w-full overflow-hidden rounded-lg shadow-book">
            {cover ? (
              <img
                src={assetUrl(book.id, cover.id)} // 拼接 /api/books/{id}/assets/{assetId} 的完整 URL
                alt={book.title}
                className="h-full w-full object-cover"
              />
            ) : (
              // 无封面时的占位：渐变背景 + 书名首字 + "无封面"文字
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-gold-400/15 bg-gradient-to-br from-ink-700 via-ink-800 to-ink-950 p-4 text-center">
                {/* 取书名第一个字符大写显示，无书名时显示装饰符号 ❦ */}
                <span className="font-display text-5xl text-gold-400/55">
                  {(book.title?.trim()?.[0] ?? '❦').toUpperCase()}
                </span>
                <span className="h-px w-9 bg-gold-400/35" aria-hidden="true" />
                <span className="font-display text-sm text-cream-muted">无封面</span>
              </div>
            )}
            {/* 操作覆盖层：悬停封面时从透明渐变为半透明黑底，显示"更换/上传封面"按钮 */}
            {/* group-hover: 父 div 被 hover 时触发，bg-black/0 → bg-black/45 实现淡入遮罩 */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/45 group-hover:opacity-100">
              <button
                onClick={handleSelectFile}
                disabled={uploadCover.isPending} // 上传中禁用按钮防止重复提交
                className="rounded-full bg-white/90 px-3 py-1.5 text-sm text-ink-900 transition-colors hover:bg-white disabled:opacity-60"
              >
                {/* 根据 mutation 状态和是否已有封面，动态切换按钮文字 */}
                {uploadCover.isPending
                  ? '上传中...'
                  : cover
                    ? '更换封面'
                    : '上传封面'}
              </button>
              {cover && (
                <button
                  onClick={handleDeleteCover}
                  disabled={removeCover.isPending}
                  className="rounded-full bg-white/90 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-white disabled:opacity-60"
                >
                  {removeCover.isPending ? '删除中...' : '删除封面'}
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {(uploadCover.error || removeCover.error) && (
            <ErrorBanner
              error={uploadCover.error ?? removeCover.error ?? new Error('封面操作失败')}
            />
          )}

          <dl className="space-y-3 border-t border-gold-400/10 pt-5 text-sm">
            {/* 使用语义化标签 <dl>（定义列表）展示元数据：dt 是标签，dd 是值 */}
            <MetaRow label="作者">
              {book.authors.length > 0 ? book.authors.join(', ') : '未知'}
            </MetaRow>
            <MetaRow label="语言">{book.language}</MetaRow>
            {book.publisher && <MetaRow label="出版">{book.publisher}</MetaRow>}
            {book.pub_date && <MetaRow label="日期">{book.pub_date}</MetaRow>}
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-cream-faint">标识</dt>
              <dd className="mt-1 break-all font-mono text-xs text-cream-muted">
                {book.identifier}
              </dd>
            </div>
            {book.description && (
              <div>
                <dt className="text-xs uppercase tracking-[0.18em] text-cream-faint">简介</dt>
                <dd className="mt-1 leading-relaxed text-cream-muted">{book.description}</dd>
              </div>
            )}
          </dl>
        </aside>

        {/* 右:章节目录(独立滚动 + 标题吸顶) */}
        <section className="md:min-h-0 md:overflow-y-auto md:pr-1">
          {/* md:sticky md:top-0 让"目录"标题在滚动时吸顶，配合 backdrop-blur 产生毛玻璃效果 */}
          <h2 className="mb-3 flex items-baseline gap-3 font-display text-lg text-cream md:sticky md:top-0 md:z-10 md:-mx-1 md:mb-1 md:bg-ink-900/80 md:px-1 md:py-3 md:backdrop-blur-sm">
            目录
            <span className="text-sm font-normal tabular-nums text-cream-faint">
              （{sortedChapters.length}）
            </span>
          </h2>
          <ol className="list-none space-y-0.5">
            {sortedChapters.map((ch, idx) => {
              // 从 localStorage 读取当前章节的阅读进度（0~1 的浮点数）
              const progress = getChapterProgress(book.id, ch.id);
              const progressPct = Math.round(progress * 100);
              const done = progress >= 1; // 进度 >= 1 表示已读完
              return (
                <li key={ch.id}>
                  {/* Link 声明式导航：to 使用模板字符串拼接路由，encodeURIComponent 确保章节 ID 中的特殊字符安全 */}
                  <Link
                    to={`/books/${book.id}/chapters/${encodeURIComponent(ch.id)}`}
                    className="group flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-ink-700/40"
                  >
                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-cream-faint group-hover:text-gold-200">
                      {idx + 1}
                    </span>
                    <span
                      className="flex-1 truncate font-display text-sm text-cream-muted group-hover:text-cream"
                      title={ch.title}
                    >
                      {ch.title}
                    </span>
                    {/* 进度 > 0 且 < 1 时显示百分比；>= 1 时显示已完成勾号 */}
                    {progress > 0 && progress < 1 && (
                      <span className="shrink-0 text-xs tabular-nums text-gold-400">
                        {progressPct}%
                      </span>
                    )}
                    {done && (
                      <span className="shrink-0 text-xs text-gold-400" aria-label="已读完">
                        ✓
                      </span>
                    )}
                    <span className="w-14 shrink-0 text-right text-xs tabular-nums text-cream-faint">
                      {ch.word_count} 词
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          {book.assets.length > 0 && (
            <>
              <h2 className="mb-3 mt-8 flex items-baseline gap-3 font-display text-lg text-cream">
                资源
                <span className="text-sm font-normal tabular-nums text-cream-faint">
                  （{book.assets.length}）
                </span>
              </h2>
              <ul className="space-y-1 text-sm">
                {book.assets.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-cream-muted"
                  >
                    <span className="truncate font-mono text-xs">{a.href}</span>
                    <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                      {a.media_type} · {(a.size / 1024).toFixed(1)} KB
                      {a.is_cover && ' · 封面'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>

      {/* 确认删除弹窗：open 控制显隐，onConfirm 执行删除后跳回首页 */}
      <ConfirmDialog
        open={confirmOpen}
        title="删除这本书？"
        message={`《${book.title}》将被永久删除，此操作不可恢复。`}
        confirmLabel="删除"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          await deleteBook.mutateAsync(book.id);
          setConfirmOpen(false);
          navigate('/');
        }}
      />
    </div>
  );
}

/** MetaRow：单行元数据展示组件，左侧标签 + 右侧值，使用 ReactNode 接受任意子元素 */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-xs uppercase tracking-[0.18em] text-cream-faint">{label}</dt>
      <dd className="text-right text-cream">{children}</dd>
    </div>
  );
}
