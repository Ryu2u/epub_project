// 通用错误展示 banner —— 深色图书馆配色(半透明暗红)。
import { ApiClientError } from '../api/client';

// error 类型为 unknown（而非 any），这是 TypeScript 推荐的"不知道具体类型"的安全写法。
// 使用 unknown 时必须先做类型检查（如 instanceof）才能访问属性，避免运行时错误。
interface Props {
  error: unknown;
}

export function ErrorBanner({ error }: Props) {
  // 无错误时不渲染任何内容
  if (!error) return null;

  let message = '发生未知错误';  // 兜底消息
  let code: string | null = null;

  // instanceof 检查：根据错误类型提取不同的信息。
  // ApiClientError 是自定义错误类，携带业务错误码等结构化信息；
  // 普通 Error 只有 message；其他未知类型使用兜底消息。
  if (error instanceof ApiClientError) {
    message = error.message;
    code = error.code;       // 业务错误码，如 'BOOK_EXISTS'
  } else if (error instanceof Error) {
    message = error.message; // 普通 JS Error，如网络超时
  }

  return (
    // 暗红半透明背景 + 红色边框，与深色图书馆主题协调
    <div className="rounded-lg border border-red-500/25 bg-red-950/40 px-4 py-3 text-sm text-red-200">
      {/* 有业务错误码时在消息上方显示，方便定位问题 */}
      {code && (
        <div className="mb-1 font-mono text-xs text-red-400/80">[{code}]</div>
      )}
      <div>{message}</div>
    </div>
  );
}
