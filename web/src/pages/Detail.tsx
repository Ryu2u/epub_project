// Detail 页:封面 + 元数据 + 章节目录 + 资源 + 删除 —— 深色图书馆风。
// 支持：编辑元数据、编辑章节标题、拖拽重排章节顺序。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiPatch, assetUrl } from '../api/client';
import type { ChapterContent } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  useBook,
  useBookSearch,
  useDeleteBook,
  useDeleteCover,
  useReorderChapters,
  useUpdateBook,
  useUploadCover,
} from '../hooks/useBooks';
import { getChapterProgress } from '../hooks/useReaderProgress';
import type { BookDetail } from '../api/types';

export default function DetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: book, isLoading, error } = useBook(id);
  const deleteBook = useDeleteBook();
  const uploadCover = useUploadCover();
  const removeCover = useDeleteCover();
  const updateBook = useUpdateBook(id);
  const reorderChapters = useReorderChapters(id);
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---------- 编辑模式 ----------
  const [editMode, setEditMode] = useState(false);
  // 元数据编辑草稿（editMode 开启时从 book 初始化）
  const [metaDraft, setMetaDraft] = useState({
    title: '',
    authors: '',
    language: '',
    publisher: '',
    description: '',
    identifier: '',
  });
  const [metaDirty, setMetaDirty] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);

  // 章节标题编辑
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [chapterTitleDraft, setChapterTitleDraft] = useState('');

  // 拖拽排序
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const enterEditMode = () => {
    if (!book) return;
    setMetaDraft({
      title: book.title,
      authors: book.authors.join(', '),
      language: book.language,
      publisher: book.publisher ?? '',
      description: book.description ?? '',
      identifier: book.identifier,
    });
    setMetaDirty(false);
    setEditMode(true);
  };

  const saveMetadata = async () => {
    setMetaSaving(true);
    try {
      await updateBook.mutateAsync({
        title: metaDraft.title || undefined,
        authors: metaDraft.authors
          ? metaDraft.authors.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        language: metaDraft.language || undefined,
        publisher: metaDraft.publisher || null,
        description: metaDraft.description || null,
        identifier: metaDraft.identifier || undefined,
      });
      setMetaDirty(false);
      setEditMode(false);
    } catch {
      // error 通过 updateBook.error 展示
    } finally {
      setMetaSaving(false);
    }
  };

  const saveChapterTitle = async (chapterId: string) => {
    if (!chapterTitleDraft.trim()) {
      setEditingChapterId(null);
      return;
    }
    try {
      await apiPatch<ChapterContent>(
        `/api/books/${id}/chapters/${encodeURIComponent(chapterId)}`,
        { title: chapterTitleDraft.trim() },
      );
      // apiPatch 不经过 useMutation，需要手动失效缓存触发重新加载
      await qc.invalidateQueries({ queryKey: ['book', id] });
      qc.invalidateQueries({ queryKey: ['chapter', id] });
    } catch {
      // error 展示
    }
    setEditingChapterId(null);
  };

  // ---------- 数据 ----------
  const sortedChapters = useMemo(
    () => (book ? [...book.chapters].sort((a, b) => a.spine_order - b.spine_order) : []),
    [book],
  );

  // 默认显示所有章节（包括封面/插图占位页等无内容条目）
  const displayedChapters = sortedChapters;

  // ---------- 内容搜索 ----------
  const [searchInput, setSearchInput] = useState(''); // 搜索框的实时输入
  const [searchQuery, setSearchQuery] = useState('');  // debounce 后真正触发搜索的词
  const isSearching = searchQuery.trim().length >= 2;
  const { data: searchResult, isLoading: searchLoading } = useBookSearch(id, searchQuery);

  // debounce 400ms：输入变化后等 400ms 才真正触发搜索
  useEffect(() => {
    if (searchInput.trim().length < 2) {
      setSearchQuery('');
      return;
    }
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // ---------- 封面操作 ----------
  const handleSelectFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await uploadCover.mutateAsync({ bookId: id, file });
    } catch {
      // error 通过 mutation.error 暴露
    }
  };

  const handleDeleteCover = async () => {
    try {
      await removeCover.mutateAsync(id);
    } catch {
      // 同上
    }
  };

  // ---------- 拖拽排序 ----------
  const handleDragStart = useCallback((idx: number) => {
    setDragIdx(idx);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault();
      if (dragIdx !== null && idx !== dragIdx) setOverIdx(idx);
    },
    [dragIdx],
  );

  const handleDrop = useCallback(
    async (targetIdx: number) => {
      if (dragIdx === null || dragIdx === targetIdx || !book) {
        setDragIdx(null);
        setOverIdx(null);
        return;
      }
      // 计算新的章节顺序
      const ids = displayedChapters.map((c) => c.id);
      const [moved] = ids.splice(dragIdx, 1);
      ids.splice(targetIdx, 0, moved);
      setDragIdx(null);
      setOverIdx(null);
      try {
        await reorderChapters.mutateAsync(ids);
      } catch {
        // error 通过 mutation 展示
      }
    },
    [dragIdx, displayedChapters, book, reorderChapters],
  );

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
    setOverIdx(null);
  }, []);

  // ---------- 条件渲染 ----------
  if (isLoading) {
    return (
      <div
        className="app-shell flex min-h-screen items-center justify-center bg-ink-900 text-cream-faint"
        style={{ colorScheme: 'dark' }}
      >
        <span className="font-display text-lg text-cream-muted">加载中…</span>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div
        className="app-shell min-h-screen bg-ink-900 px-6 py-10 text-cream"
        style={{ colorScheme: 'dark' }}
      >
        <div className="mx-auto max-w-3xl">
          <ErrorBanner error={error ?? new Error('书不存在')} />
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-sm text-gold-400 transition-colors hover:text-gold-200"
          >
            ← 返回书库
          </button>
        </div>
      </div>
    );
  }

  const cover = book.assets.find((a) => a.is_cover);

  return (
    <div
      className="app-shell relative min-h-screen bg-ink-900 text-cream md:flex md:h-screen md:flex-col md:overflow-hidden"
      style={{ colorScheme: 'dark' }}
    >
      <div className="shell-atmosphere" aria-hidden="true" />

      {/* ---------- 顶栏 ---------- */}
      <header className="relative z-20 shrink-0 border-b border-gold-400/10 bg-ink-900/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200"
            >
              ← 返回
            </button>
            <h1 className="truncate font-display text-xl text-cream" title={book.title}>
              {book.title}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 编辑模式切换 */}
            <button
              onClick={() => (editMode ? setEditMode(false) : enterEditMode())}
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              {editMode ? '取消' : '编辑'}
            </button>
            {editMode && metaDirty && (
              <button
                onClick={saveMetadata}
                disabled={metaSaving}
                className="rounded-full bg-gold-400 px-4 py-1.5 text-sm font-medium text-ink-900 shadow-[0_0_18px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200 disabled:opacity-50"
              >
                {metaSaving ? '保存中...' : '保存'}
              </button>
            )}
            <a
              href={`/api/books/${book.id}/export`}
              download
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              导出
            </a>
            <button
              onClick={() => setConfirmOpen(true)}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
            >
              删除
            </button>
          </div>
        </div>
      </header>

      {updateBook.error && (
        <div className="relative z-20">
          <ErrorBanner error={updateBook.error} />
        </div>
      )}

      {/* ---------- 主体 ---------- */}
      <main className="relative z-10 mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-8 px-4 py-8 sm:px-6 md:min-h-0 md:grid-cols-[280px_1fr] md:grid-rows-[minmax(0,1fr)]">
        {/* 左:封面 + 元数据 */}
        <aside className="space-y-5 md:min-h-0 md:overflow-y-auto md:pr-2">
          <CoverSection
            book={book}
            cover={cover}
            uploadCover={uploadCover}
            removeCover={removeCover}
            onSelectFile={handleSelectFile}
            onDeleteCover={handleDeleteCover}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFileChange}
            className="hidden"
          />

          {(uploadCover.error || removeCover.error) && (
            <ErrorBanner
              error={uploadCover.error ?? removeCover.error ?? new Error('封面操作失败')}
            />
          )}

          {/* 元数据：编辑模式下变输入框，否则只读显示 */}
          {editMode ? (
            <MetadataEditor
              draft={metaDraft}
              onChange={(field, value) => {
                setMetaDraft((d) => ({ ...d, [field]: value }));
                setMetaDirty(true);
              }}
            />
          ) : (
            <MetadataDisplay book={book} />
          )}
        </aside>

        {/* 右:章节目录 */}
        <section className="md:min-h-0 md:overflow-y-auto md:pr-1">
          <h2 className="mb-3 flex items-baseline gap-3 font-display text-lg text-cream md:sticky md:top-0 md:z-10 md:-mx-1 md:mb-1 md:bg-ink-900/80 md:px-1 md:py-3 md:backdrop-blur-sm">
            目录
            <span className="text-sm font-normal tabular-nums text-cream-faint">
              （{displayedChapters.length}）
            </span>
          </h2>

          {/* 搜索本书内容 */}
          <div className="relative mb-3">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cream-faint" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索本书内容…"
              className="w-full rounded-full border border-gold-400/15 bg-ink-800/60 py-1.5 pl-9 pr-3 text-xs text-cream placeholder:text-cream-faint transition-colors focus:border-gold-400/40 focus:outline-none"
            />
          </div>

          {reorderChapters.error && <ErrorBanner error={reorderChapters.error} />}

          {/* 搜索结果 或 正常章节列表 */}
          {isSearching ? (
            <SearchResults
              bookId={book.id}
              results={searchResult?.items ?? []}
              total={searchResult?.total ?? 0}
              loading={searchLoading}
              query={searchQuery}
            />
          ) : (
          <>
          <ol className="list-none space-y-0.5">
            {displayedChapters.map((ch, idx) => {
              const progress = getChapterProgress(book.id, ch.id);
              const progressPct = Math.round(progress * 100);
              const done = progress >= 1;
              const isEditing = editingChapterId === ch.id;
              const isDragging = dragIdx === idx;
              const isOver = overIdx === idx;

              return (
                <li
                  key={ch.id}
                  draggable={editMode}
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={handleDragEnd}
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
                      {idx + 1}
                    </span>

                    {/* 章节标题：编辑模式下可点击编辑 */}
                    {isEditing ? (
                      <input
                        autoFocus
                        value={chapterTitleDraft}
                        onChange={(e) => setChapterTitleDraft(e.target.value)}
                        onBlur={() => saveChapterTitle(ch.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveChapterTitle(ch.id);
                          if (e.key === 'Escape') setEditingChapterId(null);
                        }}
                        className="flex-1 rounded border border-gold-400/40 bg-ink-800 px-2 py-0.5 text-sm text-cream focus:border-gold-400 focus:outline-none"
                      />
                    ) : (
                      <>
                        {editMode ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChapterId(ch.id);
                              setChapterTitleDraft(ch.title);
                            }}
                            className="flex-1 truncate text-left font-display text-sm text-cream-muted hover:text-cream"
                            title="点击编辑标题"
                          >
                            {ch.title}
                          </button>
                        ) : (
                          <Link
                            to={`/books/${book.id}/chapters/${encodeURIComponent(ch.id)}`}
                            className="flex-1 truncate font-display text-sm text-cream-muted transition-colors group-hover:text-cream"
                            title={ch.title}
                          >
                            {ch.title}
                          </Link>
                        )}
                      </>
                    )}

                    {/* 进度指示 */}
                    {!editMode && progress > 0 && progress < 1 && (
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
                        to={`/books/${book.id}/edit/${encodeURIComponent(ch.id)}`}
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
            })}
          </ol>

          {book.assets.length > 0 && (
            <>
              <h2 className="mb-3 mt-8 flex items-baseline gap-3 font-display text-lg text-cream">
                资源
                <span className="text-sm font-normal tabular-nums text-cream-faint">
                  （{book.assets.length}）
                </span>
              </h2>
              <ul className="space-y-1 text-sm">
                {book.assets.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-cream-muted"
                  >
                    <span className="truncate font-mono text-xs">{a.href}</span>
                    <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                      {a.media_type} · {(a.size / 1024).toFixed(1)} KB
                      {a.is_cover && ' · 封面'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
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

// ==================== 子组件 ====================

/** 封面区域（悬停换/删封面） */
function CoverSection({
  book,
  cover,
  uploadCover,
  removeCover,
  onSelectFile,
  onDeleteCover,
}: {
  book: BookDetail;
  cover: BookDetail['assets'][number] | undefined;
  uploadCover: ReturnType<typeof useUploadCover>;
  removeCover: ReturnType<typeof useDeleteCover>;
  onSelectFile: () => void;
  onDeleteCover: () => void;
}) {
  return (
    <div className="group relative aspect-[2/3] w-full overflow-hidden rounded-lg shadow-book">
      {cover ? (
        <img src={assetUrl(book.id, cover.id)} alt={book.title} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 border border-gold-400/15 bg-gradient-to-br from-ink-700 via-ink-800 to-ink-950 p-4 text-center">
          <span className="font-display text-5xl text-gold-400/55">
            {(book.title?.trim()?.[0] ?? '❦').toUpperCase()}
          </span>
          <span className="h-px w-9 bg-gold-400/35" aria-hidden="true" />
          <span className="font-display text-sm text-cream-muted">无封面</span>
        </div>
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/45 group-hover:opacity-100">
        <button
          onClick={onSelectFile}
          disabled={uploadCover.isPending}
          className="rounded-full bg-white/90 px-3 py-1.5 text-sm text-ink-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {uploadCover.isPending ? '上传中...' : cover ? '更换封面' : '上传封面'}
        </button>
        {cover && (
          <button
            onClick={onDeleteCover}
            disabled={removeCover.isPending}
            className="rounded-full bg-white/90 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-white disabled:opacity-60"
          >
            {removeCover.isPending ? '删除中...' : '删除封面'}
          </button>
        )}
      </div>
    </div>
  );
}

/** 元数据只读展示 */
function MetadataDisplay({ book }: { book: BookDetail }) {
  return (
    <dl className="space-y-3 border-t border-gold-400/10 pt-5 text-sm">
      <MetaRow label="作者">
        {book.authors.length > 0 ? book.authors.join(', ') : '未知'}
      </MetaRow>
      <MetaRow label="语言">{book.language}</MetaRow>
      {book.publisher && <MetaRow label="出版">{book.publisher}</MetaRow>}
      {book.pub_date && <MetaRow label="日期">{book.pub_date}</MetaRow>}
      <div>
        <dt className="text-xs uppercase tracking-[0.18em] text-cream-faint">标识</dt>
        <dd className="mt-1 break-all font-mono text-xs text-cream-muted">{book.identifier}</dd>
      </div>
      {book.description && (
        <div>
          <dt className="text-xs uppercase tracking-[0.18em] text-cream-faint">简介</dt>
          <dd className="mt-1 leading-relaxed text-cream-muted">{book.description}</dd>
        </div>
      )}
    </dl>
  );
}

/** 元数据编辑表单 */
function MetadataEditor({
  draft,
  onChange,
}: {
  draft: { title: string; authors: string; language: string; publisher: string; description: string; identifier: string };
  onChange: (field: string, value: string) => void;
}) {
  const fields = [
    { key: 'title', label: '书名', type: 'input' },
    { key: 'authors', label: '作者', type: 'input', placeholder: '多个用逗号分隔' },
    { key: 'language', label: '语言', type: 'input' },
    { key: 'publisher', label: '出版社', type: 'input' },
    { key: 'identifier', label: '标识', type: 'input' },
    { key: 'description', label: '简介', type: 'textarea' },
  ] as const;

  return (
    <div className="space-y-3 border-t border-gold-400/10 pt-5 text-sm">
      {fields.map((f) => (
        <div key={f.key}>
          <label className="mb-1 block text-xs uppercase tracking-[0.18em] text-cream-faint">
            {f.label}
          </label>
          {f.type === 'textarea' ? (
            <textarea
              value={(draft as Record<string, string>)[f.key]}
              onChange={(e) => onChange(f.key, e.target.value)}
              rows={3}
              className="w-full rounded border border-gold-400/25 bg-ink-800 px-2 py-1.5 text-sm text-cream focus:border-gold-400/60 focus:outline-none"
            />
          ) : (
            <input
              value={(draft as Record<string, string>)[f.key]}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder={'placeholder' in f ? f.placeholder : undefined}
              className="w-full rounded border border-gold-400/25 bg-ink-800 px-2 py-1.5 text-sm text-cream focus:border-gold-400/60 focus:outline-none"
            />
          )}
        </div>
      ))}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-xs uppercase tracking-[0.18em] text-cream-faint">{label}</dt>
      <dd className="text-right text-cream">{children}</dd>
    </div>
  );
}

/** 搜索结果列表 */
function SearchResults({
  bookId,
  results,
  total,
  loading,
  query,
}: {
  bookId: string;
  results: import('../api/types').SearchResult[];
  total: number;
  loading: boolean;
  query: string;
}) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-cream-faint">搜索中…</div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-cream-faint">
        未找到「{query}」相关内容
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-cream-faint">
        在 {total} 个章节中找到匹配
      </div>
      {results.map((r) => (
        <Link
          key={r.chapter_id}
          to={`/books/${bookId}/chapters/${encodeURIComponent(r.chapter_id)}`}
          className="block rounded-md px-3 py-2.5 transition-colors hover:bg-ink-700/40"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-xs tabular-nums text-cream-faint">
              {r.spine_order + 1}.
            </span>
            <span className="font-display text-sm text-cream">
              {r.chapter_title}
            </span>
            <span className="shrink-0 text-xs text-gold-400">
              {r.match_count} 处
            </span>
          </div>
          <p
            className="mt-1 pl-5 text-xs leading-relaxed text-cream-muted [&_mark]:bg-gold-400/25 [&_mark]:text-gold-200 [&_mark]:rounded-sm [&_mark]:px-0.5"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: r.snippet }}
          />
        </Link>
      ))}
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}
