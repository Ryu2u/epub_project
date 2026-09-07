// 书库迁移弹窗(桌面端专属):导出备份 / 导入备份。
// 流程:选择操作 → 文件对话框选路径 → 后台任务 + 实时进度 → 完成摘要。
// 导出:整库打包为 .epublib(manifest + 行集 JSON + storage 文件);
// 导入:合并语义——同 id/SHA 的书跳过,新书连同文件整本入库。
import { useEffect, useState } from 'react';
import {
  getMigrationResult,
  pickLibraryBackupOpenPath,
  pickLibraryBackupSavePath,
  startLibraryExport,
  startLibraryImport,
  subscribeProgress,
  type TaskProgress,
} from '../api/client';

interface MigrationDialogProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'choosing' | 'running' | 'success' | 'error';

const PHASE_LABELS: Record<string, string> = {
  preparing: '准备',
  packing: '打包',
  extracting: '解包',
  importing: '合并',
  done: '完成',
  error: '失败',
};

export function MigrationDialog({ open, onClose }: MigrationDialogProps) {
  const [phase, setPhase] = useState<Phase>('choosing');
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [resultText, setResultText] = useState('');
  const [error, setError] = useState('');

  // 关闭时重置
  useEffect(() => {
    if (!open) {
      setPhase('choosing');
      setMode(null);
      setProgress(null);
      setResultText('');
      setError('');
    }
  }, [open]);

  if (!open) return null;

  const runTask = async (taskId: string, m: 'export' | 'import') => {
    setPhase('running');
    let done = false;
    const unsub = subscribeProgress(
      taskId,
      (p) => {
        setProgress(p);
        if (!p.done || done) return;
        done = true;
        unsub();
        if (p.error_code) {
          setError(p.error_message || p.error_code);
          setPhase('error');
          return;
        }
        void (async () => {
          const result = await getMigrationResult(taskId).catch(() => null);
          setResultText(result?.[1] || p.message);
          setMode(m);
          setPhase('success');
        })();
      },
      () => {
        if (done) return;
        done = true;
        setError('进度连接中断,任务可能仍在后台执行');
        setPhase('error');
      },
    );
  };

  const handleExport = async () => {
    setMode('export');
    const dest = await pickLibraryBackupSavePath();
    if (!dest) return; // 用户取消
    try {
      const { task_id } = await startLibraryExport(dest);
      await runTask(task_id, 'export');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
      setPhase('error');
    }
  };

  const handleImport = async () => {
    setMode('import');
    const archive = await pickLibraryBackupOpenPath();
    if (!archive) return; // 用户取消
    try {
      const { task_id } = await startLibraryImport(archive);
      await runTask(task_id, 'import');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败');
      setPhase('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-gold-400/15 bg-ink-800 p-6 shadow-2xl">
        <h3 className="font-display text-lg text-cream">书库迁移 / 备份</h3>

        {phase === 'choosing' && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-cream-faint">
              在两台电脑之间搬书库:先在一台导出备份文件,拷到另一台后导入
              (导入为合并,已有的书自动跳过)
            </p>
            <button
              type="button"
              onClick={handleExport}
              className="w-full rounded-lg border border-gold-400/15 bg-ink-700/40 px-4 py-3 text-left transition-colors hover:border-gold-400/50 hover:bg-ink-700/70"
            >
              <span className="block text-sm font-medium text-cream">导出备份</span>
              <span className="mt-0.5 block text-xs text-cream-faint">
                把整库(书目 + 章节 + 文件)打包为 .epublib
              </span>
            </button>
            <button
              type="button"
              onClick={handleImport}
              className="w-full rounded-lg border border-gold-400/15 bg-ink-700/40 px-4 py-3 text-left transition-colors hover:border-gold-400/50 hover:bg-ink-700/70"
            >
              <span className="block text-sm font-medium text-cream">导入备份</span>
              <span className="mt-0.5 block text-xs text-cream-faint">
                从 .epublib 合并到本机,重复的书自动跳过
              </span>
            </button>
          </div>
        )}

        {phase === 'running' && (
          <div className="mt-4">
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-gold-400 transition-all duration-200"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                {progress?.percent ?? 0}%
              </span>
            </div>
            <div className="mt-2 text-xs text-cream-muted">
              <span className="text-gold-400">
                {PHASE_LABELS[progress?.phase ?? 'preparing'] ?? progress?.phase ?? '准备'}
              </span>
              <span className="ml-2 text-cream-faint">{progress?.message ?? '准备中…'}</span>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-gold-400">✓ {resultText}</p>
            {mode === 'export' && (
              <p className="text-xs text-cream-faint">
                把备份文件拷到另一台电脑,在其书库页选「导入备份」即可合并
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
                setError('');
                setProgress(null);
                setResultText('');
                setPhase('choosing');
              }}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              返回重试
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
