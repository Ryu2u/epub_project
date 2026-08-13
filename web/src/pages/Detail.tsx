// Detail 页:封面 + 元数据 + 章节目录 + 资源 + 删除 —— 深色图书馆风。
// 支持：编辑元数据、编辑章节标题、拖拽重排章节顺序。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiPatch, assetUrl } from '../api/client';
import type { ChapterContent, ChapterOut } from '../api/types';
import { ChapterRow } from '../components/ChapterRow';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';
import { ExportDialog } from '../components/ExportDialog';
import {
  useBook,
  useBookSearch,
  useDeleteBook,
  useDeleteCover,
  useReorderChapters,
  useUpdateBook,
  useUploadCover,
} from '../hooks/useBooks';
import {
  BOOK_STATUS_EVENT,
  computeBookStatus,
  getLastReadChapter,
  readProgressMap,
  setBookStatus,
  type BookStatus,
  type ProgressMap,
} from '../hooks/useReaderProgress';
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
  const [exportOpen, setExportOpen] = useState(false);
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

  // 阅读状态（本地 localStorage）：未读 / 在读 / 已读完
  const [bookStatus, setBookStatusState] = useState<BookStatus>(() =>
    'unread',
  );
  // 章节进度：一次性 readProgressMap(bookId)，避免每章渲染都 JSON.parse。
  // progressVersion 变化时（storage/BOOK_STATUS_EVENT）重新计算。
  const [progressVersion, setProgressVersion] = useState(0);
  const progressMap: ProgressMap = useMemo(
    () => (book ? readProgressMap(book.id) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book, progressVersion],
  );

  // 初始计算 + 监听 storage 事件自动刷新
  useEffect(() => {
    if (!id) return;
    const refresh = () => {
      setBookStatusState(computeBookStatus(id, book?.chapters.length ?? 0));
      setProgressVersion((v) => v + 1);
    };
    refresh();
    window.addEventListener('storage', refresh);
    // 同 tab 内 setBookStatus 派发的事件
    window.addEventListener(BOOK_STATUS_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(BOOK_STATUS_EVENT, refresh);
    };
  }, [id, book]);

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

  // 章节标题编辑 — 旧版 saveChapterTitle 已删除，改用模块底部 saveChapterTitleById（受 ChapterRow.onSaveTitle 触发）。

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

  // ---------- 虚拟化列表（react-window FixedSizeList） ----------
  // 章节行高固定 44px（与视觉一致）；用 ResizeObserver 测右侧 section 高度，
  // fallback 600 避免 SSR/挂载前闪烁。
  const chapterListRef = useRef<HTMLElement | null>(null);
  const [listHeight, setListHeight] = useState(600);
  useEffect(() => {
    const el = chapterListRef.current;
    if (!el) return;
    // 找到 el 最近的 scrollable 祖先（右侧 section 在 md 下 overflow-y-auto）
    const scrollParent = (() => {
      let p: HTMLElement | null = el.parentElement;
      while (p) {
        const ov = getComputedStyle(p).overflowY;
        if (ov === 'auto' || ov === 'scroll') return p;
        p = p.parentElement;
      }
      return null;
    })();
    const measure = () => {
      const h = scrollParent ? scrollParent.clientHeight : el.clientHeight;
      setListHeight(Math.max(120, h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (scrollParent) ro.observe(scrollParent);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 保存章节标题（被 ChapterRow.onSaveTitle 调用）
  const saveChapterTitleById = useCallback(
    async (chapterId: string, newTitle: string) => {
      try {
        await apiPatch<ChapterContent>(
          `/api/books/${id}/chapters/${encodeURIComponent(chapterId)}`,
          { title: newTitle },
        );
        await qc.invalidateQueries({ queryKey: ['book', id] });
        qc.invalidateQueries({ queryKey: ['chapter', id] });
      } catch {
        // error 展示
      }
      setEditingChapterId(null);
    },
    [id, qc],
  );

  const cancelEditChapter = useCallback((_chapterId: string) => {
    setEditingChapterId(null);
  }, []);

  // 进入章节标题编辑模式：ChapterRow 内部 useState(ch.title) 初始化草稿
  const handleStartEditChapter = useCallback((chapterId: string, _currentTitle: string) => {
    setEditingChapterId(chapterId);
  }, []);

  const chapterListItemData = useMemo(() => {
    if (!book) return null;
    return {
      chapters: displayedChapters,
      bookId: book.id,
      editMode,
      editingChapterId,
      dragIdx,
      overIdx,
      progressMap,
      onStartEdit: handleStartEditChapter,
      onSaveTitle: saveChapterTitleById,
      onCancelEdit: cancelEditChapter,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    book,
    displayedChapters,
    editMode,
    editingChapterId,
    dragIdx,
    overIdx,
    progressMap,
    handleStartEditChapter,
    saveChapterTitleById,
    cancelEditChapter,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  ]);

  const itemKey = useCallback(
    (index: number, data: { chapters: ChapterOut[] }) => data.chapters[index].id,
    [],
  );

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
            {/* 继续阅读：跳到上次读到的章节 */}
            {(() => {
              const last = getLastReadChapter(book.id);
              if (!last) return null;
              return (
                <Link
                  to={`/books/${book.id}/chapters/${encodeURIComponent(last)}`}
                  className="rounded-full bg-gold-400 px-3 py-1.5 text-sm font-medium text-ink-900 shadow-[0_0_18px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200"
                  title={`继续阅读第 ${last} 章`}
                >
                  继续阅读
                </Link>
              );
            })()}
            {/* 手动切换状态按钮 */}
            {bookStatus === 'finished' ? (
              <button
                onClick={() => setBookStatus(book.id, 'unread')}
                className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
              >
                标记为未读
              </button>
            ) : (
              <button
                onClick={() => setBookStatus(book.id, 'finished')}
                className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
              >
                标记为已读
              </button>
            )}
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              导出
            </button>
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
        <section
          ref={chapterListRef}
          className="md:min-h-0 md:overflow-y-auto md:pr-1"
          data-testid="chapter-list"
        >
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
          <FixedSizeList
            height={listHeight}
            width="100%"
            itemSize={44}
            itemCount={displayedChapters.length}
            itemData={chapterListItemData ?? undefined}
            itemKey={itemKey}
            outerElementType="ol"
            className="list-none"
          >
            {ChapterRowVirtualized}
          </FixedSizeList>

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
      <ExportDialog
        open={exportOpen}
        bookId={book.id}
        bookTitle={book.title}
        onClose={() => setExportOpen(false)}
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

// ==================== 虚拟化行 ====================

/** react-window FixedSizeList 的行渲染器（模块级：避免每次 Detail 渲染重建）。
 *  从 itemData 取出按 index 对应的 chapter 与共享 handlers。 */
interface ChapterRowVirtualizedData {
  chapters: ChapterOut[];
  bookId: string;
  editMode: boolean;
  editingChapterId: string | null;
  dragIdx: number | null;
  overIdx: number | null;
  progressMap: ProgressMap;
  onStartEdit: (chapterId: string, currentTitle: string) => void;
  onSaveTitle: (chapterId: string, newTitle: string) => void;
  onCancelEdit: (chapterId: string) => void;
  onDragStart: (idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (idx: number) => void;
  onDragEnd: () => void;
}

function ChapterRowVirtualized({
  index,
  style,
  data,
}: ListChildComponentProps<ChapterRowVirtualizedData>) {
  const ch = data.chapters[index];
  const progress = data.progressMap[ch.id] ?? 0;
  return (
    <ChapterRow
      style={style}
      chapter={ch}
      index={index}
      bookId={data.bookId}
      editMode={data.editMode}
      isEditing={data.editingChapterId === ch.id}
      isDragging={data.dragIdx === index}
      isOver={data.overIdx === index}
      progress={progress}
      onStartEdit={data.onStartEdit}
      onSaveTitle={data.onSaveTitle}
      onCancelEdit={data.onCancelEdit}
      onDragStart={data.onDragStart}
      onDragOver={data.onDragOver}
      onDrop={data.onDrop}
      onDragEnd={data.onDragEnd}
    />
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
