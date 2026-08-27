// ReaderTocPanel 单元测试：覆盖渲染、高亮、关闭交互、键盘、自动滚动、点击跳转。
// 用 Vitest + Testing Library + MemoryRouter（与 Reader.test.tsx 同栈）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderTocPanel } from '../components/ReaderTocPanel';
import type { ChapterOut } from '../api/types';

function PanelHarness({
  initialEntries = ['/somewhere'],
  onClose = vi.fn(),
  onChapterSelect = vi.fn(),
  open = true,
  currentChapterId = 'ch1',
  chapters = TEST_CHAPTERS,
}: {
  initialEntries?: string[];
  onClose?: () => void;
  onChapterSelect?: (id: string) => void;
  open?: boolean;
  currentChapterId?: string;
  chapters?: ChapterOut[];
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="*"
            element={
              <ReaderTocPanel
                open={open}
                onClose={onClose}
                bookId="b1"
                chapters={chapters}
                currentChapterId={currentChapterId}
                onChapterSelect={onChapterSelect}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const TEST_CHAPTERS: ChapterOut[] = [
  { id: 'ch1', title: '第一章 开端', spine_order: 0, word_count: 100 },
  { id: 'ch2', title: '第二章 发展', spine_order: 1, word_count: 200 },
  { id: 'ch3', title: '第三章 高潮', spine_order: 2, word_count: 300 },
  { id: 'ch4', title: '第四章 结局', spine_order: 3, word_count: 400 },
  { id: 'ch5', title: '第五章 尾声', spine_order: 4, word_count: 150 },
];

describe('ReaderTocPanel', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onChapterSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onChapterSelect = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染所有章节项', () => {
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    expect(screen.getByText('第一章 开端')).toBeInTheDocument();
    expect(screen.getByText('第二章 发展')).toBeInTheDocument();
    expect(screen.getByText('第三章 高潮')).toBeInTheDocument();
    expect(screen.getByText('第四章 结局')).toBeInTheDocument();
    expect(screen.getByText('第五章 尾声')).toBeInTheDocument();
  });

  it('当前章节用金色左边竖线高亮', () => {
    render(
      <PanelHarness
        onClose={onClose}
        onChapterSelect={onChapterSelect}
        currentChapterId="ch2"
      />,
    );
    const currentBtn = screen.getByText('第二章 发展').closest('button')!;
    expect(currentBtn.className).toContain('border-gold-400');
    const otherBtn = screen.getByText('第一章 开端').closest('button')!;
    expect(otherBtn.className).toContain('border-transparent');
  });

  it('点击 ✕ 按钮触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.click(screen.getByRole('button', { name: /关闭目录/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    const overlay = document.querySelector('[aria-hidden="true"]')!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC 键触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭时遮罩不可点', () => {
    render(
      <PanelHarness
        open={false}
        onClose={onClose}
        onChapterSelect={onChapterSelect}
      />,
    );
    const overlay = document.querySelector('[aria-hidden="true"]')!;
    expect(overlay.className).toContain('pointer-events-none');
  });

  it('关闭时面板 translate 滑出', () => {
    render(
      <PanelHarness
        open={false}
        onClose={onClose}
        onChapterSelect={onChapterSelect}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('translate-x-full');
  });

  it('面板 aria 属性正确', () => {
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    const dialog = screen.getByRole('dialog', { name: '目录' });
    expect(dialog).toBeInTheDocument();
  });

  it('点击章节项调用 onChapterSelect 并传入该章节 id', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.click(screen.getByText('第三章 高潮').closest('button')!);
    expect(onChapterSelect).toHaveBeenCalledTimes(1);
    expect(onChapterSelect).toHaveBeenCalledWith('ch3');
  });

  it('打开时当前章节项 scrollIntoView 被调用', async () => {
    const scrollIntoViewSpy = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
      await waitFor(() => {
        expect(scrollIntoViewSpy).toHaveBeenCalled();
      });
      const callArg = scrollIntoViewSpy.mock.calls[0]?.[0] as { block?: string } | undefined;
      expect(callArg?.block).toBe('center');
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});