// Upload 页:多文件队列 + 拖拽 + 独立进度(字节上传 + 服务端处理阶段) + 结果汇总。
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  startImportAsync,
  subscribeProgress,
  type TaskProgress,
} from '../api/client';
import type { BatchUploadResult, BatchUploadResultItem } from '../api/types';

interface QueueEntry {
  file: File;
  /// 字节上传进度 0-100(0 = 未开始, 100 = 字节上传完成)
  uploadPercent: number;
  /// 服务端处理阶段('parsing' / 'writing_chapters' / 'writing_assets' / 'done' / 'duplicate' / 'error')
  phase?: string;
  phaseMessage?: string;
  /// 服务端处理进度 0-100
  phasePercent?: number;
  status: 'pending' | 'uploading' | 'processing' | 'success' | 'duplicate' | 'error';
  bookId?: string | null;
  title?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

const PHASE_LABELS: Record<string, string> = {
  parsing: '解析',
  writing_chapters: '入库',
  writing_assets: '资源入库',
  done: '完成',
  duplicate: '重复',
  error: '失败',
};

export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  // 一份独立的完成结果列表,用于 SummaryCard
  const [summary, setSummary] = useState<BatchUploadResult | null>(null);
  // 跟踪每个文件的 SSE 取消函数(组件卸载时清理)
  const cancelsRef = useRef<Map<number, () => void>>(new Map());

