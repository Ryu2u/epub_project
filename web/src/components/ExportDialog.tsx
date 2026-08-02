// 导出弹窗:导出中 → 完成(手动下载)/ 错误重试。
// 不用原生 <a download>:改为 fetch 拉取二进制,精确控制 loading/success/error 状态。
import { useEffect, useState } from 'react';

interface ExportDialogProps {
  open: boolean;
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}

type Phase = 'idle' | 'loading' | 'success' | 'error';

export function ExportDialog({ open, bookId, bookTitle, onClose }: ExportDialogProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [filename, setFilename] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);

  // open 为 true 时触发首次导出;关闭时清空 blob 释放内存
  useEffect(() => {
    if (open) {
      setPhase('loading');
      setError('');
      void doExport();
    } else {
      setBlob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function doExport() {
    setPhase('loading');
    setError('');
    try {
      const res = await fetch(`/api/books/${bookId}/export`, { credentials: 'include' });
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          /* 非 JSON,用默认文本 */
        }
        throw new Error(message);
      }
      const b = await res.blob();
      setFilename(parseFilename(res.headers.get('Content-Disposition'), bookTitle));
      setBlob(b);
      setPhase('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
      setPhase('error');
    }
  }

  function handleDownload() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `${bookTitle}.epub`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-gold-400/15 bg-ink-800 p-6 shadow-2xl">
        <h3 className="font-display text-lg text-cream">导出</h3>

        {phase === 'loading' && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gold-400/30 border-t-gold-400" />
            <p className="text-sm text-cream-muted">正在导出,请稍候…</p>
          </div>
        )}

        {phase === 'success' && (
          <div className="mt-4">
            <p className="text-sm text-cream-muted">导出完成</p>
            <p className="mt-1 truncate text-sm text-gold-200">{filename}</p>
          </div>
        )}

        {phase === 'error' && <p className="mt-4 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          {phase === 'error' && (
            <button
              type="button"
              onClick={() => void doExport()}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              重试
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
            disabled={phase === 'loading'}
            className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
          >
            {phase === 'success' ? '关闭' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 从 Content-Disposition 解析文件名。后端已在 filename* 和 filename 里带 .epub 后缀,
// 这里只解码不追加;没有匹配时回退用书名。
function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return `${fallback}.epub`;
  // filename*=UTF-8''<percent-encoded><.epub>
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
  return `${fallback}.epub`;
}
