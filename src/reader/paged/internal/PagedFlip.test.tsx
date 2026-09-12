// 内部实现,勿从外部直接导入 —— 对外入口见 ../index.ts(只公开 PagedReaderView / FlipStyle)。
// 分页翻页端到端回归(jsdom)。
// 通过给 Range.prototype.getClientRects 打「合成行盒」补丁(每字符一行、
// 行高 20px,纯空白无行盒 —— 与真实浏览器语义一致),让分页引擎在
// jsdom 里真正切出多页,验证 键盘翻页 → SlideFlip 落定 → 原子交接 →
// 页码/预填 的完整链路。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderPage from '../../../pages/Reader';
import { KEY_READER_MODE } from '../../../lib/readerPrefs';

const LINE_H = 20; // 每字符一行(合成行盒)
// 768 视口 → 舞台 718(仅页脚 34 + 边距 16)→ 内容高 656 → 每页 32 行。
// 章节标题以 <h3> 注入正文首位,占 3 行('第一章' 3 字符)。
const PAGE_LINES = 32;
const TITLE_LINES = 3;
const CH1_TITLE = '第一章';
const CH2_TITLE = '第二章';
// ch1:标题(3) + 100 字 = 103 行 → 4 页(32/32/32/7)
const CH1_P1 = CH1_TITLE + '字'.repeat(PAGE_LINES - TITLE_LINES);
const CH1_P2 = '字'.repeat(PAGE_LINES);
const CH1_P4 = '字'.repeat(103 - PAGE_LINES * 3);
// ch2:标题(3) + 50 字 = 53 行 → 2 页(32/21)
const CH2_P1 = CH2_TITLE + '乙'.repeat(PAGE_LINES - TITLE_LINES);
const CH2_P2 = '乙'.repeat(53 - PAGE_LINES);

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

// 搜索定位用章节:两处「殷萱儿」分别落在不同页
// 排版行序:标题 3 行 + 40 甲 → 第 1 处(第 43 行,第 2 页)
//          + 3 + 40 乙 → 第 2 处(第 86 行,第 3 页)+ 3 + 20 丙
const LOC_CONTENT = `<p>${'甲'.repeat(40)}殷萱儿${'乙'.repeat(40)}殷萱儿${'丙'.repeat(20)}</p>`;
const chapterJsonLoc = { title: '定位章', content: LOC_CONTENT, format: 'html' };

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

/** 分页页脚(章节进度 + 页码 + 章内进度)。 */
function pagedFoot(): HTMLElement {
  return document.querySelector('.paged-foot') as HTMLElement;
}

/** 分页当前页元素。 */
function curPage(): HTMLElement {
  return document.querySelector('.paged-page-cur') as HTMLElement;
}

/** 等待页脚出现指定片段(跨章落地的无歧义标记)。 */
async function waitForFoot(part: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(pagedFoot().textContent ?? '').toContain(part);
    },
    { timeout: 4000 }, // 全量测试并行时环境较慢,留足余量
  );
}

/**
 * 等待当前页内容渲染为指定文本。
 * 页脚由状态驱动、页面内容由 effect 驱动,两者之间存在一帧窗口;
 * 断言内容前必须先等它落地(否则并行负载下会偶发空页)。
 */
async function waitForPage(expected: string): Promise<void> {
  await vi.waitFor(
    () => expect(curPage().textContent).toBe(expected),
    { timeout: 4000 },
  );
}

/** 派发指针事件:jsdom 无 PointerEvent 时退化为普通 Event + 属性拷贝
 *  (Testing Library 的 fireEvent 走 Event 构造器会丢掉 clientX/clientY)。 */
