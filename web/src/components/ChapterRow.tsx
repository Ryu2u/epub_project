// 详情页章节目录的单行组件。
// 纯展示 + 交互回调，无业务状态。
// 父组件 DetailPage 持有 editMode/chapters/handlers 等；本组件只渲染一行 + 透传事件。
// 用 React.memo 包裹：props 不变时跳过重渲染，对 2000+ 章列表是必要的优化。
// 虚拟化（react-window）友好：编辑标题时的草稿保存在 row 内部 useState，卸载/挂载时丢失
// （用户没保存就滚走的已知 trade-off，对极少用的标题编辑功能可接受）。

import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChapterOut } from '../api/types';

export interface ChapterRowProps {
  chapter: ChapterOut;
  index: number;
  bookId: string;
  editMode: boolean;
  /** 当前行是否正在被编辑标题（受控：父组件持有 editingChapterId） */
  isEditing: boolean;
  isDragging: boolean;
  isOver: boolean;
  progress: number;
  // 交互回调（父组件已 useCallback 稳定）
  onStartEdit: (chapterId: string, currentTitle: string) => void;
  onSaveTitle: (chapterId: string, newTitle: string) => void;
  onCancelEdit: (chapterId: string) => void;
  onDragStart: (idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (idx: number) => void;
  onDragEnd: () => void;
}

/** 详情页章节目录的虚拟化适配行。
 *  当被 react-window 的 FixedSizeList 包裹时，父组件会传入额外的 `style` prop（来自 ListChildComponentProps）。
 *  组件本身只关心业务 props；style 由虚拟化父层注入并 spread 到 <li>。 */
function ChapterRowImpl(props: ChapterRowProps & { style?: React.CSSProperties }) {
  const {
    chapter: ch,
    index,
    bookId,
    editMode,
    isEditing,
    isDragging,
    isOver,
    progress,
    onStartEdit,
    onSaveTitle,
    onCancelEdit,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    style,
  } = props;

  const progressPct = Math.round(progress * 100);
  const done = progress >= 1;
  const showPercent = progress > 0 && progress < 1;

  // 编辑标题时的草稿（row 自治）。Esc 调 onCancelEdit；Enter/Blur 调 onSaveTitle。
  const [titleDraft, setTitleDraft] = useState(ch.title);
  // 当 isEditing 由 false 变 true，重置 draft
  // 这里用 key 变化触发更稳，但 useState 已经能保存旧值；
  // 简单做法：onStartEdit 由父组件触发后 props.isEditing 变 true 时我们已显示 input。
  // 卸载/挂载时 useState 重置为当前 ch.title（因为 memo + style prop 变化会重挂载）

  return (
    <li
      style={style}
      draggable={editMode}
      onDragStart={() => onDragStart(index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={() => onDrop(index)}
      onDragEnd={onDragEnd}
      className={[
        'rounded-md transition-all',
        isDragging ? 'opacity-40' : '',
        isOver ? 'border-t-2 border-gold-400' : '',
        editMode ? 'cursor-grab active:cursor-grabbing' : '',
      ].join(' ')}
    >
      <div className="group flex items-center gap-3 px-3 py-2">
        {/* 拖拽手柄 */}
        {editMode && (
          <span className="shrink-0 text-cream-faint" aria-hidden="true">
            ⠿
          </span>
        )}

        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-cream-faint group-hover:text-gold-200">
          {index + 1}
        </span>

        {/* 章节标题：编辑模式下可点击编辑 */}
        {isEditing ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const trimmed = titleDraft.trim();
              if (trimmed && trimmed !== ch.title) {
                onSaveTitle(ch.id, trimmed);
              } else {
                onCancelEdit(ch.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const trimmed = titleDraft.trim();
                if (trimmed && trimmed !== ch.title) {
                  onSaveTitle(ch.id, trimmed);
                } else {
                  onCancelEdit(ch.id);
                }
              }
              if (e.key === 'Escape') onCancelEdit(ch.id);
            }}
            className="flex-1 rounded border border-gold-400/40 bg-ink-800 px-2 py-0.5 text-sm text-cream focus:border-gold-400 focus:outline-none"
          />
        ) : editMode ? (
          <button
            type="button"
            onClick={() => onStartEdit(ch.id, ch.title)}
            className="flex-1 truncate text-left font-display text-sm text-cream-muted hover:text-cream"
            title="点击编辑标题"
          >
            {ch.title}
          </button>
        ) : (
          <Link
            to={`/books/${bookId}/chapters/${encodeURIComponent(ch.id)}`}
            className="flex-1 truncate font-display text-sm text-cream-muted transition-colors group-hover:text-cream"
            title={ch.title}
          >
            {ch.title}
          </Link>
        )}

        {/* 进度指示 */}
        {!editMode && showPercent && (
          <span className="shrink-0 text-xs tabular-nums text-gold-400">
            {progressPct}%
          </span>
        )}
        {!editMode && done && (
          <span className="shrink-0 text-xs text-gold-400" aria-label="已读完">
            ✓
          </span>
        )}

        {/* 正文编辑按钮 */}
        {editMode && (
          <Link
            to={`/books/${bookId}/edit/${encodeURIComponent(ch.id)}`}
            className="shrink-0 rounded-full px-2 py-0.5 text-xs text-cream-faint transition-colors hover:bg-ink-700/60 hover:text-gold-200"
            title="编辑正文"
          >
            编辑
          </Link>
        )}

        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-cream-faint">
          {ch.word_count} 词
        </span>
      </div>
    </li>
  );
}

export const ChapterRow = memo(ChapterRowImpl);
