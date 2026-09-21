// MigrationDialog(书库迁移 / 备份):导出备份完成后自动打开所在目录;
// 导入不打开(导入的是别处来的文件,打开它所在目录没有意义);
// 用户取消选路径时既不导出也不打开。

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationDialog } from '../components/MigrationDialog';
import type { TaskProgress } from '../api/client';

const pickSavePathMock = vi.fn<() => Promise<string | null>>();
const pickOpenPathMock = vi.fn<() => Promise<string | null>>();
const startExportMock = vi.fn<(dest: string) => Promise<{ task_id: string }>>();
const startImportMock = vi.fn<(archive: string) => Promise<{ task_id: string }>>();
const getResultMock = vi.fn<(id: string) => Promise<[string, string] | null>>();
const openContainingFolderMock = vi.fn<(path: string) => Promise<void>>();

let progressCb: ((p: TaskProgress) => void) | null = null;

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    pickLibraryBackupSavePath: () => pickSavePathMock(),
    pickLibraryBackupOpenPath: () => pickOpenPathMock(),
    startLibraryExport: (dest: string) => startExportMock(dest),
    startLibraryImport: (archive: string) => startImportMock(archive),
    getMigrationResult: (id: string) => getResultMock(id),
    openContainingFolder: (path: string) => openContainingFolderMock(path),
    subscribeProgress: (_taskId: string, onUpdate: (p: TaskProgress) => void) => {
      progressCb = onUpdate;
      return () => {};
    },
  };
});

const doneFrame: TaskProgress = {
  phase: 'done',
  message: '完成',
  percent: 100,
  done: true,
};

const BACKUP_PATH = '/Users/me/Desktop/书库备份.epublib';

function renderDialog() {
  return render(<MigrationDialog open onClose={vi.fn()} />);
}

describe('MigrationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressCb = null;
    pickSavePathMock.mockResolvedValue(BACKUP_PATH);
    pickOpenPathMock.mockResolvedValue('/Users/me/Downloads/别人的备份.epublib');
    startExportMock.mockResolvedValue({ task_id: 't1' });
    startImportMock.mockResolvedValue({ task_id: 't2' });
    getResultMock.mockResolvedValue(['{}', '导出完成:3 本书']);
    openContainingFolderMock.mockResolvedValue(undefined);
  });

  it('导出备份完成后打开所在目录', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /导出备份/ }));
    await waitFor(() => expect(startExportMock).toHaveBeenCalledWith(BACKUP_PATH));
    await act(async () => {
      progressCb?.(doneFrame);
    });

    await waitFor(() =>
      expect(openContainingFolderMock).toHaveBeenCalledWith(BACKUP_PATH),
    );
  });

  it('导入备份完成后不打开目录', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /导入备份/ }));
    await waitFor(() => expect(startImportMock).toHaveBeenCalled());
    await act(async () => {
      progressCb?.(doneFrame);
    });

    expect(await screen.findByText(/导出完成:3 本书/)).toBeInTheDocument();
    expect(openContainingFolderMock).not.toHaveBeenCalled();
  });

  it('用户取消选路径时既不导出也不打开目录', async () => {
    pickSavePathMock.mockResolvedValue(null);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /导出备份/ }));
    await waitFor(() => expect(pickSavePathMock).toHaveBeenCalled());

    expect(startExportMock).not.toHaveBeenCalled();
    expect(openContainingFolderMock).not.toHaveBeenCalled();
  });

  it('导出失败时不打开目录', async () => {
    getResultMock.mockResolvedValue(null);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /导出备份/ }));
    await waitFor(() => expect(startExportMock).toHaveBeenCalled());
    await act(async () => {
      progressCb?.({ ...doneFrame, error_code: 'IO', error_message: '磁盘已满' });
    });

    expect(await screen.findByText('磁盘已满')).toBeInTheDocument();
    expect(openContainingFolderMock).not.toHaveBeenCalled();
  });
});
