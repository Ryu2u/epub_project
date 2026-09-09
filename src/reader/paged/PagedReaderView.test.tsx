// PagedReaderView 冒烟测试(经 Reader 页集成)。
// jsdom 无真实布局(getClientRects 为空)→ 分页引擎走「整章单页」
// 兜底路径,正好覆盖该分支;真实行盒切页由 paginator.test.ts 的
// 假几何单测覆盖。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../../pages/Reader';
import { KEY_FLIP_STYLE, KEY_READER_MODE } from '../../lib/readerPrefs';

function ReaderHarness({ initialRoute }: { initialRoute: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="/books/:bookId/chapters/:chapterId"
            element={<ReaderPage />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const BOOK_ID = 'b1';
const CHAPTER_ID = 'ch1';

const bookJson = {
  id: BOOK_ID,
  title: '测试之书',
  authors: ['Alice'],
  language: 'zh',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:test',
  file_size: 1000,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [
    { id: 'ch1', title: '第一章', spine_order: 0, word_count: 100 },
    { id: 'ch2', title: '第二章', spine_order: 1, word_count: 50 },
  ],
  assets: [],
};

const chapterJson = {
  title: '第一章',
  content: '<p>分页正文第一段。</p><p>第二段内容。</p>',
  format: 'html',
};

describe('PagedReaderView(经 Reader 集成)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/api/books/${BOOK_ID}`) && !url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => bookJson });
        }
        if (url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => chapterJson });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('mode=paged 时渲染分页视图:整章单页兜底 + 页脚页码', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    const stage = await screen.findByLabelText('分页正文');
    // 章节标题以 <h3> 注入正文首位(顶部小字标题栏已取消)
    const cur = stage.querySelector('.paged-page-cur') as HTMLElement;
    expect(cur.querySelector('h3')?.textContent).toBe('第一章');
    // jsdom 无布局 → 单页兜底,整章内容都在第一页
    expect(await within(stage).findByText('分页正文第一段。')).toBeInTheDocument();
    expect(await within(stage).findByText('第二段内容。')).toBeInTheDocument();
    // 页脚:第 1 / 2 章 · 1 / 1 页,本章 100%
    const foot = document.querySelector('.paged-foot') as HTMLElement;
    expect(foot.textContent).toContain('1 / 1 页');
    expect(await screen.findByText('本章 100%')).toBeInTheDocument();
  });

  it('设置面板切换 滚动→分页 即时生效', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // 打开设置面板
    const btn = (await screen.findAllByRole('button', { name: /阅读设置/ }))[1];
    await user.click(btn);
    expect(await screen.findByText('阅读模式')).toBeInTheDocument();

    // 点击「分页」
    await user.click(await screen.findByRole('button', { name: '分页' }));
    // 分页视图挂载(单页兜底渲染出正文)
    const stage = await screen.findByLabelText('分页正文');
    expect(await within(stage).findByText('分页正文第一段。')).toBeInTheDocument();
    // 持久化
    expect(localStorage.getItem(KEY_READER_MODE)).toBe('paged');

    // 切回滚动
    await user.click(await screen.findByRole('button', { name: '滚动' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('分页正文')).toBeNull();
    });
    expect(await screen.findByRole('article')).toBeInTheDocument();
  });

  it('翻页效果偏好持久化', async () => {
    const user = userEvent.setup();
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    const btn = (await screen.findAllByRole('button', { name: /阅读设置/ }))[1];
    await user.click(btn);
    await user.click(await screen.findByRole('button', { name: '平移' }));
    expect(localStorage.getItem(KEY_FLIP_STYLE)).toBe('slide');
  });
});
