// 错误边界:任何页面组件抛错时,用友好界面替代整页白屏。
//
// 为什么需要:React 18 里未捕获的渲染错误会让整棵组件树卸载 ——
// 用户看到的就是空白页,而且连导航都点不了(曾因
// 「paginator.goToTextLocator is not a function」白屏过一次)。
//
// 用法:在路由外层包一层,并用 location 作 key,这样切换到别的页面
// 会自动重建边界、清掉错误状态(否则"重试"只会重复渲染同一个崩溃页面)。
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义兜底界面(可选);不传用默认样式 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留痕:开发时能直接看到组件栈,线上也可在此接入上报
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] 页面渲染出错:', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-shell-bg px-6 text-center text-shell-text">
        <p className="text-base font-medium">页面出错了</p>
        <p className="max-w-md break-words text-xs text-shell-muted">
          {error.message || '发生了未知错误'}
        </p>
        <p className="max-w-md text-[11px] text-shell-faint">
          可以重试当前页面,或回到主页;详细堆栈见开发者控制台。
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-full border border-shell-line px-4 py-2 text-sm transition-colors hover:bg-shell-card"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => window.location.assign('/')}
            className="rounded-full bg-shell-accent px-4 py-2 text-sm text-shell-onAccent transition-opacity hover:opacity-90"
          >
            回到主页
          </button>
        </div>
      </div>
    );
  }
}
