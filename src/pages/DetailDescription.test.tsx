// 详情页图书简介折叠/展开:
// - 实际被截断(内容高度 > 可视高度)时出现「展开」
// - 展开后可「收起」,且展开态不会因为"不再溢出"而把按钮弄丢
// - 短简介不显示多余按钮
//
// jsdom 没有布局(scrollHeight/clientHeight 恒为 0),这里用 defineProperty
// 造出"内容比可视区高"的条件,并触发 resize 让组件重新测量。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '../pages/Detail';

function DetailHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/books/b1`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/books/:id" element={<DetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function bookWith(description: string | null) {
  return {
    id: 'b1',
    title: '简介测试书',
    authors: ['作者'],
    language: 'zh',
    publisher: null,
    description,
    pub_date: null,
    identifier: 'urn:desc',
    file_size: 1000,
    created_at: '2024-01-01T00:00:00Z',
    chapters: [{ id: 'c1', title: '第一章', spine_order: 0, word_count: 100 }],
    assets: [],
  };
}

const LONG = '这是一段很长的简介。'.repeat(30);
const SHORT = '很短的一句简介。';

function stubBook(description: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => bookWith(description) }),
  );
}

/** 造出"内容比可视区高"的条件,并触发重测(jsdom 无布局)。 */
function makeOverflowing(el: HTMLElement, scrollHeight = 200, clientHeight = 80) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  fireEvent(window, new Event('resize'));
}

describe('DetailPage 图书简介折叠', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('长简介', () => {
    beforeEach(() => stubBook(LONG));

    it('折叠态截断文本,点「展开」后完整显示并可「收起」', async () => {
      const user = userEvent.setup();
      render(<DetailHarness />);
      const dd = await screen.findByTestId('book-description');

      // 默认折叠:内联多行截断
      expect(dd.style.display).toBe('-webkit-box');
      expect(dd.style.webkitLineClamp).toBe('4');
      // 未测出溢出前不显示按钮
      expect(screen.queryByRole('button', { name: '展开' })).toBeNull();

      makeOverflowing(dd);
      const expand = await screen.findByRole('button', { name: '展开' });

      await user.click(expand);
      // 展开:去掉截断,按钮变「收起」
      expect(dd.style.display).toBe('');
      expect(dd.style.webkitLineClamp).toBe('');
      const collapse = await screen.findByRole('button', { name: '收起' });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');

      // 再收起:回到截断态,「展开」按钮还在(不会因不再溢出而消失)
      await user.click(collapse);
      await waitFor(() => expect(dd.style.display).toBe('-webkit-box'));
      expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument();
    });
  });

  describe('短简介', () => {
    beforeEach(() => stubBook(SHORT));

    it('未溢出时不显示「展开」按钮,内容照常显示', async () => {
      render(<DetailHarness />);
      const dd = await screen.findByTestId('book-description');
      expect(dd).toHaveTextContent(SHORT);
      // 内容比可视区矮 → 无按钮
      makeOverflowing(dd, 80, 200);
      expect(screen.queryByRole('button', { name: '展开' })).toBeNull();
    });
  });

  describe('无简介', () => {
    beforeEach(() => stubBook(null));

    it('整个简介区块不渲染', async () => {
      render(<DetailHarness />);
      await screen.findByText('简介测试书');
      expect(screen.queryByTestId('book-description')).toBeNull();
      expect(screen.queryByText('简介')).toBeNull();
    });
  });
});
