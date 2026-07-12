// Detail 页目录链接测试
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '../pages/Detail';

function DetailHarness({ initialRoute }: { initialRoute: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/books/:id" element={<DetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const BOOK_ID = 'b-xyz';

const bookJson = {
  id: BOOK_ID,
  title: '测试书',
  authors: ['测试作者'],
  language: 'zh-CN',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:test-xyz',
  file_size: 1234,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [
    { id: 'ch1.xhtml', title: '第一章 开始', spine_order: 0, word_count: 100 },
    { id: 'ch2.xhtml', title: '第二章 继续', spine_order: 1, word_count: 50 },
  ],
  assets: [],
};

describe('DetailPage chapters directory', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => bookJson }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('章节名渲染为跳到 Reader 的链接（带 encodeURIComponent）', async () => {
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);

    expect(await screen.findByText('第一章 开始')).toBeInTheDocument();
    expect(await screen.findByText('第二章 继续')).toBeInTheDocument();

    // 每个章节都是 <a> 链接
    const link1 = screen.getByRole('link', { name: /第一章 开始/ });
    expect(link1.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/chapters/${encodeURIComponent('ch1.xhtml')}`,
    );

    const link2 = screen.getByRole('link', { name: /第二章 继续/ });
    expect(link2.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/chapters/${encodeURIComponent('ch2.xhtml')}`,
    );
  });

  it('展示目录标题而非"章节"', async () => {
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    expect(await screen.findByText(/目录/)).toBeInTheDocument();
  });
});