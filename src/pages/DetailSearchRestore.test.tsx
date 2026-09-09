// 详情页搜索状态恢复:点进阅读页再返回,关键词/展开的章节/滚动位置都应还原

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
          <Route
            path="/books/:id/chapters/:chapterId"
            element={<div data-testid="reader-stub" />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const BOOK_ID = 'b-restore';

const bookJson = {
  id: BOOK_ID,
  title: '恢复测试书',
  authors: ['作者'],
  language: 'zh',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:restore',
  file_size: 1000,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [{ id: 'c1', title: '第一章', spine_order: 0, word_count: 100 }],
  assets: [],
};

const searchResponse = {
  items: [
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
  ],
  total: 2,
  chapter_total: 1,
  query: '殷萱儿',
};

/** 让 jsdom 里的 scrollTop 可读可写(原生实现恒为 0)。 */
function stubScrollTop(el: HTMLElement): void {
  let value = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  });
}

describe('DetailPage 搜索状态恢复', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/search')) {
          return Promise.resolve({ ok: true, json: async () => searchResponse });
        }
        return Promise.resolve({ ok: true, json: async () => bookJson });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('返回详情页后恢复关键词、展开状态与滚动位置', async () => {
    const user = userEvent.setup();
    const first = render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');

    // 搜索
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/在 1 个章节中找到 2 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // 展开第一章(受控状态,应被暂存)
    await user.click(screen.getByRole('button', { name: /第一章/ }));
    expect(screen.getByText('第 2 处')).toBeInTheDocument();

    // 模拟结果区滚动
    const list = screen.getByTestId('chapter-list');
    stubScrollTop(list);
    list.scrollTop = 640;
    expect(list.scrollTop).toBe(640);

    // 点击结果 → 跳转阅读页(Detail 卸载)
    await user.click(screen.getByText('第 1 处').closest('a') as HTMLAnchorElement);
    await screen.findByTestId('reader-stub');
    first.unmount();

    // 返回详情页(重新挂载)
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    const input = (await screen.findByPlaceholderText(
      '搜索本书内容…',
    )) as HTMLInputElement;
    // 关键词恢复
    await waitFor(() => expect(input.value).toBe('殷萱儿'));
    // 结果恢复
    await waitFor(() =>
      expect(screen.getByText(/在 1 个章节中找到 2 处匹配/)).toBeInTheDocument(),
    );
    // 展开状态恢复
    expect(screen.getByText('第 2 处')).toBeInTheDocument();
    // 滚动位置恢复
    const list2 = screen.getByTestId('chapter-list');
    stubScrollTop(list2);
    await waitFor(() => expect(list2.scrollTop).toBe(640));
  });

  it('状态只消费一次:再次进入详情页不再弹出旧搜索', async () => {
    const user = userEvent.setup();
    const first = render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByText('第一章');
    await user.type(screen.getByPlaceholderText('搜索本书内容…'), '殷萱儿');
    await waitFor(
      () => expect(screen.getByText(/2 处匹配/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    await user.click(screen.getByText('第 1 处').closest('a') as HTMLAnchorElement);
    await screen.findByTestId('reader-stub');
    first.unmount();

    // 第一次返回:恢复搜索
    const second = render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText('搜索本书内容…') as HTMLInputElement).value,
      ).toBe('殷萱儿'),
    );
    second.unmount();

    // 第二次进入:状态已消费,回到初始(空搜索框 + 章节列表)
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    const input = (await screen.findByPlaceholderText(
      '搜索本书内容…',
    )) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.queryByText(/处匹配/)).toBeNull();
  });
});
