// Detail 页：封面 + 元数据 + 章节目录 + 资源 + 删除
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { assetUrl } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBook, useDeleteBook, useDeleteCover, useUploadCover } from '../hooks/useBooks';
import { getChapterProgress } from '../hooks/useReaderProgress';

export default function DetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: book, isLoading, error } = useBook(id);
  const deleteBook = useDeleteBook();
  const uploadCover = useUploadCover();
  const removeCover = useDeleteCover();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sortedChapters = useMemo(
    () => (book ? [...book.chapters].sort((a, b) => a.spine_order - b.spine_order) : []),
    [book],
  );

  const handleSelectFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一文件
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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        加载中...
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-3xl mx-auto">
          <ErrorBanner error={error ?? new Error('书不存在')} />
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-sm text-blue-600 hover:underline"
          >
            ← 返回书库
          </button>
        </div>
      </div>
    );
  }

  const cover = book.assets.find((a) => a.is_cover);

  return (
    <div className="min-h-screen bg-gray-50 md:h-screen md:flex md:flex-col md:overflow-hidden">
      <header className="bg-white border-b border-gray-200 md:shrink-0">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={() => navigate('/')}
              className="shrink-0 text-sm text-gray-600 hover:text-gray-900"
            >
              ← 返回
            </button>
            <h1 className="text-xl font-semibold text-gray-900 truncate" title={book.title}>
              {book.title}
            </h1>
          </div>
          <button
            onClick={() => setConfirmOpen(true)}
            className="shrink-0 px-3 py-1.5 rounded-md text-sm text-red-600 hover:bg-red-50"
          >
            删除
          </button>
        </div>
      </header>

      <main className="max-w-5xl w-full mx-auto px-4 py-6 flex-1 md:min-h-0 grid grid-cols-1 md:grid-cols-[280px_1fr] md:grid-rows-[minmax(0,1fr)] gap-6">
        {/* 左：封面 + 元数据（独立滚动） */}
        <aside className="space-y-4 md:min-h-0 md:overflow-y-auto md:pr-2">
          <div className="group relative w-full aspect-[2/3] rounded-lg overflow-hidden shadow">
            {cover ? (
              <img
                src={assetUrl(book.id, cover.id)}
                alt={book.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-gray-200 flex items-center justify-center text-gray-400">
                无封面
              </div>
            )}
            {/* 操作覆盖层 */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex flex-col items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
              <button
                onClick={handleSelectFile}
                disabled={uploadCover.isPending}
                className="px-3 py-1.5 rounded-md text-sm bg-white/90 text-gray-900 hover:bg-white disabled:opacity-60"
              >
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
                  className="px-3 py-1.5 rounded-md text-sm bg-white/90 text-red-600 hover:bg-white disabled:opacity-60"
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

          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-gray-500">作者</dt>
              <dd className="text-gray-900">
                {book.authors.length > 0 ? book.authors.join(', ') : '未知'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">语言</dt>
              <dd className="text-gray-900">{book.language}</dd>
            </div>
            {book.publisher && (
              <div>
                <dt className="text-gray-500">出版</dt>
                <dd className="text-gray-900">{book.publisher}</dd>
              </div>
            )}
            {book.pub_date && (
              <div>
                <dt className="text-gray-500">日期</dt>
                <dd className="text-gray-900">{book.pub_date}</dd>
              </div>
            )}
            <div>
              <dt className="text-gray-500">标识</dt>
              <dd className="text-gray-700 font-mono text-xs break-all">{book.identifier}</dd>
            </div>
            {book.description && (
              <div>
                <dt className="text-gray-500">简介</dt>
                <dd className="text-gray-700 leading-relaxed">{book.description}</dd>
              </div>
            )}
          </dl>
        </aside>

        {/* 右：章节目录（独立滚动 + 标题吸顶） */}
        <section className="md:min-h-0 md:overflow-y-auto md:pr-1">
          <h2 className="text-lg font-semibold text-gray-900 mb-3 md:sticky md:top-0 md:z-10 md:-mx-1 md:px-1 md:py-2 md:mb-1 md:bg-gray-50">
            目录（{sortedChapters.length}）
          </h2>
          <ol className="space-y-1 list-none">
            {sortedChapters.map((ch, idx) => {
              const progress = getChapterProgress(book.id, ch.id);
              const progressPct = Math.round(progress * 100);
              return (
                <li key={ch.id}>
                  <Link
                    to={`/books/${book.id}/chapters/${encodeURIComponent(ch.id)}`}
                    className="flex items-center gap-3 px-3 py-1.5 rounded-md bg-transparent hover:bg-white hover:shadow-sm transition-colors text-sm"
                  >
                    <span className="w-8 shrink-0 text-right text-xs text-gray-400 tabular-nums">
                      {idx + 1}
                    </span>
                    <span className="flex-1 text-gray-800 truncate" title={ch.title}>
                      {ch.title}
                    </span>
                    {progress > 0 && progress < 1 && (
                      <span className="text-xs text-amber-600 tabular-nums shrink-0">
                        {progressPct}%
                      </span>
                    )}
                    {progress >= 1 && (
                      <span className="text-xs text-green-600 shrink-0">✓</span>
                    )}
                    <span className="text-xs text-gray-400 tabular-nums shrink-0 w-14 text-right">
                      {ch.word_count} 词
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          {book.assets.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">
                资源（{book.assets.length}）
              </h2>
              <ul className="space-y-1 text-sm">
                {book.assets.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-gray-700">
                    <span className="truncate">{a.href}</span>
                    <span className="text-xs text-gray-400">
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