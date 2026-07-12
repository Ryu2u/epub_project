// 删除确认对话框
import { useState } from 'react';

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  onConfirm,
  onCancel,
}: Props) {
  const [loading, setLoading] = useState(false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        {message && <p className="mt-2 text-sm text-gray-600">{message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={async () => {
              setLoading(true);
              try {
                await onConfirm();
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? '处理中...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}