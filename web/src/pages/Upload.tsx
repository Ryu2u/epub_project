// Upload 页:多文件队列 + 拖拽 + 独立进度 + 结果汇总 —— 深色图书馆风。
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useBatchUpload,
  type BatchUploadItemProgress,
} from '../hooks/useBooks';
import type { BatchUploadResult, BatchUploadResultItem } from '../api/types';

interface QueueEntry {
  file: File;
  percent: number;       // 0-100, 初始 0
  status: 'pending' | 'uploading' | 'success' | 'duplicate' | 'error';
  bookId?: string;
  title?: string;
  errorMessage?: string;
}

export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const batchUpload = useBatchUpload();

  const addFiles = useCallback((files: File[]) => {
    const epubLike = files.filter((f) => /\.ep(ub|b)$/i.test(f.name));
    if (epubLike.length === 0) return;
    setQueue((q) => [
      ...q,
      ...epubLike.map((file) => ({
        file,
        percent: 0,
        status: 'pending' as const,
      })),
    ]);
  }, []);

  const handleSelect = (files: FileList | null) => {
    if (!files) return;
    addFiles(Array.from(files));
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleSelect(e.target.files);
    e.target.value = '';
  };

  const submit = async () => {
    if (queue.length === 0) return;
    setQueue((q) => q.map((entry) => (entry.status === 'pending' ? { ...entry, status: 'uploading' as const } : entry)));
    try {
      const result = await batchUpload.mutateAsync({
        files: queue.filter((q) => q.status === 'uploading').map((q) => q.file),
        onItemProgress: (p: BatchUploadItemProgress) => {
          setQueue((q) =>
            q.map((entry, i) =>
              i === p.index && entry.file.name === p.filename
                ? { ...entry, percent: Math.round((p.loaded / p.total) * 100) }
                : entry,
            ),
          );
        },
      });
      // 用后端结果覆盖 queue 中每个条目的终态
      setQueue((q) => {
        const map = new Map<string, BatchUploadResultItem>();
        for (const it of result.items) map.set(it.filename, it);
        return q.map((entry) => {
          const it = map.get(entry.file.name);
          if (!it) return entry;
          return {
            ...entry,
            percent: 100,
            status: it.status,
            bookId: it.book_id,
            title: it.title,
            errorMessage: it.error_message,
          };
        });
      });
    } catch {
      // 用 mutation.error 展示，整批失败罕见
    }
  };

  const clearQueue = () => setQueue([]);
  const removeFromQueue = (i: number) =>
    setQueue((q) => q.filter((_, idx) => idx !== i));

  const finishAndExit = () => {
    setQueue([]);
    navigate('/');
  };

  const isUploading = queue.some((q) => q.status === 'uploading' || q.status === 'pending')
    && batchUpload.isPending;
  const summary = batchUpload.data;
  const allDone = queue.length > 0 && queue.every((q) =>
    q.status === 'success' || q.status === 'duplicate' || q.status === 'error',
  );

  return (
    <div
      className="app-shell relative min-h-screen bg-ink-900 text-cream"
      style={{ colorScheme: 'dark' }}
    >
      <div className="shell-atmosphere" aria-hidden="true" />

      {/* ---------- 顶栏 ---------- */}
      <header className="sticky top-0 z-20 border-b border-gold-400/10 bg-ink-900/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-4 sm:px-6">
          <button
            onClick={() => navigate('/')}
            className="shrink-0 rounded-full px-3 py-1.5 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-gold-200"
          >
            ← 返回
          </button>
          <h1 className="font-display text-xl text-cream">批量导入 EPUB</h1>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <main className="relative z-10 mx-auto max-w-3xl px-4 py-10 sm:px-6">
        {batchUpload.error && (
          <div className="mb-4 rounded-lg border border-red-500/25 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            批量导入失败：{batchUpload.error instanceof Error ? batchUpload.error.message : '未知错误'}
          </div>
        )}

        {/* 拖放区 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleSelect(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={[
            'group cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-200',
            dragOver
              ? 'border-gold-400 bg-gold-400/5 shadow-[0_0_40px_-10px_rgba(212,168,87,0.5)]'
              : 'border-gold-400/20 bg-ink-800/40 hover:border-gold-400/45 hover:bg-ink-800/70',
          ].join(' ')}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".epub,.epb"
            className="hidden"
            onChange={handleSelectChange}
          />
          <div className="flex flex-col items-center gap-3">
            <UploadIcon
              className={`h-10 w-10 transition-colors ${
                dragOver ? 'text-gold-400' : 'text-cream-faint group-hover:text-gold-200'
              }`}
            />
            <div>
              <div className="font-display text-lg text-cream">
                拖拽多个 EPUB 文件到此处
              </div>
              <div className="mt-2 text-sm text-cream-muted">
                或点击选择多个文件（.epub / .epb，整文件夹也可）
              </div>
            </div>
          </div>
        </div>

        {/* 文件队列 */}
        {queue.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg text-cream">
                队列{' '}
                <span className="text-sm font-normal tabular-nums text-cream-faint">
                  （{queue.length}）
                </span>
              </h2>
              <button
                type="button"
                onClick={clearQueue}
                disabled={isUploading}
                className="rounded-full px-3 py-1.5 text-xs text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
              >
                清空
              </button>
            </div>

            <ul className="space-y-2">
              {queue.map((entry, i) => (
                <li
                  key={`${entry.file.name}-${i}`}
                  className="rounded-md border border-gold-400/10 bg-ink-800/40 p-3"
                >
                  <div className="flex items-center gap-3">
                    <FileIcon className="h-5 w-5 shrink-0 text-cream-faint" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm text-cream">{entry.file.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                          {(entry.file.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <div className="mt-1.5">
                        {entry.status === 'pending' || entry.status === 'uploading' ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
                              <div
                                className="h-full rounded-full bg-gold-400 transition-all duration-200"
                                style={{ width: `${entry.percent}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                              {entry.percent}%
                            </span>
                          </div>
                        ) : (
                          <ResultLine
                            item={{
                              filename: entry.file.name,
                              status: entry.status,
                              book_id: entry.bookId,
                              title: entry.title,
                              error_code: entry.status === 'error' ? 'ERROR' : undefined,
                              error_message: entry.errorMessage,
                            }}
                          />
                        )}
                      </div>
                    </div>
                    {entry.status === 'pending' && !batchUpload.isPending && (
                      <button
                        type="button"
                        onClick={() => removeFromQueue(i)}
                        className="shrink-0 rounded-full px-2 py-1 text-xs text-cream-faint hover:bg-ink-700/60 hover:text-cream"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {/* 操作按钮 */}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={clearQueue}
                disabled={isUploading}
                className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
              >
                清空
              </button>
              {!allDone ? (
                <button
                  type="button"
                  onClick={submit}
                  disabled={queue.length === 0 || isUploading}
                  className="rounded-full bg-gold-400 px-5 py-2 text-sm font-medium text-ink-900 shadow-[0_0_22px_-6px_rgba(212,168,87,0.7)] transition-all hover:bg-gold-200 disabled:opacity-50"
                >
                  {batchUpload.isPending ? '上传中...' : `上传 ${queue.length} 本`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={finishAndExit}
                  className="rounded-full bg-gold-400 px-5 py-2 text-sm font-medium text-ink-900 transition-all hover:bg-gold-200"
                >
                  完成，返回书库
                </button>
              )}
            </div>

            {/* 完成汇总 */}
            {allDone && summary && <SummaryCard summary={summary} />}
          </div>
        )}
      </main>
    </div>
  );
}

function ResultLine({ item }: { item: BatchUploadResultItem }) {
  if (item.status === 'success') {
    return (
      <div className="text-xs">
        <span className="text-gold-400">✓ 已导入</span>
        {item.title && <span className="ml-2 text-cream-muted">「{item.title}」</span>}
      </div>
    );
  }
  if (item.status === 'duplicate') {
    return (
      <div className="text-xs">
        <span className="text-cream-faint">↻ 已存在（跳过）</span>
        {item.title && <span className="ml-2 text-cream-muted">「{item.title}」</span>}
      </div>
    );
  }
  return (
    <div className="text-xs">
      <span className="text-red-400">✗ 失败</span>
      <span className="ml-2 text-cream-muted">{item.error_code ?? 'UNKNOWN'}</span>
      {item.error_message && (
        <span className="ml-1 text-cream-faint">— {item.error_message.slice(0, 60)}</span>
      )}
    </div>
  );
}

function SummaryCard({ summary }: { summary: BatchUploadResult }) {
  return (
    <div className="mt-6 rounded-lg border border-gold-400/20 bg-ink-800/60 p-4">
      <h3 className="font-display text-base text-cream">导入汇总</h3>
      <div className="mt-3 flex gap-4 text-sm tabular-nums">
        <span className="text-gold-400">{summary.succeeded} 新增</span>
        <span className="text-cream-faint">{summary.skipped} 重复</span>
        <span className="text-red-400">{summary.failed} 失败</span>
      </div>
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 19h14" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 21V5a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}
