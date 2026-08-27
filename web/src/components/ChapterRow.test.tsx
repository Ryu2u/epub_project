// ChapterRow 单元测试：覆盖 read/edit 两种渲染、memo 命中、拖拽/编辑交互。
// 风格与 ReaderTocPanel.test.tsx 一致：Vitest + Testing Library。

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChapterRow } from './ChapterRow';
import type { ChapterOut } from '../api/types';

const BOOK_ID = 'b1';

const chapter = (over: Partial<ChapterOut> = {}): ChapterOut => ({
  id: 'ch1.xhtml',
  title: '第一章 开始',
  spine_order: 0,
  word_count: 1234,
  ...over,
});

const NOOP = () => {};

const baseProps = {
  bookId: BOOK_ID,
  index: 0,
  progress: 0,
  editMode: false,
  isEditing: false,
  isDragging: false,
  isOver: false,
  isCurrent: false,
  onStartEdit: NOOP,
  onSaveTitle: NOOP,
  onCancelEdit: NOOP,
  onDragStart: NOOP,
  onDragOver: NOOP,
  onDrop: NOOP,
  onDragEnd: NOOP,
};

const stableChapter = chapter();

function renderRow(propsOverride: Partial<React.ComponentProps<typeof ChapterRow>> = {}) {
  const allProps = { ...baseProps, chapter: chapter(), ...propsOverride };
  return render(
    <MemoryRouter>
      <ul>
        <ChapterRow {...allProps} />
      </ul>
    </MemoryRouter>,
  );
}

