// 阅读页主题切换链路的交互测试:夜间按钮 / 设置面板选主题。
// 复现目标:切换主题后 --bg 渲染 与 夜间按钮激活态 必须同步。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../pages/Reader';
import { KEY_THEME } from '../lib/readerPrefs';

function ReaderHarness({ initialRoute }: { initialRoute: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/books/:bookId/chapters/:chapterId" element={<ReaderPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const BOOK_ID = 'b1';
const CHAPTER_ID = 'ch1';

const bookJson = {
  id: BOOK_ID,
  title: '测试之书',
  authors: ['Alice'],
  language: 'en',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:test',
  file_size: 1000,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [{ id: 'ch1', title: '第一章', spine_order: 0, word_count: 100 }],
  assets: [],
};
const chapterJson = { title: '第一章', content: '<p>第一段文字。</p>', format: 'html' };

/// 取阅读器根节点(悬空 cssVars 的载体),读当前 --bg
function rootBg(): string {
  const root = document.querySelector('.fixed.inset-0.overflow-hidden') as HTMLElement;
  return root.style.getPropertyValue('--bg');
}

describe('ReaderPage theme switching', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/api/books/${BOOK_ID}`) && !url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => bookJson });
        }
        if (url.includes(`/chapters/${CHAPTER_ID}`)) {
          return Promise.resolve({ ok: true, json: async () => chapterJson });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('夜间按钮:亮→暗→亮 往返,渲染与存储同步', async () => {
    localStorage.setItem(KEY_THEME, 'light');
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // 初始浅色
    expect(rootBg()).toBe('#ffffff');

    // 点击 白天→夜间 → dark
    const dayBtn = (await screen.findAllByRole('button', { name: /白天模式/ }))[0];
    await user.click(dayBtn);
    expect(rootBg()).toBe('#1f1c15');
    expect(localStorage.getItem(KEY_THEME)).toBe('dark');

    // 再点 夜间→白天 → 回到初始浅色
    const nightBtn = screen.getByRole('button', { name: /夜间模式/ });
    await user.click(nightBtn);
    expect(rootBg()).toBe('#ffffff');
    expect(localStorage.getItem(KEY_THEME)).toBe('light');
  });

  it('设置面板选主题:浅色→米色→深色 渲染即时变化', async () => {
    localStorage.setItem(KEY_THEME, 'light');
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // 打开设置面板(侧边栏 + 顶栏各一份,取侧边栏那份)
    const settingsBtns = await screen.findAllByRole('button', { name: /阅读设置/ });
    await user.click(settingsBtns[settingsBtns.length - 1]);

    // 米色
    const sepia = await screen.findByRole('button', { name: /米色/ });
    await user.click(sepia);
    expect(rootBg()).toBe('#f4ecd8');
    expect(localStorage.getItem(KEY_THEME)).toBe('sepia');

    // 深色
    const dark = screen.getByRole('button', { name: /深色/ });
    await user.click(dark);
    expect(rootBg()).toBe('#1f1c15');
    expect(localStorage.getItem(KEY_THEME)).toBe('dark');
  });

  it('切换主题后夜间按钮激活态跟随 theme', async () => {
    localStorage.setItem(KEY_THEME, 'sepia');
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    const dayBtn = (await screen.findAllByRole('button', { name: /白天模式/ }))[0];
    // 米色主题:白天未激活(无内联激活底色,只有 hover 微光)
    expect(dayBtn.style.backgroundColor).toBe('');

    // 切到深色:激活态出现,且标签变为「夜间」,按钮带主题色实底
    await user.click(dayBtn);
    expect(localStorage.getItem(KEY_THEME)).toBe('dark');
    const nightBtn = await screen.findByRole('button', { name: /夜间模式/ });
    expect(nightBtn.style.backgroundColor).not.toBe('');
  });
});
