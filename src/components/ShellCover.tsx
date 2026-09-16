// 换肤外壳用的封面组件:有封面显示图片,无封面显示"首字 + 书名"素封面。
// 与 BookCard(深色图书馆风)并存 —— 这个版本走 shell 令牌,浅色/深色自适应。
//
// 质感参考 iOS「图书」App:
//   - 圆角很小(4px):书封是"方"的,不是圆角卡片;
//   - 左侧一条很淡的书脊暗部(不是硬黑条),外加静止就有的极淡斜向光泽(膜面感);
//   - 抬升与投影由调用方 className 控制:悬停只轻抬一点 + 影子变深,
//     不做彩色辉光,也不做「hover 才出现的暗角」。

import { assetUrl } from '../api/client';
import type { BookSummary } from '../api/types';

interface Props {
  book: BookSummary;
  className?: string; // 外层尺寸 + 投影,缺省撑满容器
  rounded?: string;   // 圆角,缺省 rounded-[4px](对齐 iOS 图书的方形书封)
}

export function ShellCover({ book, className = '', rounded = 'rounded-[4px]' }: Props) {
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
      {/* 书脊暗部:左侧窄条(旧版 from-black/55 太重,浅色底上像一条黑边) */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 w-[6%] bg-gradient-to-r from-black/25 via-black/8 to-transparent"
        aria-hidden="true"
      />
      {/* 膜面光泽:静止即有的极淡斜向高光,给封面一点实体书材质感 */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 via-white/0 to-black/5"
        aria-hidden="true"
      />
    </div>
  );
}
