// ConfirmDialog 单元测试：三种形态 —— 默认（确认/取消）、running（进度条）、
// errorText（错误 + 关闭）。running 态必须隐藏按钮（删除任务不可中断）。
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('默认形态：显示 message 与 取消/确认 按钮', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        title="删除这本书？"
        message="《测试书》将被永久删除，此操作不可恢复。"
        confirmLabel="删除"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('删除这本书？')).toBeInTheDocument();
    expect(
      screen.getByText('《测试书》将被永久删除，此操作不可恢复。'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('running 形态：显示进度条与阶段消息，隐藏所有按钮', () => {
    render(
      <ConfirmDialog
        open
        title="删除这本书？"
        message="原始 message"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        running={{ percent: 42, message: '删除章节 500/1200' }}
      />,
    );

    // 进度百分比 + 阶段消息
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('删除章节 500/1200')).toBeInTheDocument();

    // 原始 message 不再显示，按钮全部隐藏
    expect(
      screen.queryByText('原始 message'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('errorText 形态：显示错误信息，只保留 关闭 按钮', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        title="删除这本书？"
        onConfirm={onConfirm}
        onCancel={onCancel}
        errorText="进度连接中断，删除可能仍在后台进行"
      />,
    );

    expect(
      screen.getByText('进度连接中断，删除可能仍在后台进行'),
    ).toBeInTheDocument();
    // 确认按钮隐藏，只剩关闭
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('open=false 时不渲染任何内容', () => {
    render(
      <ConfirmDialog
        open={false}
        title="删除这本书？"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText('删除这本书？')).not.toBeInTheDocument();
  });
});