function firePointer(el: Element, type: string, init: PointerEventInit): void {
  const ev =
    typeof PointerEvent === 'function'
      ? new PointerEvent(type, { bubbles: true, cancelable: true, ...init })
      : Object.assign(new Event(type, { bubbles: true, cancelable: true }), init);
  el.dispatchEvent(ev);
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
        if (url.includes('/chapters/loc')) {
          return Promise.resolve({ ok: true, json: async () => chapterJsonLoc });
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

    // 标题(3 行) + 100 字 / 每页 32 行 → 4 页
    await waitForFoot('1 / 4 页');
    await waitForPage(CH1_P1); // 内容由 effect 渲染,先等落地

    const stage = screen.getByLabelText('分页正文');
    const cur = stage.querySelector('.paged-page-cur') as HTMLElement;
    const next = stage.querySelector('.paged-page-next') as HTMLElement;

    // 插图缩放上限 = 页内容区高(见 index.css);变量挂在视口上,测量容器
    // 与页面容器取值一致,所以「测量 = 渲染」不被破坏
    const viewport = document.querySelector('.paged-viewport') as HTMLElement;
    expect(viewport.style.getPropertyValue('--paged-img-max-h')).toBe('656px');
    // 第 1 页 = 正文首位的 <h3> 章节标题 + 前 29 字
    expect(cur.querySelector('h3')?.textContent).toBe(CH1_TITLE);
    expect(cur.textContent).toBe(CH1_P1);

    // 键盘向后翻一页(slide 260ms 异步落定)
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('2 / 4 页');
    expect(cur.textContent).toBe(CH1_P2); // 第 2 页 = 32 字

    // 交接完成后:next 复位隐藏,且预填第 3 页(前视)
    expect(next.style.visibility).toBe('hidden');
    expect(next.style.transform).toBe('');
    expect(next.textContent).toBe(CH1_P2);

    // 再翻一页到第 3 页
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('3 / 4 页');
    expect(cur.textContent).toBe(CH1_P2);
  });

  it('向前翻:从第 2 页回到第 1 页', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('2 / 4 页');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitForFoot('1 / 4 页');
    await waitForPage(CH1_P1);
  });

  it('章末向前翻:无下一页时键盘触发跨章导航', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    await waitForFoot('1 / 4 页');

    // 翻到最后一页(第 4 页 = 末尾 7 字)
    fireEvent.keyDown(window, { key: 'End' });
    await waitForFoot('4 / 4 页');
    await waitForPage(CH1_P4);

    // 再向前 → 跨章(邻章已预分页则平滑翻页,否则直跳)→ 第二章
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitForFoot('第 2 / 2 章');
  });

  it('跨章前进:章末翻页平滑滑入下一章第一页(动画路径)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />,
    );
    await waitForFoot('1 / 4 页');

    // 翻到本章最后一页
    fireEvent.keyDown(window, { key: 'End' });
    await waitForFoot('4 / 4 页');
    await waitForPage(CH1_P4);

    // 等邻章(ch2)预分页完成(空闲回退 300ms + 测量,留足裕量)
    await new Promise((r) => setTimeout(r, 700));

    // 跨章向前:begin 在 keydown 派发内同步发生 —— 被揭示页立刻
    // 装载下一章第 1 页(含其 <h3> 标题)并可见
    // (直跳路径不会填 next,以此区分两条路径)
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const stage = screen.getByLabelText('分页正文');
    const next = stage.querySelector('.paged-page-next') as HTMLElement;
    expect(next.style.visibility).toBe('visible');
    expect(next.textContent).toBe(CH2_P1);

    // 落地:cur 原子交接为下一章第 1 页(动画完成后同帧发生)
    await vi.waitFor(() => expect(curPage().textContent).toBe(CH2_P1), {
      timeout: 1500,
    });
    // 页脚:第二章第 1 页(导航重渲染在微任务中,同样需要等待)
    await waitForFoot('第 2 / 2 章 · 1 / 2 页');
    // 交接后 next 复位隐藏,且预填下一章的第 2 页
    expect(next.style.visibility).toBe('hidden');
    expect(next.textContent).toBe(CH2_P2);
  });

  it('翻页时自动隐藏顶栏工具栏', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');

    // 顶栏是文档中第一个 <header>(ReaderSettings 的 header 在其后)
    const bar = () => document.querySelectorAll('header')[0] as HTMLElement;
    expect(bar().className).toContain('opacity-100'); // 初始可见

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await vi.waitFor(() => expect(bar().className).toContain('opacity-0'));

    // 中央点击仍可呼出(既有交互不回退)。
    // 注意:jsdom 的 getBoundingClientRect 全为 0,合成坐标需按
    // stage 内联尺寸直接给「中央 1/3 区域」内的点
    const stage = screen.getByLabelText('分页正文');
    const w = parseInt(stage.style.width, 10);
    const h = parseInt(stage.style.height, 10);
    const cx = w / 2;
    const cy = h / 2;
    firePointer(stage, 'pointerdown', { clientX: cx, clientY: cy, pointerId: 1, button: 0 });
    firePointer(stage, 'pointerup', { clientX: cx, clientY: cy, pointerId: 1, button: 0 });
    await vi.waitFor(() => expect(bar().className).toContain('opacity-100'));
  });

  it('搜索命中定位:?q&n 跳到命中所在页并选中高亮', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    // 第 2 处「殷萱儿」在第 3 页(行 86 / 每页 32 行)
    render(
      <ReaderHarness
        initialRoute={`/books/${BOOK_ID}/chapters/loc?q=${encodeURIComponent('殷萱儿')}&n=2`}
      />,
    );

    await waitForFoot('3 / 4 页');
    await vi.waitFor(() => expect(curPage().textContent).toContain('殷萱儿'));
    // 原生选中作为高亮(jsdom 支持 Selection)
    expect(window.getSelection()?.toString()).toBe('殷萱儿');
  });

  it('跨章后退:章首翻页平滑滑回上一章末页(无保存锚点时)', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(
      <ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/ch2`} />,
    );
    await waitForFoot('1 / 2 页');
    await waitForPage(CH2_P1);

    // 等邻章(ch1)预分页完成(空闲回退 300ms + 测量)
    await new Promise((r) => setTimeout(r, 700));

    // 跨章向后:begin 同步发生 —— 被揭示页立刻装载上一章最后一页
    // (无 recent 锚点 → 末页;直跳路径不会填 next)
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    const stage = screen.getByLabelText('分页正文');
    const next = stage.querySelector('.paged-page-next') as HTMLElement;
    expect(next.style.visibility).toBe('visible');
    expect(next.textContent).toBe(CH1_P4);

    // 落地:第一章末页
    await waitForFoot('第 1 / 2 章 · 4 / 4 页');
    expect(curPage().textContent).toBe(CH1_P4);
  });

  it('翻页动画进行中按 Home:停在章首页,不被在飞的落定顶到下一页', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');
    await waitForPage(CH1_P1);

    // 起一页动画(260ms 后才落定),动画途中按 Home 跳章首
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Home' });
    expect(pagedFoot().textContent).toContain('1 / 4 页');

    // 等落定窗口过去:不能被 pending 的 onSettled 顶到第 2 页
    await new Promise((r) => setTimeout(r, 600));
    expect(pagedFoot().textContent).toContain('1 / 4 页');
    await waitForPage(CH1_P1);
  });

  it('拖动翻页:翻页开始触发父组件重渲染,不能丢掉进行中的手势', async () => {
    localStorage.setItem(KEY_READER_MODE, 'paged');
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);
    await waitForFoot('1 / 4 页');
    await waitForPage(CH1_P1);

    const stage = screen.getByLabelText('分页正文');
    const w = parseInt(stage.style.width, 10);
    const h = parseInt(stage.style.height, 10);
    const startX = w * 0.75; // 右 1/3 → 向后翻
    const y = h * 0.75; // 避开中央 1/3 菜单区
    const endX = startX - w * 0.4; // 向左拖 = 翻页方向

    // 按下就调用 onPageTurn(收起工具栏)→ Reader 重渲染。
    // 真实浏览器里 move/up 至少晚一帧到达,React 会把被动 effect 冲干净
    // (即手势 effect 重挂);这里用 waitFor 等工具栏真正收起,复现该时序。
    firePointer(stage, 'pointerdown', { clientX: startX, clientY: y, pointerId: 1, button: 0 });
    const bar = () => document.querySelectorAll('header')[0] as HTMLElement;
    await vi.waitFor(() => expect(bar().className).toContain('opacity-0'));
    firePointer(stage, 'pointermove', { clientX: endX, clientY: y, pointerId: 1 });
    firePointer(stage, 'pointerup', { clientX: endX, clientY: y, pointerId: 1, button: 0 });

    // 位移够大 → 松手应完成翻页(而不是卡在半路)
    await waitForFoot('2 / 4 页');
    await waitForPage(CH1_P2);
  });
});
