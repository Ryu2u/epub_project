// Library 页：列表 + 搜索 + 上传按钮
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookCard } from '../components/BookCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { useBooks } from '../hooks/useBooks';

export default function LibraryPage() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { data, isLoading, error } = useBooks(submitted);

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
              共 {data.total} 本
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {data.items.map((b) => (
                <BookCard key={b.id} book={b} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}