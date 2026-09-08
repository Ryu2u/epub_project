// 阅读器正文上方的章节头部（仿起点中文网阅读页）：
// 大标题 + 一行元信息：书名（可点回详情）· 作者 · 字数 · 日期。
// 渲染在滚动容器内、正文 <article> 之前，随内容一起滚动，不占常驻空间。

import { Link } from 'react-router-dom';
import { formatWordCount } from '../lib/formatWordCount';

// ISO 时间 → "2026年07月05日 19:59" 格式（与起点阅读页一致）。
// 导出供组件内与测试共用，保证跨时区断言一致。
export function formatChapterDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ReaderChapterHeaderProps {
  title: string;        // 章节标题（如 "第8章 迎福楼妖道号仙长"）
  bookTitle: string;    // 书名
  bookHref: string;     // 书详情链接（/books/:id）
  authors: string[];    // 作者列表
  wordCount: number;    // 本章字数
  date: string;         // 展示用日期（ISO 字符串，当前取书籍入库时间）
}

export function ReaderChapterHeader({
  title,
  bookTitle,
  bookHref,
  authors,
  wordCount,
  date,
}: ReaderChapterHeaderProps) {
  const dateText = formatChapterDate(date);
  const metaOpacity = 'opacity-65';

  return (
    <header className="mb-10" data-testid="reader-chapter-header">
      {/* 章节大标题 */}
      <h1 className="font-display text-2xl font-bold leading-snug">{title}</h1>

      {/* 数据行：书名 · 作者 · 字数 · 时间 */}
      <div className={`mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm ${metaOpacity}`}>
        <Link
          to={bookHref}
          className="font-medium text-current hover:opacity-80"
          title="查看书籍详情"
        >
          {bookTitle}
        </Link>
        <MetaDot />
        <span>{authors.join(' / ')}</span>
        <MetaDot />
        <span className="tabular-nums">{formatWordCount(wordCount)}</span>
        {dateText && (
          <>
            <MetaDot />
            <time className="tabular-nums">{dateText}</time>
          </>
        )}
      </div>
    </header>
  );
}

// 元信息分隔圆点（视觉细分隔符，读屏跳过）
function MetaDot() {
  return (
    <span className="opacity-50" aria-hidden="true">
      ·
    </span>
  );
}
