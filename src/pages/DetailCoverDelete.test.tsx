// 「删除封面」必须二次确认 —— 回归测试。
//
// 背景:删除按钮在封面悬停浮层里,很小、很容易手滑点到;而手动上传的封面
// 是「删文件 + 删记录」不可恢复(EPUB 自带封面则只是取消标记,图片还在书里)。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from './Detail';

const BOOK_ID = 'b-cover';

/** 造一本带封面的书;uploaded=true 表示手动上传封面(href 以 cover: 开头)。 */
function bookWithCover(uploaded: boolean) {
  return {
    id: BOOK_ID,
    title: '封面测试书',
    authors: ['作者'],
    language: 'zh',
    publisher: null,
    description: null,
    pub_date: null,
    identifier: 'urn:cover',
    file_size: 1000,
    created_at: '2024-01-01T00:00:00Z',
    chapters: [{ id: 'c1', title: '第一章', spine_order: 0, word_count: 10 }],
    assets: [
      {
        id: 'a-cover',
        href: uploaded ? 'cover:a-cover' : 'OEBPS/Images/cover.jpg',
        media_type: 'image/jpeg',
        size: 1000,
        is_cover: true,
      },
    ],
  };
}

/** 记录所有请求,便于断言「有没有真的发删除请求」。 */
function stubFetch(book: ReturnType<typeof bookWithCover>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => book });
    }),
  );
  return calls;
}

function Harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/books/${BOOK_ID}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/books/:id" element={<DetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const deleted = (calls: Array<{ method: string }>) =>
  calls.filter((c) => c.method === 'DELETE').length;

describe('DetailPage 删除封面二次确认', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('点「删除封面」只弹确认框,不会立刻删除(上传封面)', async () => {
    const user = userEvent.setup();
    const calls = stubFetch(bookWithCover(true));
    render(<Harness />);
    await screen.findByText('第一章');

    await user.click(screen.getByRole('button', { name: '删除封面' }));

    expect(screen.getByText('删除封面？')).toBeInTheDocument();
    // 上传封面不可恢复,文案要说清楚
    expect(screen.getByText(/手动上传/)).toBeInTheDocument();
    expect(deleted(calls)).toBe(0);
  });

  it('取消后不删除,弹窗关闭', async () => {
    const user = userEvent.setup();
    const calls = stubFetch(bookWithCover(true));
    render(<Harness />);
    await screen.findByText('第一章');

    await user.click(screen.getByRole('button', { name: '删除封面' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByText('删除封面？')).toBeNull();
    expect(deleted(calls)).toBe(0);
  });

  it('确认后才真正删除', async () => {
    const user = userEvent.setup();
    const calls = stubFetch(bookWithCover(true));
    render(<Harness />);
    await screen.findByText('第一章');

    await user.click(screen.getByRole('button', { name: '删除封面' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(deleted(calls)).toBe(1));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toContain(
      `/api/books/${BOOK_ID}/cover`,
    );
    await waitFor(() => expect(screen.queryByText('删除封面？')).toBeNull());
  });

  it('EPUB 自带的封面:文案说明图片仍在书里', async () => {
    const user = userEvent.setup();
    stubFetch(bookWithCover(false));
    render(<Harness />);
    await screen.findByText('第一章');

    await user.click(screen.getByRole('button', { name: '删除封面' }));

    expect(screen.getByText('删除封面？')).toBeInTheDocument();
    expect(screen.getByText(/图片仍在书内/)).toBeInTheDocument();
  });
});
