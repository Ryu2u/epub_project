// 导出弹窗：格式选择（EPUB / TXT）→ 异步导出 + 实时阶段进度 → 保存。
//
// 两种落盘方式:
//   - 客户端(桌面端):选格式后弹原生「另存为」→ 导出完成后由后端
//     直接把字节写进用户指定路径(save_export_file,字节不过 IPC)
//   - 浏览器:完成后 fetchExportFile 取 blob → <a download> 保存
import { useEffect, useRef, useState } from 'react';
import {
  fetchExportFile,
  pickExportSavePath,
  runningInTauri,
  saveExportFile,
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
  // 客户端模式:用户在「另存为」里选定的保存路径
  const [savePath, setSavePath] = useState<string | null>(null);
  // 客户端模式:实际写入的路径(成功后展示)
  const [savedTo, setSavedTo] = useState<string | null>(null);
  // 任务 id:浏览器模式下的 download_url 兜底 / 客户端写盘时定位结果
  const taskIdRef = useRef<string>('');
  // 客户端(桌面端)与浏览器两种落盘方式
  const isDesktop = runningInTauri();

  // 选择格式:客户端先弹原生「另存为」,取消则留在格式选择
  const chooseFormat = async (fmt: ExportFormat) => {
    if (runningInTauri()) {
      const ext: ExportFormat = fmt === 'txt' ? 'txt' : 'epub';
      const dest = await pickExportSavePath(`${bookTitle}.${ext}`, ext);
      if (!dest) return; // 取消保存 → 不开始导出
      setSavePath(dest);
    }
    setFormat(fmt);
  };

  // 关闭或 bookId 变更时全部重置;选定 format（客户端还需选定路径）后启动导出
  useEffect(() => {
    if (!open || !format) {
      setPhase('choosing');
      setError('');
      setProgress(null);
      setDownloadUrl(null);
      setSavedTo(null);
      taskIdRef.current = '';
      return;
    }
    // 客户端:等保存路径选定后再开始,避免白跑一次导出
    if (runningInTauri() && !savePath) return;
    let cancelled = false;
    let unsubscribe = () => {};

    (async () => {
        try {
          setPhase('running');
          const { task_id } = await startExportAsync(bookId, format);
          if (cancelled) return;
          taskIdRef.current = task_id;
          unsubscribe = subscribeProgress(
            task_id,
            (p) => {
              if (cancelled) return;
              setProgress(p);
              if (!p.done) return;
              unsubscribe();
              if (p.error_code) {
                setError(p.error_message || p.error_code);
                setPhase('error');
                return;
              }
              if (runningInTauri()) {
                // 客户端:后端直接把打包结果写进用户选定路径(字节不过 IPC)
                void (async () => {
                  try {
                    const finalPath = await saveExportFile(task_id, savePath as string);
                    if (cancelled) return;
                    setSavedTo(finalPath);
                    setPhase('success');
                  } catch (e) {
                    if (cancelled) return;
                    setError(e instanceof Error ? e.message : '保存失败');
                    setPhase('error');
                  }
                })();
                return;
              }
              // 浏览器:拿 download_url 供 <a download>
              if (p.download_url) {
                setDownloadUrl(p.download_url);
                setPhase('success');
              } else {
                setError('导出未返回文件');
                setPhase('error');
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
  }, [open, bookId, format, savePath]);

  // 切换 book / 关闭后重开时清掉上一次的选择
  useEffect(() => {
    if (!open) {
      setFormat(null);
      setSavePath(null);
    }
  }, [open]);

  if (!open) return null;

  function handleDownload() {
    if (!downloadUrl && !taskIdRef.current) return;
    // 双模式取文件(浏览器 fetch download_url;Tauri invoke 取字节),
    // 再通过 blob + <a download> 触发保存(避免 popup blocker)
    void (async () => {
      try {
        const ext = format === 'txt' ? 'txt' : 'epub';
        const { blob, filename } = await fetchExportFile(
          downloadUrl,
          taskIdRef.current,
          `${bookTitle}.${ext}`,
        );
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
            <p className="text-xs text-cream-faint">
              选择导出格式{isDesktop ? '（随后选择保存位置）' : ''}
            </p>
            <FormatOption
              label="EPUB"
              description="标准 EPUB 3 电子书,保留图片与排版"
              onClick={() => void chooseFormat('epub')}
            />
            <FormatOption
              label="TXT"
              description="纯文本:标题顶格,正文段首空两格"
              onClick={() => void chooseFormat('txt')}
            />
          </div>
        )}

        {phase === 'running' && <ProgressView progress={progress} />}

        {phase === 'success' && (
          <div className="mt-4 space-y-1">
            <p className="text-sm text-gold-400">
              ✓ 导出完成（{format === 'txt' ? 'TXT' : 'EPUB'}）
            </p>
            {savedTo && (
              <p className="break-all text-xs text-cream-faint" title={savedTo}>
                已保存到 {savedTo}
              </p>
            )}
          </div>
        )}

        {phase === 'error' && <p className="mt-4 text-sm text-red-400">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          {phase === 'error' && (
            <button
              type="button"
              onClick={() => {
                // 回到格式选择,可换格式/换路径重试
                setError('');
                setProgress(null);
                setDownloadUrl(null);
                setSavedTo(null);
                setSavePath(null);
                setFormat(null);
                setPhase('choosing');
              }}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              返回重试
            </button>
          )}
          {/* 客户端已在导出完成后直接写盘,不再需要"下载"按钮 */}
          {phase === 'success' && !isDesktop && (
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-full bg-gold-400 px-4 py-2 text-sm font-medium text-gold-on transition-colors hover:bg-gold-200"
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
