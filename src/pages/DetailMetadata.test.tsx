// Detail 页元数据编辑测试:分类/标签/别名的编辑回填、保存载荷、查看态展示。
// harness 复用 Detail.test.tsx 的模式(fetch stub + QueryClient + MemoryRouter)。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '../pages/Detail';
import * as readerProgress from '../hooks/useReaderProgress';
import { lastReadKey } from '../lib/readerPrefs';
import type { BookDetail } from '../api/types';

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

const BOOK_ID = 'b-meta';

// 携带元数据的详情夹具(镜像 BookDetail 的关键字段)
const bookJson = {
  id: BOOK_ID,
  title: '白夜行',
  authors: ['东野圭吾'],
  language: 'zh-CN',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:test-meta',
  category: '小说',
  tags: ['推理'],
  aliases: ['旧称'],
  file_size: 1234,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [
    { id: 'ch1', title: '第一章', spine_order: 0, word_count: 100 },
  ],
  assets: [],
} as unknown as BookDetail;

// 记录 PATCH 请求,便于断言保存载荷
const fetchMock = vi.fn();

async function enterEditMode() {
  const user = userEvent.setup();
  render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
  // 「编辑」按钮在 DOM 出现两次(移动/桌面布局各一份),取任意一个都能进编辑态
  const editBtns = await screen.findAllByRole('button', { name: '编辑' });
  await user.click(editBtns[0]);
  return user;
}

describe('DetailPage 元数据', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => bookJson });
    vi.stubGlobal('fetch', fetchMock);
    // 与 Detail.test.tsx 一致:屏蔽阅读进度持久化对 fetch 的额外请求
    vi.spyOn(readerProgress, 'readProgressMap').mockReturnValue({});
    localStorage.setItem(lastReadKey(BOOK_ID), 'ch1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('编辑模式回填三个新字段', async () => {
    await enterEditMode();

    expect((screen.getByLabelText('分类') as HTMLInputElement).value).toBe('小说');
    expect((screen.getByLabelText('标签') as HTMLInputElement).value).toBe('推理');
    expect((screen.getByLabelText('别名') as HTMLInputElement).value).toBe('旧称');
  });

  it('保存载荷:标签按逗号切分、清空的分类提交 null', async () => {
    const user = await enterEditMode();

    // 标签追加一个、分类清空
    const tagsInput = screen.getByLabelText('标签') as HTMLInputElement;
    await user.clear(tagsInput);
    await user.type(tagsInput, '推理, 日系');
    await user.clear(screen.getByLabelText('分类'));

    await user.click(screen.getAllByRole('button', { name: '保存' })[0]);

    await waitFor(() => {
      // 只看 PATCH(初始加载的 GET 也命中 /api/books/,但它没有 body)
      const patch = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('/api/books/') &&
          (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect(body.tags).toEqual(['推理', '日系']);
      expect(body.category).toBeNull();
    });
  });

  it('查看态展示分类/标签/别名', async () => {
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);

    expect(await screen.findByText('小说')).toBeInTheDocument();
    expect(screen.getByText('推理')).toBeInTheDocument();
    expect(screen.getByText('旧称')).toBeInTheDocument();
  });
});
