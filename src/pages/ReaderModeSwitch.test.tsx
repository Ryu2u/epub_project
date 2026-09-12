// 阅读模式互通:分页模式的顶栏进度 + 滚动 ↔ 分页切换时的位置衔接。
//
// 背景:两种模式各存各的进度(滚动存百分比、分页存锚点),而且分页模式下
// 滚动容器不渲染 —— 父组件既算不出进度、也读不到位置,于是:
//   1) 分页模式顶栏进度恒为 0%
//   2) 切模式掉回章首(或跳到很久以前滚动的位置)
// 现在由分页视图上报页码(PagePosition)、父组件传下落点比例(initialFraction)对接。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from './Reader';
import { KEY_READER_MODE } from '../lib/readerPrefs';
import { getChapterProgress } from '../hooks/useReaderProgress';

const LINE_H = 20; // 每字符一行(合成行盒)
// 768 视口 → 舞台 718 → 内容高 656 → 每页 32 行;标题占 3 行
const PAGE_LINES = 32;
const TITLE_LINES = 3;
const CH1_TITLE = '第一章';
// ch1:标题(3) + 100 字 = 103 行 → 4 页
const CH1_P1 = CH1_TITLE + '字'.repeat(PAGE_LINES - TITLE_LINES);

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

const BOOK_ID = 'b-mode';
const CHAPTER_ID = 'ch1';

const bookJson = {
  id: BOOK_ID,
  title: '模式切换测试书',
  authors: ['作者'],
  language: 'zh',
  publisher: null,
  description: null,
  pub_date: null,
  identifier: 'urn:mode',
  file_size: 1000,
  created_at: '2024-01-01T00:00:00Z',
  chapters: [{ id: CHAPTER_ID, title: CH1_TITLE, spine_order: 0, word_count: 100 }],
  assets: [],
};

const chapterJson = { title: CH1_TITLE, content: `<p>${'字'.repeat(100)}</p>`, format: 'html' };

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

function pagedFoot(): HTMLElement {
  return document.querySelector('.paged-foot') as HTMLElement;
}

async function waitForFoot(part: string): Promise<void> {
  await vi.waitFor(
    () => expect(pagedFoot().textContent ?? '').toContain(part),
    { timeout: 4000 },
  );
}

/** 顶栏进度(如 "3 / 19 · 42%" 里的百分比部分)。 */
function topBarProgress(): string {
  const bar = document.querySelectorAll('header')[0] as HTMLElement;
  return bar.textContent ?? '';
}

describe('阅读模式互通', () => {
  beforeAll(() => {
    const proto = Range.prototype as unknown as {
      getClientRects?: (this: Range) => Array<{
        top: number;
        bottom: number;
        left: number;
        right: number;
        width: number;
        height: number;
      }>;
    };
    proto.getClientRects = function (this: Range) {
      const s = charIndexOf(this.startContainer, this.startOffset);
      const e = charIndexOf(this.endContainer, this.endOffset);
      const rects = [];
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
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/chapters/')) {
          return Promise.resolve({ ok: true, json: async () => chapterJson });
        }
        return Promise.resolve({ ok: true, json: async () => bookJson });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('分页模式下顶栏进度跟着页码走(不再是 0%)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');
    // 第 1 页 / 共 4 页 → 25%(修前恒为 0%)
    await waitFor(() => expect(topBarProgress()).toContain('25%'));

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('2 / 4 页');
    await waitFor(() => expect(topBarProgress()).toContain('50%'));
  });

  it('分页翻页会同步滚动模式的百分比(切回滚动能落回同一处)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('2 / 4 页');
    // 注:翻页动画进行中再按方向键会被合并(现语义:一次动画只推进一页),
    // 所以这里等落定后再按第二下
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('3 / 4 页');

    // 第 3 页(0 基 2)/ 4 页 → 0.5,切回滚动模式即从这里继续
    await waitFor(() => expect(getChapterProgress(BOOK_ID, CHAPTER_ID)).toBeCloseTo(0.5, 5));
  });

  it('滚动模式切到分页模式:按当前滚动位置落点,不掉回章首', async () => {
    // 默认即滚动模式(不写 KEY_READER_MODE)
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    const scroller = (await screen.findByLabelText('章节正文')) as HTMLElement;
    // jsdom 没有真实布局:给出几何并滚到一半
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    scroller.scrollTop = 400; // 400 / (1000-200) = 0.5

    // 打开设置 → 切到分页(顶栏与侧栏各有一个设置入口,取第一个)
    await user.click(screen.getAllByRole('button', { name: '阅读设置' })[0]);
    await user.click(screen.getByRole('button', { name: '分页' }));

    // 4 页 × 0.5 → 落在第 3 页(0 基 2),而不是第 1 页
    await waitForFoot('3 / 4 页');
  });

  it('分页模式切回滚动:落回同一处(而不是章首或旧位置)', async () => {
    const user = userEvent.setup();
    localStorage.setItem(KEY_READER_MODE, 'paged');
    const first = render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');

    // 翻到第 3 页(0 基 2 → 0.5);动画期间连按会被合并,故等落定再按
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('2 / 4 页');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('3 / 4 页');

    // 切回滚动模式(设置面板;顶栏与侧栏各有一个入口,取第一个)
    await user.click(screen.getAllByRole('button', { name: '阅读设置' })[0]);
    await user.click(screen.getByRole('button', { name: '滚动' }));
    await screen.findByLabelText('章节正文');
    first.unmount();

    // jsdom 没有布局,恢复 effect 需要真实几何才动 scrollTop;这里给滚动容器
    // 1000/200 的几何后重新进入页面,验证「分页存的 0.5」确实恢复到 400。
    // 用原型级 stub 是因为元素级 stub 来不及(容器挂载时 effect 就跑完了)。
    const shDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    const chDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
    try {
      render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
      const scroller = (await screen.findByLabelText('章节正文')) as HTMLElement;
      await waitFor(() => expect(scroller.scrollTop).toBe(400));
    } finally {
      if (shDesc) Object.defineProperty(Element.prototype, 'scrollHeight', shDesc);
      if (chDesc) Object.defineProperty(Element.prototype, 'clientHeight', chDesc);
    }
  });

  it('分页模式没有已保存锚点时,落点比例只消费一次(翻页后不再回跳)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');

    // 第 1 页内容确实渲染出来了(落点比例 0 也不该空页)
    await vi.waitFor(() =>
      expect(document.querySelector('.paged-page-cur')?.textContent).toBe(CH1_P1),
    );
  });
});
