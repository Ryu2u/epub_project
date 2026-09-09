// 滚动模式下的搜索命中定位(?q&n&b):进入章节后选中并高亮命中处

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../pages/Reader';
import { KEY_READER_MODE } from '../lib/readerPrefs';

function ReaderHarness({ initialRoute }: { initialRoute: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/books/:bookId/chapters/:chapterId" element={<ReaderPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const BOOK_ID = 'b-loc';
const CHAPTER_ID = 'ch-loc';

const bookJson = {
  id: BOOK_ID,
  title: '定位测试书',
  authors: ['作者'],
  language: 'zh',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:loc',
  file_size: 100,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [{ id: CHAPTER_ID, title: '第一章', spine_order: 0, word_count: 20 }],
  assets: [],
};

// 两处「殷萱儿」:第 2 处前面是「乙乙」,用于上下文消歧
const chapterJson = {
  title: '第一章',
  content: '<p>甲甲殷萱儿乙乙殷萱儿丙丙</p>',
  format: 'html',
};

describe('Reader 搜索命中定位(滚动模式)', () => {
  beforeEach(() => {
    localStorage.setItem(KEY_READER_MODE, 'scroll');
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

  it('?q&n&b 定位到第 2 处并选中', async () => {
    render(
      <ReaderHarness
        initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}?q=${encodeURIComponent('殷萱儿')}&n=2&b=${encodeURIComponent('乙乙')}`}
      />,
    );

    await waitFor(() => {
      expect(window.getSelection()?.toString()).toBe('殷萱儿');
    });
    // 选中的应是第 2 处(前文为「乙乙」)
    const sel = window.getSelection();
    const node = sel!.anchorNode as Text;
    expect(node.nodeValue!.slice(0, sel!.anchorOffset)).toBe('甲甲殷萱儿乙乙');
  });

  it('无定位参数时不选中任何内容', async () => {
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    await waitFor(() => {
      expect(window.getSelection()?.toString() ?? '').toBe('');
    });
  });
});
