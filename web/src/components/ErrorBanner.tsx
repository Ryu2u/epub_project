// 通用错误展示 banner
import { ApiClientError } from '../api/client';

interface Props {
  error: unknown;
}

export function ErrorBanner({ error }: Props) {
  if (!error) return null;
  let message = '发生未知错误';
  let code: string | null = null;
  if (error instanceof ApiClientError) {
    message = error.message;
    code = error.code;
  } else if (error instanceof Error) {
    message = error.message;
  }
  return (
    <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
      {code && (
        <div className="font-mono text-xs text-red-600 mb-1">[{code}]</div>
      )}
      <div>{message}</div>
    </div>
  );
}