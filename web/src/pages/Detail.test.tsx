// Detail 页目录链接测试
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '../pages/Detail';
import * as readerProgress from '../hooks/useReaderProgress';

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

  it('展示目录标题与全书总字数', async () => {
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    expect(await screen.findByText(/目录/)).toBeInTheDocument();
    // 两章 word_count 100 + 50 = 150,不足 1 万显示原始数字
    expect(await screen.findByText(/共 150 字/)).toBeInTheDocument();
  });

  it('getChapterProgress 不再被调用；readProgressMap 只调 1 次（不是每章）', async () => {
    // 2264 章时不优化会调 2264 次 getChapterProgress（每章渲染时 JSON.parse）
    // 优化后用顶层 progressMap 一次性 readProgressMap
    const big = {
      ...bookJson,
      chapters: Array.from({ length: 50 }, (_, i) => ({
        id: `ch${i}.xhtml`,
        title: `第 ${i + 1} 章`,
        spine_order: i,
        word_count: 100 + i,
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => big }),
    );
    const getSpy = vi
      .spyOn(readerProgress, 'getChapterProgress')
      .mockReturnValue(0);
    const mapSpy = vi
      .spyOn(readerProgress, 'readProgressMap')
      .mockReturnValue({});

    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    // 等目录渲染完成
    await screen.findByText('第 1 章');
    // 50 章场景下，getChapterProgress 应 0 次（用 progressMap[ch.id] ?? 0 替代）
    expect(getSpy).toHaveBeenCalledTimes(0);
    // readProgressMap 顶层只调 1 次（开发模式 React StrictMode 会调 2 次，但仍是 O(1) 而非 O(N)）
    expect(mapSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mapSpy.mock.calls.length).toBeLessThan(big.chapters.length);
  });

  it('100 章时 DOM 中 li 节点数 << 总数（虚拟化）', async () => {
    const big = {
      ...bookJson,
      chapters: Array.from({ length: 100 }, (_, i) => ({
        id: `ch${i}.xhtml`,
        title: `第 ${i + 1} 章`,
        spine_order: i,
        word_count: 100 + i,
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => big }),
    );
    const { container } = render(
      <DetailHarness initialRoute={`/books/${BOOK_ID}`} />,
    );
    await screen.findByText('第 1 章');
    // 100 章时，DOM 内的 li 应远小于 100（视口内 ~30 个）
    const liCount = container.querySelectorAll('li').length;
    expect(liCount).toBeLessThan(60);
    expect(liCount).toBeGreaterThan(0);
  });
});