// 换肤外壳用的封面组件:有封面显示图片,无封面显示"首字 + 书名"素封面。
// 与 BookCard(深色图书馆风)并存 —— 这个版本走 shell 令牌,浅色/深色自适应。
// 自带"实体书"质感:左侧书脊折光窄条 + hover 顶部光泽(依赖父级 group)。
// 书脊投影(shadow-book)由调用方通过 className 控制,按场景强弱选择。

import { assetUrl } from '../api/client';
import type { BookSummary } from '../api/types';

interface Props {
  book: BookSummary;
  className?: string; // 外层尺寸 + 投影,缺省撑满容器
  rounded?: string;   // 圆角,缺省 rounded-[6px]
}

export function ShellCover({ book, className = '', rounded = 'rounded-[6px]' }: Props) {
  const coverSrc = book.cover_id ? assetUrl(book.id, book.cover_id) : null;
  return (
    <div className={`relative overflow-hidden ${rounded} ${className}`}>
      {coverSrc ? (
        <img
          src={coverSrc}
          alt={book.title}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        // 素封面:浅色主题下用灰底 + 主色首字;深色主题自动换金调
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 border border-shell-line bg-shell-track p-2 text-center">
          <span className="text-xl font-bold text-shell-accent">
            {(book.title.trim()[0] ?? '书').toUpperCase()}
          </span>
          <span className="line-clamp-2 text-[0.6rem] leading-tight text-shell-muted">
            {book.title}
          </span>
        </div>
      )}
      {/* 书脊高光:左侧窄条,模拟书脊折光(实体书效果) */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-[7%] bg-gradient-to-r from-black/55 via-black/15 to-transparent"
        aria-hidden="true"
      />
      {/* hover 顶部光泽:默认透明,父级 group hover 时渐显 */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-white/10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        aria-hidden="true"
      />
    </div>
  );
}
