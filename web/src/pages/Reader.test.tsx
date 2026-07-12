// Reader 页关键交互测试
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../pages/Reader';

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
  title: 'Test Book',
  authors: ['Alice'],
  language: 'en',
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
  content: '<p>第一段文字。</p><p>第二段。</p>',
  format: 'html',
};

describe('ReaderPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/api/books/${BOOK_ID}`) && !url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => bookJson });
        }
        if (url.includes(`/chapters/${CHAPTER_ID}`)) {
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

  it('渲染章节标题和正文', async () => {
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // title 出现在顶栏，正文第一段在 <article>
    expect(await screen.findByText('第一章')).toBeInTheDocument();
    expect(await screen.findByText('第一段文字。')).toBeInTheDocument();
  });

  it('点击设置按钮弹出设置面板', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    const btn = await screen.findByRole('button', { name: /阅读设置/ });
    await user.click(btn);

    // 设置面板打开后应能看到"字号"标题
    expect(await screen.findByText('阅读设置')).toBeInTheDocument();
  });

  it('点击右上章导航链接会切到下一章 URL', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // 等加载完成
    expect(await screen.findByText('第一章')).toBeInTheDocument();

    const nextBtn = await screen.findByRole('link', { name: /下一章/ });
    expect(nextBtn.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/chapters/${encodeURIComponent('ch2')}`,
    );

    await user.click(nextBtn);
    // 因为这是 MemoryRouter，点击会改变 route，但 element 还是 ReaderPage，需要 src 接口数据
    // 这里只验证 href 拼接正确即可
  });
});

describe('useReaderProgress (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('写入再读取', async () => {
    const { getChapterProgress, setChapterProgress } = await import(
      '../hooks/useReaderProgress'
    );
    expect(getChapterProgress('bookA', 'ch1')).toBe(0);
    setChapterProgress('bookA', 'ch1', 0.42);
    expect(getChapterProgress('bookA', 'ch1')).toBeCloseTo(0.42);
    setChapterProgress('bookA', 'ch1', 1.1); // 超出范围 -> 限制到 1
    expect(getChapterProgress('bookA', 'ch1')).toBeCloseTo(1);
    setChapterProgress('bookA', 'ch1', 0); // 0 -> 删除记录
    expect(getChapterProgress('bookA', 'ch1')).toBe(0);
  });
});

describe('useReaderSettings (localStorage)', () => {
  it('默认值', async () => {
    const { useReaderSettings } = await import('../hooks/useReaderSettings');
    // 不在这里做 hook 调用（需要 React 上下文），仅做 import smoke test
    expect(typeof useReaderSettings).toBe('function');
    // 验证默认常量合理性
    const { FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX } = await import(
      '../lib/readerPrefs'
    );
    expect(FONT_SIZE_DEFAULT).toBe(16);
    expect(FONT_SIZE_MIN).toBeLessThan(FONT_SIZE_MAX);
    void waitFor; // 静默未用告警
  });
});