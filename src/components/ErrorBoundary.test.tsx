// ErrorBoundary:渲染错误 → 兜底界面(不再白屏);重试可恢复;
// key 变化(切页)时重建边界并清掉错误状态。

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/** 是否抛错由外部开关控制:便于模拟"重试后条件恢复"。 */
let shouldThrow = true;

function Boom() {
  if (shouldThrow) throw new Error('boom 测试错误');
  return <p>恢复正常</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React 会把错误打到 console.error,这里静音以免测试输出噪音
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shouldThrow = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('子组件抛错时显示兜底界面与错误信息', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(screen.getByText(/boom 测试错误/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到主页' })).toBeInTheDocument();
  });

  it('点「重试」后重新渲染子组件', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('页面出错了')).toBeInTheDocument();

    // 模拟崩溃原因消失(数据恢复 / 热更新等)
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('恢复正常')).toBeInTheDocument();
    expect(screen.queryByText('页面出错了')).toBeNull();
  });

  it('key 变化(切换路由)时边界重建,错误状态被清掉', () => {
    const { rerender } = render(
      <ErrorBoundary key="/boom">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('页面出错了')).toBeInTheDocument();

    shouldThrow = false;
    // App 里用 location 作 key:切到别的页面即重建边界
    rerender(
      <ErrorBoundary key="/ok">
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('恢复正常')).toBeInTheDocument();
  });

  it('无错误时正常渲染子组件', () => {
    shouldThrow = false;
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('恢复正常')).toBeInTheDocument();
    expect(screen.queryByText('页面出错了')).toBeNull();
  });
});