describe('ChapterRow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('read 模式渲染为跳到 Reader 的链接（带 encodeURIComponent）', () => {
    renderRow();
    const link = screen.getByRole('link', { name: /第一章 开始/ });
    expect(link.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/chapters/${encodeURIComponent('ch1.xhtml')}`,
    );
  });

  it('read 模式进度 0~1 之间显示百分比', () => {
    renderRow({ progress: 0.42 });
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('read 模式进度 =1 显示 ✓', () => {
    renderRow({ progress: 1 });
    expect(screen.getByLabelText('已读完')).toBeInTheDocument();
  });

  it('read 模式进度 =0 不显示进度文字', () => {
    renderRow({ progress: 0 });
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('已读完')).not.toBeInTheDocument();
  });

  it('进度百分比位于行尾（字数之后），不给标题让位', () => {
    const { container } = renderRow({ progress: 0.42 });
    const text = container.querySelector('li')?.textContent ?? '';
    // 行内顺序：标题 … 字数 … 42%
    expect(text.indexOf('1234 词')).toBeGreaterThan(text.indexOf('第一章 开始'));
    expect(text.indexOf('42%')).toBeGreaterThan(text.indexOf('1234 词'));
  });

  it('isCurrent=true 的章节标记 aria-current 并金色高亮', () => {
    renderRow({ isCurrent: true });
    const link = screen.getByRole('link', { name: /第一章 开始/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.className).toContain('text-gold-200');
  });

  it('isCurrent=false 的章节无 aria-current', () => {
    renderRow();
    expect(screen.getByRole('link', { name: /第一章 开始/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('read 模式不渲染拖拽手柄与"编辑"链接', () => {
    renderRow();
    expect(screen.queryByText('⠿')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('edit 模式渲染拖拽手柄 + 章节标题按钮 + "编辑"链接', () => {
    renderRow({ editMode: true });
    // 拖拽手柄
    expect(screen.getByText('⠿')).toBeInTheDocument();
    // 标题变 button
    const titleBtn = screen.getByRole('button', { name: /第一章 开始/ });
    expect(titleBtn).toBeInTheDocument();
    expect(titleBtn).toHaveAttribute('title', '点击编辑标题');
    // "编辑"链接 → 跳到正文编辑器
    const editLink = screen.getByRole('link', { name: '编辑' });
    expect(editLink.getAttribute('href')).toBe(
      `/books/${BOOK_ID}/edit/${encodeURIComponent('ch1.xhtml')}`,
    );
  });

  it('edit 模式下 li 可拖拽', () => {
    const { container } = renderRow({ editMode: true });
    const li = container.querySelector('li');
    expect(li).toHaveAttribute('draggable', 'true');
  });

  it('read 模式下 li 不可拖拽（无 draggable=true）', () => {
    const { container } = renderRow();
    const li = container.querySelector('li');
    // editMode=false 时 React 不输出 draggable 属性（默认 false）
    expect(li?.getAttribute('draggable')).not.toBe('true');
  });

  it('点击编辑标题按钮触发 onStartEdit', async () => {
    const user = userEvent.setup();
    const onStartEdit = vi.fn();
    renderRow({ editMode: true, onStartEdit });
    await user.click(screen.getByRole('button', { name: /第一章 开始/ }));
    expect(onStartEdit).toHaveBeenCalledWith('ch1.xhtml', '第一章 开始');
  });

  it('拖拽事件透传', () => {
    const onDragStart = vi.fn();
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();
    const { container } = renderRow({
      editMode: true,
      onDragStart,
      onDragOver,
      onDrop,
      onDragEnd,
    });
    const li = container.querySelector('li')!;
    li.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(onDragStart).toHaveBeenCalled();
    li.dispatchEvent(new Event('dragover', { bubbles: true }));
    expect(onDragOver).toHaveBeenCalled();
    li.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(onDrop).toHaveBeenCalled();
    li.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(onDragEnd).toHaveBeenCalled();
  });

  it('isDragging 状态添加 opacity-40', () => {
    const { container } = renderRow({ editMode: true, isDragging: true });
    const li = container.querySelector('li')!;
    expect(li.className).toContain('opacity-40');
  });

  it('isOver 状态添加 border-t-2 border-gold-400', () => {
    const { container } = renderRow({ editMode: true, isOver: true });
    const li = container.querySelector('li')!;
    expect(li.className).toContain('border-t-2');
    expect(li.className).toContain('border-gold-400');
  });

  it('isEditing 模式显示 input，blur 时若变更触发 onSaveTitle', async () => {
    const user = userEvent.setup();
    const onSaveTitle = vi.fn();
    const onCancelEdit = vi.fn();
    renderRow({ editMode: true, isEditing: true, onSaveTitle, onCancelEdit });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('第一章 开始');
    await user.clear(input);
    await user.type(input, '改写后的标题');
    input.blur();
    expect(onSaveTitle).toHaveBeenCalledWith('ch1.xhtml', '改写后的标题');
    expect(onCancelEdit).not.toHaveBeenCalled();
  });

  it('isEditing 模式按 Esc 触发 onCancelEdit', async () => {
    const user = userEvent.setup();
    const onSaveTitle = vi.fn();
    const onCancelEdit = vi.fn();
    renderRow({ editMode: true, isEditing: true, onSaveTitle, onCancelEdit });
    const input = screen.getByRole('textbox');
    input.focus();
    await user.keyboard('{Escape}');
    expect(onCancelEdit).toHaveBeenCalledWith('ch1.xhtml');
    expect(onSaveTitle).not.toHaveBeenCalled();
  });

  it('isEditing 模式 blur 时未变更则触发 onCancelEdit', async () => {
    const onSaveTitle = vi.fn();
    const onCancelEdit = vi.fn();
    renderRow({ editMode: true, isEditing: true, onSaveTitle, onCancelEdit });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.blur();
    expect(onCancelEdit).toHaveBeenCalledWith('ch1.xhtml');
    expect(onSaveTitle).not.toHaveBeenCalled();
  });

  it('React.memo: 父组件无关 state 变化时 row 不重渲染', () => {
    // 钩住 CountingRow 内部的执行次数。CountingRow 也用 memo 包裹，
    // 这样当父组件传同样的 props 引用时，CountingRow 浅比较命中、跳过执行。
    const renderLog: string[] = [];
    const CountingRowImpl = (props: React.ComponentProps<typeof ChapterRow>) => {
      renderLog.push(`row:${props.chapter.id}:${props.editMode ? 'edit' : 'read'}`);
      return <ChapterRow {...props} />;
    };
    const CountingRow = React.memo(CountingRowImpl);
    function Parent({ tick }: { tick: number }) {
      return (
        <MemoryRouter>
          <ul data-testid="parent" data-tick={tick}>
            <CountingRow
              chapter={stableChapter}
              bookId={BOOK_ID}
              index={0}
              progress={0}
              editMode={false}
              isEditing={false}
              isDragging={false}
              isOver={false}
              isCurrent={false}
              onStartEdit={NOOP}
              onSaveTitle={NOOP}
              onCancelEdit={NOOP}
              onDragStart={NOOP}
              onDragOver={NOOP}
              onDrop={NOOP}
              onDragEnd={NOOP}
            />
          </ul>
        </MemoryRouter>
      );
    }
    const { rerender } = render(<Parent tick={0} />);
    expect(renderLog).toEqual(['row:ch1.xhtml:read']);
    // 父组件重渲染但所有 props 引用稳定 → CountingRow 的 memo 浅比较应命中 → 不再执行
    rerender(<Parent tick={1} />);
    expect(renderLog).toEqual(['row:ch1.xhtml:read']);
  });
});
