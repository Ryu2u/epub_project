// Library 页关键交互测试
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryPage from '../pages/Library';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('显示空列表当没有书时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, size: 20 }),
      }),
    );

    renderWithProviders(<LibraryPage />);

    expect(await screen.findByText(/还没有书/)).toBeInTheDocument();
  });

  it('显示书卡片', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'b1',
              title: 'Test Book',
              authors: ['Alice'],
              language: 'en',
              chapter_count: 3,
              asset_count: 1,
              file_size: 1024,
              has_cover: true,
              cover_id: 'cover-img',
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          size: 20,
        }),
      }),
    );

    renderWithProviders(<LibraryPage />);

    expect(await screen.findByText('Test Book')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/3 章/)).toBeInTheDocument();
    // 封面图 src 应指向 /api/books/{id}/assets/{cover_id}
    const img = await screen.findByAltText('Test Book');
    expect(img.getAttribute('src')).toBe('/api/books/b1/assets/cover-img');
  });

  it('搜索框触发查询', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, page: 1, size: 20 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LibraryPage />);

    const search = screen.getByPlaceholderText(/搜索/);
    await user.type(search, 'epub');
    // 表单内 input + Enter 触发 submit
    await user.keyboard('{Enter}');

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((url) => url.includes('q=epub'))).toBe(true);
    });
  });
});