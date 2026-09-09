// 详情页内容搜索:逐次命中 + 分页加载 + 点击跳转定位参数

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const BOOK_ID = 'b-search';

const bookJson = {
  id: BOOK_ID,
  title: '搜索测试书',
  authors: ['作者'],
  language: 'zh',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:search',
  file_size: 1000,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [
    { id: 'c1', title: '第一章', spine_order: 0, word_count: 100 },
    { id: 'c2', title: '第二章', spine_order: 1, word_count: 100 },
  ],
  assets: [],
};

/** 一页 2 条命中,共 3 处(第 2 页 1 条)。 */
function searchPage(page: number) {
  const all = [
    {
      chapter_id: 'c1',
      chapter_title: '第一章',
      spine_order: 0,
      char_offset: 10,
      index_in_chapter: 1,
      snippet: '前文…<mark>殷萱儿</mark>后文…',
      before: '甲甲',
      matched: '殷萱儿',
    },
    {
      chapter_id: 'c1',
      chapter_title: '第一章',
      spine_order: 0,
      char_offset: 50,
      index_in_chapter: 2,
      snippet: '…又一次<mark>殷萱儿</mark>出现…',
      before: '乙乙',
      matched: '殷萱儿',
    },
    {
      chapter_id: 'c2',
      chapter_title: '第二章',
      spine_order: 1,
      char_offset: 5,
      index_in_chapter: 1,
      snippet: '…<mark>殷萱儿</mark>…',
      before: '丙丙',
      matched: '殷萱儿',
    },
  ];
  const start = (page - 1) * 2;
  return {
    items: all.slice(start, start + 2),
    total: all.length,
    chapter_total: 2,
    query: '殷萱儿',
  };
}

describe('DetailPage 内容搜索(逐次命中)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/search')) {
          const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
          return Promise.resolve({ ok: true, json: async () => searchPage(page) });
        }
        return Promise.resolve({ ok: true, json: async () => bookJson });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('按次展示命中:章节 + 第 N 处 + 高亮片段', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');

    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    // 400ms 防抖后触发
    await waitFor(
      () => expect(screen.getByText(/在 2 个章节中找到 3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // 第 1 页 2 条命中(不是一章一条)
    expect(screen.getByText('第 1 处')).toBeInTheDocument();
    expect(screen.getByText('第 2 处')).toBeInTheDocument();
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks[0].textContent).toBe('殷萱儿');
  });

  it('点击命中跳转到章节并带定位参数(q/n/b)', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const link = screen.getByText('第 2 处').closest('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    const href = link.getAttribute('href')!;
    expect(href.startsWith(`/books/${BOOK_ID}/chapters/c1?`)).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('q')).toBe('殷萱儿');
    expect(params.get('n')).toBe('2');
    expect(params.get('b')).toBe('乙乙'); // 命中前上下文
  });

  it('「加载更多」拉取下一页,末尾显示全部已显示', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const more = screen.getByRole('button', { name: /加载更多/ });
    expect(more.textContent).toContain('已显示 2 / 3');
    await user.click(more);

    // 第 2 页:第二章的那条 + 收尾文案
    await waitFor(() => expect(screen.getByText('已显示全部 3 处')).toBeInTheDocument());
    const results = document.querySelectorAll('a[href*="/chapters/"]');
    expect(results.length).toBe(3);
    expect(
      within(results[2] as HTMLElement).getByText('第二章'),
    ).toBeInTheDocument();
  });
});
