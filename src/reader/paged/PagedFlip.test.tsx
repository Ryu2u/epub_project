// 分页翻页端到端回归(jsdom)。
// 通过给 Range.prototype.getClientRects 打「合成行盒」补丁(每字符一行、
// 行高 20px,纯空白无行盒 —— 与真实浏览器语义一致),让分页引擎在
// jsdom 里真正切出多页,验证 键盘翻页 → SlideFlip 落定 → 原子交接 →
// 页码/预填 的完整链路。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../../pages/Reader';
import { KEY_READER_MODE } from '../../lib/readerPrefs';

const LINE_H = 20; // 每字符一行(合成行盒)
const PAGE_LINES = 30; // 768 视口 → 内容高 616 → 每页 30 行

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
const CONTENT = '字'.repeat(100); // ch1:100 字符 → 4 页
const CONTENT2 = '乙'.repeat(50); // ch2:50 字符 → 2 页

const bookJson = {
  id: BOOK_ID,
  title: '测试之书',
  authors: ['Alice'],
  language: 'zh',
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
  content: `<p>${CONTENT}</p>`,
  format: 'html',
};

const chapterJson2 = {
  title: '第二章',
  content: `<p>${CONTENT2}</p>`,
  format: 'html',
};

/** (node,offset) → 全文档渲染字符坐标(纯空白节点跳过)。 */
function charIndexOf(node: Node, offset: number): number {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let g = 0;
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const t = n.nodeValue ?? '';
    const renders = t.trim().length > 0;
    if (n === node) return g + (renders ? offset : 0);
    if (renders) g += t.length;
  }
  return g;
}

/** 分页页头(章节标题,与目录面板/顶栏区分)。 */
function pagedHead(): HTMLElement {
  return document.querySelector('.paged-head') as HTMLElement;
}

/** 分页页脚(页码 + 章内进度)。 */
function pagedFoot(): HTMLElement {
  return document.querySelector('.paged-foot') as HTMLElement;
}

/** 等待分页页头标题变为指定章节(跨章落地的无歧义标记)。 */
async function waitForHeadChapter(title: string): Promise<void> {
  await vi.waitFor(() => {
    expect(pagedHead().textContent ?? '').toContain(title);
  });
}

