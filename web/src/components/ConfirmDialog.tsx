// 删除确认对话框 —— 深色图书馆配色。
// 三种展示形态：
//   1. 默认：message + 取消/确认按钮
//   2. running（进度态）：显示进度条 + 阶段消息，隐藏按钮（删除任务不可中断）
//   3. errorText（错误态）：显示错误信息 + 只留"关闭"按钮
import { useState } from 'react';

// 对话框的 Props 类型定义。
// open: 控制是否显示对话框（父组件控制显隐）
// title: 对话框标题
// message: 可选的提示信息（? 表示可选属性，可传可不传）
// confirmLabel: 确认按钮文字，默认 '确认'
// onConfirm: 点击确认时的回调（返回 void 或 Promise<void>）
// onCancel: 点击取消/关闭时的回调
// running: 进行中状态（如异步删除大书）。非空时显示进度条并隐藏操作按钮
// errorText: 失败信息。非空时显示错误 + 只留"关闭"按钮
interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  running?: { percent: number; message: string } | null;
  errorText?: string | null;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',    // 参数默认值：不传时使用 '确认'
  onConfirm,
  onCancel,
  running = null,
  errorText = null,
}: Props) {
  // loading 状态：确认操作可能涉及异步请求（如删除 API），需要禁用按钮防止重复点击
  const [loading, setLoading] = useState(false);

  // 条件渲染：open 为 false 时不渲染任何 DOM（而非隐藏，节省性能）
  if (!open) return null;

  const showActions = !running && !errorText;

  // fixed inset-0 全屏定位，z-50 确保在最上层
  // bg-black/60 半透明黑色背景 + backdrop-blur-sm 背景模糊，聚焦用户注意力到对话框
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* 对话框主体：圆角卡片 + 暗色背景 + 金色边框 */}
      <div className="w-full max-w-sm rounded-xl border border-gold-400/15 bg-ink-800 p-6 shadow-2xl">
        <h3 className="font-display text-lg text-cream">{title}</h3>

        {/* 进度态：红色进度条 + 阶段消息（大书删除各阶段实时反馈） */}
        {running && (
          <div className="mt-4" data-testid="confirm-progress">
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, running.percent))}%` }}
                />
              </div>
              <span className="shrink-0 text-xs tabular-nums text-cream-faint">
                {running.percent}%
              </span>
            </div>
            <p className="mt-2 text-xs text-cream-muted">{running.message}</p>
          </div>
        )}

        {/* 错误态：红色提示文本 */}
        {errorText && !running && (
          <p className="mt-3 text-sm leading-relaxed text-red-400">{errorText}</p>
        )}

        {/* 默认态：message 用 && 短路渲染：有值时才显示 */}
        {!running && !errorText && message && (
          <p className="mt-2 text-sm leading-relaxed text-cream-muted">{message}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {showActions && (
            <>
              <button
                type="button"
                onClick={onCancel}
                disabled={loading}   // 加载中时禁用取消按钮，防止操作冲突
                className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLoading(true);   // 进入加载态
                  try {
                    await onConfirm(); // 等待确认操作完成（可能是异步的删除 API 调用）
                  } finally {
                    // finally 保证无论成功或失败都会恢复按钮状态
                    setLoading(false);
                  }
                }}
                disabled={loading}     // 加载中时禁用，防止重复提交
                className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                {/* 加载中显示"处理中..."，否则显示自定义按钮文字 */}
                {loading ? '处理中...' : confirmLabel}
              </button>
            </>
          )}
          {errorText && !running && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              关闭
            </button>
          )}
          {/* running 态不渲染任何按钮：任务在后台不可中断，只能等待 */}
        </div>
      </div>
    </div>
  );
}