  const addFiles = useCallback((files: File[]) => {
    const bookLike = files.filter((f) => /\.(epub|epb|txt)$/i.test(f.name));
    if (bookLike.length === 0) return;
    setQueue((q) => [
      ...q,
      ...bookLike.map((file) => ({
        file,
        uploadPercent: 0,
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

  /// 异步上传一个文件,并通过回调把进度写回 queue[index]。
  /// 返回 BatchUploadResultItem 用于汇总。
  const uploadOne = useCallback(async (index: number, file: File): Promise<BatchUploadResultItem> => {
    const updateEntry = (patch: Partial<QueueEntry>) =>
      setQueue((q) => q.map((e, i) => (i === index ? { ...e, ...patch } : e)));

    // 1) 字节上传 → 拿到 task_id
    let taskId: string;
    try {
      const result = await startImportAsync(file, (loaded, total) => {
        updateEntry({ uploadPercent: Math.round((loaded / total) * 100) });
      });
      taskId = result.task_id;
      updateEntry({ uploadPercent: 100, status: 'processing', phase: 'parsing' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code ?? 'NETWORK_ERROR';
      updateEntry({ status: 'error', errorCode: code, errorMessage: message });
      return {
        filename: file.name,
        status: 'error',
        book_id: null,
        title: null,
        error_code: code,
        error_message: message,
      };
    }

    // 2) 订阅服务端处理进度
    return new Promise<BatchUploadResultItem>((resolve) => {
      const unsubscribe = subscribeProgress(
        taskId,
        (p: TaskProgress) => {
          updateEntry({
            phase: p.phase,
            phaseMessage: p.message,
            phasePercent: p.percent,
          });
          if (!p.done) return;
          // 终态
          unsubscribe();
          cancelsRef.current.delete(index);
          if (p.error_code === 'DUPLICATE_FILE') {
            const item: BatchUploadResultItem = {
              filename: file.name,
              status: 'duplicate',
              book_id: p.existing_book_id ?? null,
              title: null,
              error_code: 'DUPLICATE_FILE',
              error_message: null,
            };
            updateEntry({
              status: 'duplicate',
              bookId: p.existing_book_id ?? undefined,
              phase: 'duplicate',
              phasePercent: 100,
            });
            resolve(item);
            return;
          }
          if (p.error_code) {
            const item: BatchUploadResultItem = {
              filename: file.name,
              status: 'error',
              book_id: null,
              title: null,
              error_code: p.error_code,
              error_message: p.error_message ?? null,
            };
            updateEntry({
              status: 'error',
              errorCode: p.error_code,
              errorMessage: p.error_message,
              phase: 'error',
            });
            resolve(item);
            return;
          }
          const item: BatchUploadResultItem = {
            filename: file.name,
            status: 'success',
            book_id: null,
            title: null,
            error_code: null,
            error_message: null,
          };
          updateEntry({
            status: 'success',
            phase: 'done',
            phasePercent: 100,
          });
          resolve(item);
        },
        () => {
          // SSE 连接错误
          updateEntry({ status: 'error', errorCode: 'SSE_ERROR', errorMessage: '进度连接中断' });
          resolve({
            filename: file.name,
            status: 'error',
            book_id: null,
            title: null,
            error_code: 'SSE_ERROR',
            error_message: '进度连接中断',
          });
        },
      );
      cancelsRef.current.set(index, unsubscribe);
    });
  }, []);

  /// 提交整个队列:并行跑(限 4 个并发),逐个调用 uploadOne,完成后汇总。
  const submit = useCallback(async () => {
    if (queue.length === 0) return;
    const targets = queue
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.status === 'pending');
    if (targets.length === 0) return;

    // 把 pending 标记为 uploading,UI 显示字节进度
    setQueue((q) =>
      q.map((e) => (e.status === 'pending' ? { ...e, status: 'uploading' as const } : e)),
    );

    // 简易信号量
    const MAX_CONCURRENCY = 4;
    let inFlight = 0;
    const waitQueue: Array<() => void> = [];
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (inFlight < MAX_CONCURRENCY) {
          inFlight++;
          resolve();
        } else {
          waitQueue.push(() => {
            inFlight++;
            resolve();
          });
        }
      });
    const release = () => {
      if (waitQueue.length) waitQueue.shift()!();
      else inFlight--;
    };

    const results = await Promise.all(
      targets.map(async ({ e, i }) => {
        await acquire();
        try {
          return await uploadOne(i, e.file);
        } finally {
          release();
        }
      }),
    );

    const succeeded = results.filter((r) => r.status === 'success').length;
    const skipped = results.filter((r) => r.status === 'duplicate').length;
    const failed = results.filter((r) => r.status === 'error').length;
    setSummary({
      items: results,
      total: results.length,
      succeeded,
      skipped,
      failed,
    });
  }, [queue, uploadOne]);

  const clearQueue = () => {
    // 取消所有进行中的 SSE
    cancelsRef.current.forEach((fn) => fn());
    cancelsRef.current.clear();
    setQueue([]);
    setSummary(null);
  };
  const removeFromQueue = (i: number) => {
    const cancel = cancelsRef.current.get(i);
    if (cancel) {
      cancel();
      cancelsRef.current.delete(i);
    }
    setQueue((q) => q.filter((_, idx) => idx !== i));
  };

  const finishAndExit = () => {
    cancelsRef.current.forEach((fn) => fn());
    cancelsRef.current.clear();
    setQueue([]);
    navigate('/');
  };

  const isUploading =
    queue.some((q) => q.status === 'uploading' || q.status === 'processing') &&
    summary === null;
  const allDone = queue.length > 0 && queue.every((q) =>
    ['success', 'duplicate', 'error'].includes(q.status),
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
          <h1 className="font-display text-xl text-cream">批量导入书籍</h1>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <main className="relative z-10 mx-auto max-w-3xl px-4 py-10 sm:px-6">
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
            accept=".epub,.epb,.txt"
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
                拖拽书籍文件到此处
              </div>
              <div className="mt-2 text-sm text-cream-muted">
                或点击选择多个文件（.epub / .epb / .txt，整文件夹也可）
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
                        <ProgressLine entry={entry} />
                      </div>
                    </div>
                    {entry.status === 'pending' && summary === null && (
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
                  {isUploading ? '处理中...' : `上传 ${queue.length} 本`}
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

/** 单行进度:pending/uploading 显示字节进度,processing 显示阶段,完成显示终态。 */
function ProgressLine({ entry }: { entry: QueueEntry }) {
  if (entry.status === 'pending') {
    return (
      <div className="flex items-center gap-2 text-xs text-cream-faint">
        <span>等待上传…</span>
      </div>
    );
  }
  if (entry.status === 'uploading') {
    return (
      <div className="flex items-center gap-2">
        <Bar percent={entry.uploadPercent} />
        <span className="shrink-0 text-xs tabular-nums text-cream-faint">
          上传 {entry.uploadPercent}%
        </span>
      </div>
    );
  }
  if (entry.status === 'processing') {
    const pct = entry.phasePercent ?? 0;
    const label = PHASE_LABELS[entry.phase ?? ''] ?? '处理';
    return (
      <div>
        <div className="flex items-center gap-2">
          <Bar percent={pct} />
          <span className="shrink-0 text-xs tabular-nums text-cream-faint">
            {pct}%
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-cream-muted">
          <span className="text-gold-400">{label}</span>
          {entry.phaseMessage && (
            <span className="ml-2 text-cream-faint">{entry.phaseMessage}</span>
          )}
        </div>
      </div>
    );
  }
  // success / duplicate / error
  return <ResultLine item={resultItemFromEntry(entry)} />;
}

function Bar({ percent }: { percent: number }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
      <div
        className="h-full rounded-full bg-gold-400 transition-all duration-200"
        style={{ width: `${percent}%` }}
      />
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
        {item.book_id && (
          <span className="ml-2 font-mono text-cream-faint">{item.book_id.slice(0, 8)}…</span>
        )}
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

function resultItemFromEntry(entry: QueueEntry): BatchUploadResultItem {
  return {
    filename: entry.file.name,
    status: entry.status === 'success' ? 'success' : entry.status === 'duplicate' ? 'duplicate' : 'error',
    book_id: entry.bookId ?? null,
    title: entry.title ?? null,
    error_code: entry.errorCode ?? null,
    error_message: entry.errorMessage ?? null,
  };
}

function SummaryCard({ summary }: { summary: BatchUploadResult }) {
  return (
    <div className="mt-6 rounded-lg border border-gold-400/20 bg-ink-800/60 p-4">
      <h3 className="font-display text-base text-cream">导入汇总</h3>
      <div className="mt-3 flex gap-4 text-sm tabular-nums">
        <span className="text-gold-400">{summary.succeeded} 新增</span>
        {summary.skipped > 0 && (
          <span className="text-cream-faint">{summary.skipped} 重复</span>
        )}
        {summary.failed > 0 && (
          <span className="text-red-400">{summary.failed} 失败</span>
        )}
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