// Detail 页：封面 + 元数据 + 章节目录 + 资源 + 删除
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { assetUrl } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBook, useDeleteBook } from '../hooks/useBooks';
import { getChapterProgress } from '../hooks/useReaderProgress';

export default function DetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: book, isLoading, error } = useBook(id);
  const deleteBook = useDeleteBook();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sortedChapters = useMemo(
    () => (book ? [...book.chapters].sort((a, b) => a.spine_order - b.spine_order) : []),
    [book],
  );

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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              ← 返回
            </button>
            <h1 className="text-xl font-semibold text-gray-900 truncate" title={book.title}>
              {book.title}
            </h1>
          </div>
          <button
            onClick={() => setConfirmOpen(true)}
            className="px-3 py-1.5 rounded-md text-sm text-red-600 hover:bg-red-50"
          >
            删除
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        {/* 左：封面 + 元数据 */}
        <aside className="space-y-4">
          {cover ? (
            <img
              src={assetUrl(book.id, cover.id)}
              alt={book.title}
              className="w-full aspect-[2/3] object-cover rounded-lg shadow"
            />
          ) : (
            <div className="w-full aspect-[2/3] bg-gray-200 rounded-lg flex items-center justify-center text-gray-400">
              无封面
            </div>
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

        {/* 右：章节目录（点击跳到 Reader） */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
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
                    className="flex items-center gap-3 px-3 py-2 border border-gray-200 rounded-md bg-white hover:bg-gray-50 text-sm"
                  >
                    <span className="w-7 shrink-0 text-right text-xs text-gray-400 tabular-nums">
                      {idx + 1}
                    </span>
                    <span className="flex-1 text-gray-900 truncate" title={ch.title}>
                      {ch.title}
                    </span>
                    {progress > 0 && progress < 1 && (
                      <span className="text-xs text-amber-600 tabular-nums">
                        {progressPct}%
                      </span>
                    )}
                    {progress >= 1 && (
                      <span className="text-xs text-green-600">✓</span>
                    )}
                    <span className="text-xs text-gray-400 tabular-nums shrink-0">
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