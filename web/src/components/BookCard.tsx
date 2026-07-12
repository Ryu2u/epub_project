// 列表卡片：封面/标题/作者/章节数
import { Link } from 'react-router-dom';
import { assetUrl } from '../api/client';
import type { BookSummary } from '../api/types';

interface Props {
  book: BookSummary & { cover_id?: string | null };
}

export function BookCard({ book }: Props) {
  const coverSrc = book.cover_id ? assetUrl(book.id, book.cover_id) : null;

  return (
    <Link
      to={`/books/${book.id}`}
      className="block rounded-lg overflow-hidden border border-gray-200 bg-white hover:shadow-md transition-shadow"
    >
      <div className="aspect-[2/3] bg-gray-100 flex items-center justify-center">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={book.title}
            className="object-cover w-full h-full"
          />
        ) : (
          <span className="text-gray-400 text-sm">无封面</span>
        )}
      </div>
      <div className="p-3">
        <div className="font-medium text-gray-900 truncate" title={book.title}>
          {book.title}
        </div>
        <div className="text-sm text-gray-500 truncate" title={book.authors.join(', ')}>
          {book.authors.length > 0 ? book.authors.join(', ') : '未知作者'}
        </div>
        <div className="mt-2 flex gap-3 text-xs text-gray-400">
          <span>{book.chapter_count} 章</span>
          <span>{(book.file_size / 1024).toFixed(1)} KB</span>
        </div>
      </div>
    </Link>
  );
}