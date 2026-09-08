// Library 页(书库):封面网格 + 排序 + 每卡"···"操作 关键交互测试
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryPage from '../pages/Library';
import { lastReadKey, progressKey } from '../lib/readerPrefs';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const bookJson = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'b1',
  title: 'Test Book',
  authors: ['Alice'],
  language: 'en',
  chapter_count: 3,
  asset_count: 1,
  word_count: 123456,
  file_size: 1024,
  has_cover: true,
  cover_id: 'cover-img',
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

function okResponse(items: unknown[], total = items.length, page = 1, size = 100) {
  return {
    ok: true,
    json: async () => ({ items, total, page, size }),
  };
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('显示空列表当没有书时', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    renderWithProviders(<LibraryPage />);

    expect(await screen.findByText(/还没有书/)).toBeInTheDocument();
  });

  it('显示书卡片:封面图 + 进度百分比', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<LibraryPage />);

    // 书名作为可访问标签(卡片链接)
    expect(await screen.findByRole('link', { name: 'Test Book' })).toBeInTheDocument();
    // 封面图 src 应指向 /api/books/{id}/assets/{cover_id}
    const img = await screen.findByAltText('Test Book');
    expect(img.getAttribute('src')).toBe('/api/books/b1/assets/cover-img');
    // 未读且不是新书 → 显示 0%
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('有进度显示百分比,新书显示"新增"徽标', async () => {
    // 预置章节进度:1/3 章读完 → 约 33%
    localStorage.setItem(progressKey('b1'), JSON.stringify({ ch1: 1 }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          bookJson(),
          bookJson({
            id: 'b2',
            title: 'New Book',
            authors: ['Bob'],
            created_at: new Date().toISOString(),
          }),
        ]),
      ),
    );

    renderWithProviders(<LibraryPage />);

    expect(await screen.findByText('33%')).toBeInTheDocument();
    expect(await screen.findByText('新增')).toBeInTheDocument();
  });

  it('排序菜单:按书名排序后标题顺序变化', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          bookJson({ id: 'b1', title: 'Zeta Book' }),
          bookJson({ id: 'b2', title: 'Alpha Book' }),
        ]),
      ),
    );

    renderWithProviders(<LibraryPage />);

    // 默认最近添加:Zeta 在前
    await screen.findByRole('link', { name: 'Zeta Book' });
    const links = screen.getAllByRole('link', { name: /Book$/ });
    expect(links[0]).toHaveAccessibleName('Zeta Book');

    // 打开排序菜单选"按书名"
    await user.click(screen.getByRole('button', { name: '排序' }));
    await user.click(screen.getByText('按书名'));

    // 排序后 Alpha 在前
    await waitFor(() => {
      const after = screen.getAllByRole('link', { name: /Book$/ });
      expect(after[0]).toHaveAccessibleName('Alpha Book');
    });
  });

  it('卡片"···"菜单:标记已读完 → 徽标更新', async () => {
    const user = userEvent.setup();
    localStorage.setItem(progressKey('b1'), JSON.stringify({ ch1: 0.5 }));
    localStorage.setItem(lastReadKey('b1'), 'ch1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<LibraryPage />);

    await screen.findByText('17%');
    await user.click(screen.getByRole('button', { name: /Test Book 更多/ }));
    await user.click(screen.getByText('标记已读完'));

    expect(await screen.findByText('已读完')).toBeInTheDocument();
  });

  it('搜索入口:底部导航按钮打开搜索面板', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LibraryPage />);

    await user.click(screen.getByRole('button', { name: '搜索' }));

    // 搜索面板出现,输入框聚焦
    const search = await screen.findByPlaceholderText(/搜索书名/);
    expect(search).toBeInTheDocument();
    await user.type(search, 'epub');
    // 防抖 250ms 后触发带 q 的请求
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((url) => url.includes('q=epub'))).toBe(true);
    });
  });
});
