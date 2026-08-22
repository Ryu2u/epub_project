// Reader 页关键交互测试
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../pages/Reader';
import { formatChapterDate } from '../components/ReaderChapterHeader';

function ReaderHarness({ initialRoute }: { initialRoute: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="/books/:bookId/chapters/:chapterId"
            element={<ReaderPage />}
          />
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
  chapters: [
    { id: 'ch1', title: '第一章', spine_order: 0, word_count: 100 },
    { id: 'ch2', title: '第二章', spine_order: 1, word_count: 50 },
  ],
  assets: [],
};

const chapterJson = {
  title: '第一章',
  content: '<p>第一段文字。</p><p>第二段。</p>',
  format: 'html',
};

describe('ReaderPage', () => {
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

  it('渲染章节标题和正文', async () => {
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // 正文 <article> 内第一段唯一（章节头部 h1 和 TocPanel 列表项也含"第一章"，用 article scope 收敛）
    const article = await screen.findByRole('article');
    expect(await within(article).findByText('第一段文字。')).toBeInTheDocument();
  });

  it('章节头部显示章节标题与数据行（书名/作者/字数/时间）', async () => {
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    const header = await screen.findByTestId('reader-chapter-header');
    expect(within(header).getByText('第一章')).toBeInTheDocument();   // 标题
    expect(within(header).getByText('测试之书')).toBeInTheDocument();  // 书名
    expect(within(header).getByText('Alice')).toBeInTheDocument();     // 作者
    expect(within(header).getByText('100 字')).toBeInTheDocument();    // 字数
    expect(
      within(header).getByText(formatChapterDate(bookJson.created_at)),
    ).toBeInTheDocument();                                             // 时间
  });

  it('右侧侧边栏包含 目录/书详情/书架/夜间/设置/顶部', async () => {
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // 目录/设置入口有两份：侧边栏一份 + 窄屏顶栏一份（CSS 断点互斥显示）
    expect(screen.getAllByRole('button', { name: '打开目录' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: '阅读设置' }).length).toBe(2);

    const detailLink = screen.getByRole('link', { name: '书详情' });
    expect(detailLink.getAttribute('href')).toBe(`/books/${BOOK_ID}`);

    const shelfLink = screen.getByRole('link', { name: '返回书架' });
    expect(shelfLink.getAttribute('href')).toBe('/');

    expect(screen.getByRole('button', { name: '夜间模式' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回顶部' })).toBeInTheDocument();
  });

  it('点击设置按钮弹出设置面板', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // [1] = 侧边栏那份（[0] 为窄屏顶栏那份），行为一致
    const btn = (await screen.findAllByRole('button', { name: /阅读设置/ }))[1];
    await user.click(btn);

    // 设置面板打开后应能看到"字号"标题
    expect(await screen.findByText('阅读设置')).toBeInTheDocument();
  });

  it('夜间模式切换主题（再点一次恢复原主题）', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // 初始为米色主题
    await user.click(screen.getByRole('button', { name: '夜间模式' }));
    await user.click(screen.getAllByRole('button', { name: '阅读设置' })[1]);
    // 设置面板中"深色"应处于选中态
    expect(await screen.findByRole('button', { name: '深色' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '关闭' }));

    // 再次点击夜间 → 恢复米色
    await user.click(screen.getByRole('button', { name: '夜间模式' }));
    await user.click(screen.getAllByRole('button', { name: '阅读设置' })[1]);
    expect(await screen.findByRole('button', { name: '米色' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('章节末尾：上一章/目录/下一章切换按钮，首章上一章禁用', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // ch1 是第一章：上一章无链接（灰态文本），下一章是链接
    expect(screen.queryByRole('link', { name: '上一章' })).toBeNull();
    expect(screen.getByText('上一章')).toBeInTheDocument();

    const nextBtn = screen.getByRole('link', { name: /下一章/ });
    expect(nextBtn.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/chapters/${encodeURIComponent('ch2')}`,
    );

    // 末尾"目录"按钮可以打开目录面板
    await user.click(screen.getByRole('button', { name: '目录' }));
    const dialog = await screen.findByRole('dialog', { name: '目录' });
    expect(within(dialog).getByText('第二章')).toBeInTheDocument();
  });

  it('隐藏正文中与章节标题重复的首个标题元素', async () => {
    // 章节 HTML 正文自带与标题一致的 <h2>（如导出 EPUB 注入的标题）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/api/books/${BOOK_ID}`) && !url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => bookJson });
        }
        if (url.includes(`/chapters/${CHAPTER_ID}`)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              title: '第一章',
              content: '<h2>第一章</h2><p>第一段文字。</p>',
              format: 'html',
            }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }),
    );

    const { container } = render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    await screen.findByRole('article');
    // useEffect 去重后，正文内的 h2 应被隐藏
    await waitFor(() => {
      const h2 = container.querySelector('article h2') as HTMLElement;
      expect(h2).toBeInTheDocument();
      expect(h2.style.display).toBe('none');
    });
  });

  it('点击目录按钮弹出目录面板', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await screen.findByRole('article');

    // [1] = 侧边栏那份（[0] 为窄屏顶栏那份），行为一致
    const tocBtn = (await screen.findAllByRole('button', { name: /打开目录/ }))[1];
    await user.click(tocBtn);

    // 目录面板 dialog 出现，且列出 mock 数据中的章节
    const dialog = await screen.findByRole('dialog', { name: '目录' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('第一章')).toBeInTheDocument();
    expect(within(dialog).getByText('第二章')).toBeInTheDocument();
  });
});

describe('useReaderProgress (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('写入再读取', async () => {
    const { getChapterProgress, setChapterProgress } = await import(
      '../hooks/useReaderProgress'
    );
    expect(getChapterProgress('bookA', 'ch1')).toBe(0);
    setChapterProgress('bookA', 'ch1', 0.42);
    expect(getChapterProgress('bookA', 'ch1')).toBeCloseTo(0.42);
    setChapterProgress('bookA', 'ch1', 1.1); // 超出范围 -> 限制到 1
    expect(getChapterProgress('bookA', 'ch1')).toBeCloseTo(1);
    setChapterProgress('bookA', 'ch1', 0); // 0 -> 删除记录
    expect(getChapterProgress('bookA', 'ch1')).toBe(0);
  });
});

describe('useReaderSettings (localStorage)', () => {
  it('默认值', async () => {
    const { useReaderSettings } = await import('../hooks/useReaderSettings');
    // 不在这里做 hook 调用（需要 React 上下文），仅做 import smoke test
    expect(typeof useReaderSettings).toBe('function');
    // 验证默认常量合理性
    const { FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX } = await import(
      '../lib/readerPrefs'
    );
    expect(FONT_SIZE_DEFAULT).toBe(16);
    expect(FONT_SIZE_MIN).toBeLessThan(FONT_SIZE_MAX);
    void waitFor; // 静默未用告警
  });
});
