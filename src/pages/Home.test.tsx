// Home 页(主页):之前读过 / 阅读目标 / 今年读过的图书 关键交互测试
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../pages/Home';
import { AppThemeProvider } from '../lib/appTheme';
import { lastReadAtKey, lastReadKey, progressKey } from '../lib/readerPrefs';
import { GOAL_MINUTES_KEY } from '../lib/readingStats';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AppThemeProvider>{ui}</AppThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const bookJson = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'b1',
  title: '测试之书',
  authors: ['测试作者'],
  language: 'zh-CN',
  chapter_count: 3,
  asset_count: 1,
  word_count: 123456,
  file_size: 1024,
  has_cover: true,
  cover_id: 'cover-img',
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

function okResponse(items: unknown[]) {
  return { ok: true, json: async () => ({ items, total: items.length, page: 1, size: 100 }) };
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('空书库显示上传引导', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    renderWithProviders(<HomePage />);

    expect(await screen.findByText(/书库还是空的/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /上传书籍/ })).toBeInTheDocument();
  });

  it('之前读过:有进度的书出现在横排,无进度的不出现', async () => {
    localStorage.setItem(progressKey('b1'), JSON.stringify({ ch1: 0.5 }));
    localStorage.setItem(lastReadKey('b1'), 'ch1');
    localStorage.setItem(lastReadAtKey('b1'), String(Date.now()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    expect(await screen.findByText('之前读过')).toBeInTheDocument();
    // 测试之书同时出现在"之前读过"横排与"今年读过"网格,断言至少两处链接
    const links = await screen.findAllByRole('link', { name: /测试之书/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    // 0.5/3 ≈ 17%
    expect(screen.getByText(/图书 · 17%/)).toBeInTheDocument();
  });

  it('未开始的书不出现在"之前读过"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    // 有书但无进度 → 整个"之前读过"区块不渲染(标题不存在)
    await screen.findByText('阅读目标');
    expect(screen.queryByText('之前读过')).not.toBeInTheDocument();
  });

  it('阅读目标:显示今日分钟 / 周历 / 连续阅读', async () => {
    localStorage.setItem('epub_reader:readMinutes:' + todayKey(), '95');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    expect(await screen.findByText('今日阅读进度')).toBeInTheDocument();
    expect(screen.getByText('95')).toBeInTheDocument();
    expect(screen.getByText('分钟')).toBeInTheDocument();
    expect(screen.getByText('连续阅读 1 天')).toBeInTheDocument();
    // 本周 7 天标签全部渲染
    ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].forEach((d) => {
      expect(screen.getAllByText(d).length).toBeGreaterThan(0);
    });
  });

  it('继续阅读按钮指向最近读过的章节', async () => {
    localStorage.setItem(progressKey('b1'), JSON.stringify({ ch1: 0.5 }));
    localStorage.setItem(lastReadKey('b1'), 'ch1');
    localStorage.setItem(lastReadAtKey('b1'), String(Date.now()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    const btn = await screen.findByRole('link', { name: /继续阅读/ });
    expect(btn.getAttribute('href')).toBe('/books/b1/chapters/ch1');
    expect(btn).toHaveTextContent('测试之书');
  });

  it('今年读过的图书:占位序号 + 达成目标文案', async () => {
    localStorage.setItem(progressKey('b1'), JSON.stringify({ ch1: 0.5 }));
    localStorage.setItem(lastReadKey('b1'), 'ch1');
    localStorage.setItem(lastReadAtKey('b1'), String(Date.now()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    // 1 本已读 → 占位格 2..20,文案"再读 19 本"
    expect(await screen.findByText('再读 19 本图书即可达成目标')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('调整目标:预设值点击保存后持久化', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    await user.click(await screen.findByText('调整目标'));
    await user.click(screen.getByText('180 分'));
    await user.click(screen.getByText('保存'));

    expect(localStorage.getItem(GOAL_MINUTES_KEY)).toBe('180');
  });

  it('主题切换:点击按钮切换 <html> 上的 data-shell-theme', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([bookJson()])));

    renderWithProviders(<HomePage />);

    expect(document.documentElement.getAttribute('data-shell-theme')).toBe('light');

    await user.click(await screen.findByRole('button', { name: '切换主题' }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-shell-theme')).toBe('dark');
    });

    // localStorage 持久化
    expect(localStorage.getItem('epub_reader:shellTheme')).toBe('dark');
  });
});

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
