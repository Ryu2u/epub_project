// 导出弹窗：格式选择（EPUB / TXT）→ 异步导出 + 实时阶段进度 → 完成后下载。
// 不用同步 GET /api/books/{id}/export（无进度反馈），改走
//   1) POST /api/books/{id}/export/async?format= → {task_id}
//   2) GET  /api/progress/{task_id}（SSE）→ 阶段 + 百分比
//   3) 完成时 progress.download_url 直接 fetch 下载文件
import { useEffect, useState } from 'react';
import {
  startExportAsync,
  subscribeProgress,
  type ExportFormat,
  type TaskProgress,
} from '../api/client';

interface ExportDialogProps {
  open: boolean;
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}

type Phase = 'choosing' | 'starting' | 'running' | 'success' | 'error';

/// 阶段名 → 中文显示标签
const PHASE_LABELS: Record<string, string> = {
  preparing: '准备',
  reading_assets: '读取资源',
  building: '打包章节',
  done: '完成',
  error: '失败',
};

export function ExportDialog({ open, bookId, bookTitle, onClose }: ExportDialogProps) {
  // format = null 表示尚未选择格式（弹窗首屏）；选定后才开始导出
  const [format, setFormat] = useState<ExportFormat | null>(null);
  const [phase, setPhase] = useState<Phase>('choosing');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // 关闭或 bookId 变更时全部重置;选定 format 后启动导出
  useEffect(() => {
    if (!open || !format) {
      setPhase('choosing');
      setError('');
      setProgress(null);
      setDownloadUrl(null);
      return;
    }
    let cancelled = false;
    let unsubscribe = () => {};

    (async () => {
        try {
          setPhase('running');
          const { task_id } = await startExportAsync(bookId, format);
          if (cancelled) return;
          unsubscribe = subscribeProgress(
            task_id,
            (p) => {
              if (cancelled) return;
              setProgress(p);
              if (p.done) {
                if (p.error_code) {
                  setError(p.error_message || p.error_code);
                  setPhase('error');
                } else if (p.download_url) {
                  setDownloadUrl(p.download_url);
                  setPhase('success');
                } else {
                  setError('导出未返回文件');
                  setPhase('error');
                }
                unsubscribe();
              }
            },
            () => {
              if (cancelled) return;
              setError('进度连接中断');
              setPhase('error');
            },
          );
        } catch (e) {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : '导出失败');
          setPhase('error');
        }
      })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, bookId, format]);

  // 切换 book / 关闭后重开时清掉上一次的选择
  useEffect(() => {
    if (!open) setFormat(null);
  }, [open]);

  if (!open) return null;

  function handleDownload() {
    if (!downloadUrl) return;
    // 通过 fetch 拉取二进制再触发下载(避免直接 window.open 触发 popup blocker)
    void (async () => {
      try {
        const res = await fetch(downloadUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const filename = parseFilename(res.headers.get('Content-Disposition'), bookTitle, format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : '下载失败');
        setPhase('error');
      }
    })();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-gold-400/15 bg-ink-800 p-6 shadow-2xl">
        <h3 className="font-display text-lg text-cream">导出</h3>

        {phase === 'choosing' && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-cream-faint">选择导出格式</p>
            <FormatOption
              label="EPUB"
              description="标准 EPUB 3 电子书,保留图片与排版"
              onClick={() => setFormat('epub')}
            />
            <FormatOption
              label="TXT"
              description="纯文本:标题顶格,正文段首空两格"
              onClick={() => setFormat('txt')}
            />
          </div>
        )}

        {phase === 'running' && <ProgressView progress={progress} />}

        {phase === 'success' && (
          <div className="mt-4">
            <p className="text-sm text-gold-400">
              ✓ 导出完成（{format === 'txt' ? 'TXT' : 'EPUB'}）
            </p>
          </div>
        )}

        {phase === 'error' && <p className="mt-4 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          {phase === 'error' && (
            <button
              type="button"
              onClick={() => {
                // 回到格式选择,可换格式重试
                setError('');
                setProgress(null);
                setDownloadUrl(null);
                setFormat(null);
                setPhase('choosing');
              }}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              返回重试
            </button>
          )}
          {phase === 'success' && (
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-full bg-gold-400 px-4 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-gold-200"
            >
              下载
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'running'}
            className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
          >
            {phase === 'success' ? '关闭' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
}

/// 格式选项卡片
function FormatOption({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-gold-400/15 bg-ink-700/40 px-4 py-3 text-left transition-colors hover:border-gold-400/50 hover:bg-ink-700/70"
    >
      <span className="block text-sm font-medium text-cream">{label}</span>
      <span className="mt-0.5 block text-xs text-cream-faint">{description}</span>
    </button>
  );
}

/// 进度展示:阶段标签 + 进度条 + 百分比 + 消息
function ProgressView({ progress }: { progress: TaskProgress | null }) {
  const pct = progress?.percent ?? 0;
  const phaseLabel = progress ? PHASE_LABELS[progress.phase] ?? progress.phase : '准备';
  const message = progress?.message ?? '准备导出…';
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-gold-400 transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-cream-faint">{pct}%</span>
      </div>
      <div className="mt-2 text-xs text-cream-muted">
        <span className="text-gold-400">{phaseLabel}</span>
        <span className="ml-2 text-cream-faint">{message}</span>
      </div>
    </div>
  );
}

/// 从 Content-Disposition 解析文件名（后端 filename* UTF-8'' 编码）。
function parseFilename(
  disposition: string | null,
  fallback: string,
  format: ExportFormat | null,
): string {
  const ext = format === 'txt' ? 'txt' : 'epub';
  if (!disposition) return `${fallback}.${ext}`;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 解码失败则回退 */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/);
  if (plain) return plain[1];
  return `${fallback}.${ext}`;
}
