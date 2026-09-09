// 详情页内容搜索:按章节分组(章一行 + 展开看每次出现)+ 分页加载 + 跳转定位参数

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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

/** 两个命中章节:c1 有 2 处、c2 有 1 处;每页 1 章(便于验证分页)。 */
const groups = [
  {
    chapter_id: 'c1',
    chapter_title: '第一章',
    spine_order: 0,
    match_count: 2,
    hits: [
      {
        index_in_chapter: 1,
        char_offset: 10,
        snippet: '前文…<mark>殷萱儿</mark>后文…',
        before: '甲甲',
        matched: '殷萱儿',
      },
      {
        index_in_chapter: 2,
        char_offset: 50,
        snippet: '…又一次<mark>殷萱儿</mark>出现…',
        before: '乙乙',
        matched: '殷萱儿',
      },
    ],
  },
  {
    chapter_id: 'c2',
    chapter_title: '第二章',
    spine_order: 1,
    match_count: 1,
    hits: [
      {
        index_in_chapter: 1,
        char_offset: 5,
        snippet: '…<mark>殷萱儿</mark>…',
        before: '丙丙',
        matched: '殷萱儿',
      },
    ],
  },
];

function searchPage(page: number) {
  const start = page - 1;
  return {
    items: groups.slice(start, start + 1),
    total: 3,
    chapter_total: 2,
    query: '殷萱儿',
  };
}

describe('DetailPage 内容搜索(按章节分组)', () => {
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

  it('章一行:显示命中数,折叠时只给一条预览,展开看全部', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');

    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/在 2 个章节中找到 3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // 章节行 + 命中数
    expect(screen.getByText('第一章')).toBeInTheDocument();
    expect(screen.getByText('2 处')).toBeInTheDocument();
    // 折叠态:只显示第 1 处预览 + 「展开其余 1 处」
    expect(screen.getByText('第 1 处')).toBeInTheDocument();
    expect(screen.queryByText('第 2 处')).toBeNull();
    expect(screen.getByText(/展开其余 1 处/)).toBeInTheDocument();

    // 展开:两次出现都列出
    await user.click(screen.getByRole('button', { name: /第一章/ }));
    expect(screen.getByText('第 2 处')).toBeInTheDocument();
    expect(screen.getByText('收起')).toBeInTheDocument();
  });

  it('点击某次命中跳转并带定位参数(q/n/b)', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await user.click(screen.getByRole('button', { name: /第一章/ }));
    const link = screen.getByText('第 2 处').closest('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    const href = link.getAttribute('href')!;
    expect(href.startsWith(`/books/${BOOK_ID}/chapters/c1?`)).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('q')).toBe('殷萱儿');
    expect(params.get('n')).toBe('2');
    expect(params.get('b')).toBe('乙乙'); // 命中前上下文
  });

  it('「加载更多」按章节翻页,末尾显示全部统计', async () => {
    const user = userEvent.setup();
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/3 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const more = screen.getByRole('button', { name: /加载更多/ });
    expect(more.textContent).toContain('已显示 1 / 2 个章节');
    expect(screen.queryByText('第二章')).toBeNull();

    await user.click(more);
    await waitFor(() =>
      expect(screen.getByText('已显示全部 2 个章节 · 3 处')).toBeInTheDocument(),
    );
    expect(screen.getByText('第二章')).toBeInTheDocument();
  });
});
