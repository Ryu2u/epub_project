// Detail 页目录链接测试
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '../pages/Detail';
import * as readerProgress from '../hooks/useReaderProgress';
import { lastReadKey } from '../lib/readerPrefs';

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

  it('移动端布局：头两行 = 返回+书名 / 操作按钮（操作在 DOM 中出现两次：移动/桌面各一份）', async () => {
    // 设置最近阅读，让"继续阅读"出现
    localStorage.setItem(lastReadKey(BOOK_ID), 'ch2.xhtml');
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);

    // 书名（h1）始终可见，不被"返回+5个按钮"挤没
    expect(await screen.findByRole('heading', { name: '测试书' })).toBeInTheDocument();
    // 操作按钮存在（移动端行 + 桌面行两份）
    expect(screen.getAllByRole('link', { name: /继续阅读/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '编辑' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(2);
  });

  it('导航栏 sticky 置顶（滚动目录时始终可见）', async () => {
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);
    await screen.findByRole('heading', { name: '测试书' });

    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('sticky');
    expect(header!.className).toContain('top-0');
    expect(header!.className).toContain('z-20');
  });

  it('最近的阅读章节在目录中金色高亮（aria-current）', async () => {
    localStorage.setItem(lastReadKey(BOOK_ID), 'ch2.xhtml');
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);

    expect(await screen.findByText('第二章 继续')).toBeInTheDocument();
    const currentLink = screen.getByRole('link', { name: /第二章 继续/ });
    expect(currentLink).toHaveAttribute('aria-current', 'page');
    // 非当前章节不标记
    expect(screen.getByRole('link', { name: /第一章 开始/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('资源区是默认展开的 details（可折叠），内容首屏可见', async () => {
    const withAssets = {
      ...bookJson,
      assets: [
        {
          id: 'a-cover',
          href: 'cover.xhtml',
          media_type: 'image/webp',
          size: 76800,
          is_cover: true,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => withAssets }),
    );
    render(<DetailHarness initialRoute={`/books/${BOOK_ID}`} />);

    expect(await screen.findByText('资源')).toBeInTheDocument();
    expect(screen.getByText('cover.xhtml')).toBeInTheDocument();
    const details = document.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open'); // 默认展开
  });
});