// 列表卡片:封面 / 标题 / 作者 / 章节数
// 深色图书馆风:书脊投影 + hover 暖金辉光;无封面时渲染书名字母印章封面。
import { Link } from 'react-router-dom';
import { assetUrl } from '../api/client';
import type { BookSummary } from '../api/types';

// 组件 Props 类型。
// 使用交叉类型 (&) 将 BookSummary 与额外的可选字段合并：
// cover_id 在 BookSummary 中已存在（string | null），这里再声明为可选（?），
// 使得传入的数据即使缺少 cover_id 也不会报类型错误（兼容性更好）。
interface Props {
  book: BookSummary & { cover_id?: string | null };
}

export function BookCard({ book }: Props) {
  // 有 cover_id 时构建封面图片 URL，否则为 null（显示降级的字母印章封面）
  const coverSrc = book.cover_id ? assetUrl(book.id, book.cover_id) : null;
  // 将文件大小从字节转为 KB，并去掉小数部分
  const sizeKb = (book.file_size / 1024).toFixed(0);
  // 多作者用逗号拼接，无作者时显示"未知作者"
  const author = book.authors.length > 0 ? book.authors.join(', ') : '未知作者';

  return (
    // Link 是 react-router-dom 的客户端导航组件，不会触发页面刷新。
    // group 是 Tailwind 的"分组选择器"，子元素可以用 group-hover: 响应父元素的 hover 状态。
    // focus:outline-none 去掉默认的聚焦轮廓（用自定义样式替代）。
    <Link
      to={`/books/${book.id}`}
      className="group block focus:outline-none"
      aria-label={`${book.title} · ${author}`}  // 无障碍标签，屏幕阅读器会读出
    >
      {/* 书籍封面容器：aspect-[2/3] 强制 2:3 纵横比（类似实体书比例） */}
      <div className="relative aspect-[2/3] rounded-md overflow-hidden shadow-book transition-all duration-300 ease-out group-hover:shadow-book-hover group-hover:-translate-y-1.5 group-focus-visible:shadow-book-hover group-focus-visible:-translate-y-1.5">
        {coverSrc ? (
          // 有封面：object-cover 让图片填满容器且不变形（裁剪溢出部分）
          // loading="lazy" 延迟加载屏幕外的图片，优化首屏性能
          <img
            src={coverSrc}
            alt={book.title}
            loading="lazy"
            className="object-cover w-full h-full transition-transform duration-500 ease-out group-hover:scale-[1.04]"
          />
        ) : (
          // 无封面：显示降级的字母印章封面组件
          <MonogramCover title={book.title} />
        )}

        {/* 书脊高光:左侧窄条,模拟书脊折光 */}
        {/* pointer-events-none 让装饰层不拦截鼠标事件 */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-[7%] bg-gradient-to-r from-black/55 via-black/15 to-transparent"
          aria-hidden="true" // 装饰性元素，屏幕阅读器跳过
        />
        {/* hover 顶部光泽：默认透明(opacity-0)，hover 时渐显(opacity-100) */}
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-white/10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          aria-hidden="true"
        />
      </div>

      {/* 书籍信息区域 */}
      <div className="mt-3 px-0.5">
        {/* 标题：line-clamp-2 限制最多 2 行，超出显示省略号 */}
        <h3
          className="font-display text-[0.95rem] leading-snug text-cream line-clamp-2 transition-colors duration-200 group-hover:text-gold-200"
          title={book.title} // 鼠标悬停显示完整标题（line-clamp 截断时有用）
        >
          {book.title}
        </h3>
        {/* 作者：truncate 单行截断 */}
        <p className="mt-1 text-xs text-cream-muted truncate" title={author}>
          {author}
        </p>
        {/* 元信息行：章节数 + 分隔点 + 文件大小 */}
        {/* tabular-nums 让数字等宽对齐，避免不同数字宽度不同导致跳动 */}
        <p className="mt-2 flex items-center gap-2 text-[0.7rem] text-cream-faint tabular-nums">
          <span>{book.chapter_count} 章</span>
          {/* 分隔用的小圆点 */}
          <span className="h-[3px] w-[3px] rounded-full bg-gold-400/50" aria-hidden="true" />
          <span>{sizeKb} KB</span>
        </p>
      </div>
    </Link>
  );
}

/** 无封面时的"印章封面":大号衬线首字 + 书名 + 暖金细线,像出版社的素面装帧。 */
function MonogramCover({ title }: { title: string }) {
  // 取书名第一个字符作为"印章"图案；trim() 去空格，空标题时用装饰符号 fallback
  const initial = (title?.trim()?.[0] ?? '❦').toUpperCase();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-gold-400/15 bg-gradient-to-br from-ink-700 via-ink-800 to-ink-950 p-4 text-center">
      {/* 大号首字：drop-shadow 添加投影增强层次感 */}
      <span className="font-display text-5xl leading-none text-gold-400/55 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
        {initial}
      </span>
      {/* 装饰分割线 */}
      <span className="h-px w-9 bg-gold-400/35" aria-hidden="true" />
      {/* 书名（最多 3 行） */}
      <span className="line-clamp-3 font-display text-[0.8rem] leading-snug text-cream-muted">
        {title || '未命名'}
      </span>
    </div>
  );
}