describe('PagedReaderView 翻页流水线(合成行盒)', () => {
  beforeAll(() => {
    // jsdom 的 Range 没有 getClientRects:补上合成行盒
    const proto = Range.prototype as unknown as {
      getClientRects?: (this: Range) => Array<{ top: number; bottom: number; left: number; right: number; width: number; height: number }>;
    };
    proto.getClientRects = function (this: Range) {
      const s = charIndexOf(this.startContainer, this.startOffset);
      const e = charIndexOf(this.endContainer, this.endOffset);
      const rects: Array<{ top: number; bottom: number; left: number; right: number; width: number; height: number }> = [];
      for (let i = s; i < e; i++) {
        rects.push({
          top: i * LINE_H,
          bottom: i * LINE_H + LINE_H,
          left: 0,
          right: 10,
          width: 10,
          height: LINE_H,
        });
      }
      return rects;
    };
  });

  beforeEach(() => {
    // 测试间彻底隔离(上个测试卸载时的进度落盘可能晚于 afterEach 清理)
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/api/books/${BOOK_ID}`) && !url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => bookJson });
        }
        if (url.includes('/chapters/ch2')) {
          return Promise.resolve({ ok: true, json: async () => chapterJson2 });
        }
        if (url.includes('/chapters/')) {
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

  it('多页章节:切出 4 页,键盘翻到第 2 页内容与页码正确', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // 100 字符 / 每页 30 行 → 4 页
    expect(await screen.findByText(`1 / 4`)).toBeInTheDocument();

    const stage = screen.getByLabelText('分页正文');
    const cur = stage.querySelector('.paged-page-cur') as HTMLElement;
    const next = stage.querySelector('.paged-page-next') as HTMLElement;
    expect(cur.textContent).toBe('字'.repeat(PAGE_LINES));

    // 键盘向后翻一页(slide 260ms 异步落定)
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await vi.waitFor(() => expect(screen.getByText('2 / 4')).toBeInTheDocument());
    expect(cur.textContent).toBe('字'.repeat(PAGE_LINES)); // 第 2 页 = 字符 30..59

    // 交接完成后:next 复位隐藏,且预填第 3 页(前视)
    expect(next.style.visibility).toBe('hidden');
    expect(next.style.transform).toBe('');
    expect(next.textContent).toBe('字'.repeat(PAGE_LINES));

    // 再翻一页到第 3 页
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await vi.waitFor(() => expect(screen.getByText('3 / 4')).toBeInTheDocument());
    expect(cur.textContent).toBe('字'.repeat(PAGE_LINES));
  });

  it('向前翻:从第 2 页回到第 1 页', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    expect(await screen.findByText(`1 / 4`)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await vi.waitFor(() => expect(screen.getByText('2 / 4')).toBeInTheDocument());

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await vi.waitFor(() => expect(screen.getByText('1 / 4')).toBeInTheDocument());
    const cur = screen.getByLabelText('分页正文').querySelector('.paged-page-cur') as HTMLElement;
    expect(cur.textContent).toBe('字'.repeat(PAGE_LINES));
  });

  it('章末向前翻:无下一页时键盘触发跨章导航', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    expect(await screen.findByText(`1 / 4`)).toBeInTheDocument();

    // 翻到最后一页(第 4 页 = 字符 90..99,10 个)
    fireEvent.keyDown(window, { key: 'End' });
    await vi.waitFor(() => expect(screen.getByText('4 / 4')).toBeInTheDocument());
    const cur = screen.getByLabelText('分页正文').querySelector('.paged-page-cur') as HTMLElement;
    expect(cur.textContent).toBe('字'.repeat(10));

    // 再向前 → 跨章(邻章已预分页则平滑翻页,否则直跳)→ 第二章
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForHeadChapter('第二章');
  });

  it('跨章前进:章末翻页平滑滑入下一章第一页(动画路径)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    expect(await screen.findByText(`1 / 4`)).toBeInTheDocument();

    // 翻到本章最后一页(历经 3 次翻页动画)
    fireEvent.keyDown(window, { key: 'End' });
    await vi.waitFor(() => expect(screen.getByText('4 / 4')).toBeInTheDocument());

    // 等邻章(ch2)预分页完成(空闲回退 300ms + 测量,留足裕量)
    await new Promise((r) => setTimeout(r, 700));

    // 跨章向前:begin 在 keydown 派发内同步发生 —— 被揭示页立刻
    // 装载下一章第 1 页并可见(直跳路径不会填 next,以此区分)
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const stage = screen.getByLabelText('分页正文');
    const next = stage.querySelector('.paged-page-next') as HTMLElement;
    const cur = stage.querySelector('.paged-page-cur') as HTMLElement;
    expect(next.style.visibility).toBe('visible');
    expect(next.textContent).toBe('乙'.repeat(PAGE_LINES)); // ch2 第 1 页

    // 落地:cur 原子交接为下一章第 1 页(动画完成后同帧发生)
    await vi.waitFor(
      () => expect(cur.textContent).toBe('乙'.repeat(PAGE_LINES)),
      { timeout: 1500 },
    );
    // 页头/页脚:第二章第 1 页(导航重渲染在微任务中,同样需要等待;
    // 页脚作用域避免与页头章节标签混淆)
    await waitForHeadChapter('第二章');
    await vi.waitFor(() => expect(pagedFoot().textContent ?? '').toContain('1 / 2'));
    // 交接后 next 复位隐藏,且预填下一章的第 2 页(乙*20)
    expect(next.style.visibility).toBe('hidden');
    expect(next.textContent).toBe('乙'.repeat(20));
  });

  it('跨章后退:章首翻页平滑滑回上一章末页(无保存锚点时)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/ch2`} />,
    );
    expect(await screen.findByText('1 / 2')).toBeInTheDocument();

    // 等邻章(ch1)预分页完成(空闲回退 300ms + 测量)
    await new Promise((r) => setTimeout(r, 700));

    // 跨章向后:begin 同步发生 —— 被揭示页立刻装载上一章最后一页
    // (无 recent 锚点 → 末页;直跳路径不会填 next)
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    const stage = screen.getByLabelText('分页正文');
    const next = stage.querySelector('.paged-page-next') as HTMLElement;
    expect(next.style.visibility).toBe('visible');
    expect(next.textContent).toBe('字'.repeat(10)); // ch1 第 4 页

    // 落地:第一章末页,页脚 4 / 4(作用域断言,避免目录面板干扰)
    await waitForHeadChapter('第一章');
    await vi.waitFor(() => expect(pagedFoot().textContent ?? '').toContain('4 / 4'));
    const cur = stage.querySelector('.paged-page-cur') as HTMLElement;
    expect(cur.textContent).toBe('字'.repeat(10));
  });
});
