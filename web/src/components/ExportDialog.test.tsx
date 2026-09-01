// ExportDialog 单元测试：格式选择（EPUB / TXT）→ 异步导出 → 下载。
// mock ../api/client：startExportAsync 捕获 format 参数，subscribeProgress
// 由测试直接控制进度帧（模拟 SSE 完成）。
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from '../components/ExportDialog';
import type { ExportFormat } from '../api/client';

const startExportAsyncMock = vi.fn<
  (bookId: string, format?: ExportFormat) => Promise<{ task_id: string }>
>();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    startExportAsync: (bookId: string, format?: ExportFormat) =>
      startExportAsyncMock(bookId, format),
    subscribeProgress: vi.fn(() => () => {}),
  };
});

function renderDialog(overrides: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  return render(
    <ExportDialog open bookId="b1" bookTitle="测试书" onClose={vi.fn()} {...overrides} />,
  );
}

describe('ExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startExportAsyncMock.mockResolvedValue({ task_id: 't1' });
  });

  it('打开后先选格式,不会立即触发导出', async () => {
    renderDialog();
    expect(screen.getByText('选择导出格式')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^EPUB/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^TXT/ })).toBeInTheDocument();
    // 未选择格式前不调导出 API
    expect(startExportAsyncMock).not.toHaveBeenCalled();
  });

  it('选择 TXT 后按 txt 格式发起导出', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^TXT/ }));

    await waitFor(() => {
      expect(startExportAsyncMock).toHaveBeenCalledWith('b1', 'txt');
    });
  });

  it('选择 EPUB 后按 epub 格式发起导出', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^EPUB/ }));

    await waitFor(() => {
      expect(startExportAsyncMock).toHaveBeenCalledWith('b1', 'epub');
    });
  });

  it('导出 API 失败时显示错误并可返回重选格式', async () => {
    startExportAsyncMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^TXT/ }));
    expect(await screen.findByText('boom')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回重试' }));
    // 回到格式选择
    expect(await screen.findByText('选择导出格式')).toBeInTheDocument();
    expect(startExportAsyncMock).toHaveBeenCalledTimes(1);
  });
});
