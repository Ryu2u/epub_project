// ExportDialog 桌面端(客户端)模式:选格式 → 原生「另存为」→ 导出完成后
// 后端直接写盘,不再出现「下载」按钮。

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from '../components/ExportDialog';
import type { ExportFormat, TaskProgress } from '../api/client';

const startExportAsyncMock = vi.fn<
  (bookId: string, format?: ExportFormat) => Promise<{ task_id: string }>
>();
const pickSavePathMock = vi.fn<(name: string, ext: ExportFormat) => Promise<string | null>>();
const saveExportFileMock = vi.fn<(taskId: string, dest: string) => Promise<string>>();

let progressCb: ((p: TaskProgress) => void) | null = null;

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    // 桌面端
    runningInTauri: () => true,
    startExportAsync: (bookId: string, format?: ExportFormat) =>
      startExportAsyncMock(bookId, format),
    pickExportSavePath: (name: string, ext: ExportFormat) => pickSavePathMock(name, ext),
    saveExportFile: (taskId: string, dest: string) => saveExportFileMock(taskId, dest),
    subscribeProgress: (_taskId: string, onUpdate: (p: TaskProgress) => void) => {
      progressCb = onUpdate;
      return () => {};
    },
  };
});

function renderDialog() {
  return render(
    <ExportDialog open bookId="b1" bookTitle="测试书" onClose={vi.fn()} />,
  );
}

const doneFrame: TaskProgress = {
  phase: 'done',
  message: '导出完成',
  percent: 100,
  done: true,
  download_url: '/api/tasks/t1/download', // 桌面端仅作完成标志
};

describe('ExportDialog(桌面端)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressCb = null;
    startExportAsyncMock.mockResolvedValue({ task_id: 't1' });
    pickSavePathMock.mockResolvedValue('C:\\Users\\me\\Desktop\\测试书.epub');
    saveExportFileMock.mockImplementation(async (_t, dest) => dest);
  });

  it('选格式后先弹「另存为」,再开始导出', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^EPUB/ }));

    await waitFor(() =>
      expect(pickSavePathMock).toHaveBeenCalledWith('测试书.epub', 'epub'),
    );
    await waitFor(() => expect(startExportAsyncMock).toHaveBeenCalledWith('b1', 'epub'));
  });

  it('取消「另存为」不会开始导出', async () => {
    pickSavePathMock.mockResolvedValue(null);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^TXT/ }));

    await waitFor(() => expect(pickSavePathMock).toHaveBeenCalled());
    expect(startExportAsyncMock).not.toHaveBeenCalled();
    // 仍停在格式选择
    expect(screen.getByText('选择导出格式（随后选择保存位置）')).toBeInTheDocument();
  });

  it('完成后直接写入选定路径并展示位置,不出现「下载」按钮', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^EPUB/ }));
    await waitFor(() => expect(startExportAsyncMock).toHaveBeenCalled());

    await act(async () => {
      progressCb?.(doneFrame);
    });

    await waitFor(() =>
      expect(saveExportFileMock).toHaveBeenCalledWith('t1', 'C:\\Users\\me\\Desktop\\测试书.epub'),
    );
    expect(await screen.findByText(/已保存到/)).toHaveTextContent('测试书.epub');
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
  });

  it('写盘失败时提示错误并可返回重试', async () => {
    saveExportFileMock.mockRejectedValue(new Error('磁盘已满'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /^EPUB/ }));
    await waitFor(() => expect(startExportAsyncMock).toHaveBeenCalled());
    await act(async () => {
      progressCb?.(doneFrame);
    });

    expect(await screen.findByText('磁盘已满')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回重试' }));
    expect(await screen.findByText('选择导出格式（随后选择保存位置）')).toBeInTheDocument();
  });
});
