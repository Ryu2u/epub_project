// Library 页：列表 + 搜索 + 上传按钮 + 分页
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookCard } from '../components/BookCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBooks } from '../hooks/useBooks';

const PAGE_SIZE = 20;

export default function LibraryPage() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useBooks(submitted, page, PAGE_SIZE);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (p: number) => {
    setPage(p);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <h1 className="text-xl font-semibold text-gray-900">EPUB 库</h1>
          <form
            className="flex-1 max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(q);
              goToPage(1);
            }}
          >
            <input
              type="search"
              placeholder="搜索书名..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full px-3 py-1.5 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            />
          </form>
          <Link
            to="/upload"
            className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            上传 EPUB
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <ErrorBanner error={error} />

        {isLoading ? (
          <div className="text-gray-500 text-center py-12">加载中...</div>
        ) : !data || data.items.length === 0 ? (
          <div className="text-gray-500 text-center py-12">
            {submitted ? '没有匹配的书' : '还没有书，去上传一本吧'}
          </div>
        ) : (
          <>
            <div className="text-sm text-gray-500 mb-4">
              共 {total} 本
              {totalPages > 1 && (
                <span className="ml-2">· 第 {page}/{totalPages} 页</span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {data.items.map((b) => (
                <BookCard key={b.id} book={b} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-8">
                <button
                  onClick={() => goToPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                >
                  上一页
                </button>
                <PageNumbers page={page} totalPages={totalPages} onGo={goToPage} />
                <button
                  onClick={() => goToPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** 页码按钮：显示首尾 + 当前页附近的页码，超出用省略号。 */
function PageNumbers({
  page,
  totalPages,
  onGo,
}: {
  page: number;
  totalPages: number;
  onGo: (p: number) => void;
}) {
  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const nodes: (number | '…')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) nodes.push('…');
    nodes.push(sorted[i]);
  }

  return (
    <div className="flex items-center gap-1">
      {nodes.map((n, i) =>
        n === '…' ? (
          <span key={`e${i}`} className="px-2 text-sm text-gray-400">
            …
          </span>
        ) : (
          <button
            key={n}
            onClick={() => onGo(n)}
            className={
              'min-w-[2rem] px-2 py-1.5 rounded-md text-sm ' +
              (n === page
                ? 'bg-blue-600 text-white'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50')
            }
          >
            {n}
          </button>
        ),
      )}
    </div>
  );
}
