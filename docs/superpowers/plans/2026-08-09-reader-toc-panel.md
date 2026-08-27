# 阅读器目录面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阅读器内通过顶栏入口弹出侧边目录面板，支持浏览完整章节、当前章节高亮、点击任意章节跳转并落地到顶部。

**Architecture:** 新增纯展示组件 `ReaderTocPanel`（与现有 `ReaderSettings` 同架构：遮罩 + 右侧 transform 滑入）。复用 `bookQuery.data.chapters` 已缓存的目录数据，零新后端端点。`ReaderTopBar` 加 `onTocOpen` 回调 prop；`Reader.tsx` 编排 `tocOpen` 状态 + `tocJumpRef` 处理目录跳转的顶部落地。

**Tech Stack:** React 18, react-router-dom v6, TanStack Query v5, TailwindCSS, Vitest + Testing Library + MemoryRouter

**Spec:** `docs/superpowers/specs/2026-08-09-reader-toc-panel-design.md`

## Global Constraints

- 路径全部用绝对 Windows 路径 `E:\Project\epub_project\...`，在 PowerShell 下执行
- 测试框架：Vitest + @testing-library/react + MemoryRouter（与 `Reader.test.tsx` 同栈）
- 命名：组件文件 PascalCase（如 `ReaderTocPanel.tsx`），测试文件 `*.test.tsx`
- 后端零改动（数据已在 bookQuery 缓存）
- 不引入新 npm 依赖
- Tailwind 类名沿用现有 `ReaderSettings` / `ReaderTopBar` 的写法（`text-cream-faint`, `bg-black/5`, `border-gold-400` 等）
- 提交粒度：每个 task 完成后独立 commit（不要 squash）

---

## File Structure

| 文件 | 状态 | 职责 |
|---|---|---|
| `web/src/components/ReaderTocPanel.tsx` | 新增 | 纯展示组件：渲染遮罩 + 侧边面板 + 章节列表 + 当前章节高亮 + 自动滚到当前项 + ESC 关闭 |
| `web/src/components/ReaderTocPanel.test.tsx` | 新增 | 单元测试 10 个用例 |
| `web/src/components/ReaderToolbar.tsx` | 修改 | `ReaderTopBar` 加 `onTocOpen` prop，标题 `<h1>` 改为可点击 |
| `web/src/pages/Reader.tsx` | 修改 | 加 `tocOpen` state + `tocJumpRef` + `handleTocSelect`；useEffect rAF 回调里消费 tocJumpRef 强制顶部落地；渲染 `<ReaderTocPanel>` |
| `web/src/pages/Reader.test.tsx` | 修改 | 加 1 个集成用例：点击顶栏标题 → 目录面板出现 |

---

## Task 1: ReaderTocPanel 单元测试骨架（10 个失败用例）

**Files:**
- Create: `E:\Project\epub_project\web\src\components\ReaderTocPanel.test.tsx`

**Interfaces:**
- Produces: 测试文件验证 `ReaderTocPanel` 暴露 `open`, `onClose`, `bookId`, `chapters`, `currentChapterId`, `onChapterSelect` 六个 props（详见后续 task）

- [ ] **Step 1: 写测试文件**

完整代码如下：

```tsx
// ReaderTocPanel 单元测试：覆盖渲染、高亮、关闭交互、键盘、自动滚动、点击跳转。
// 用 Vitest + Testing Library + MemoryRouter（与 Reader.test.tsx 同栈）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderTocPanel } from '../components/ReaderTocPanel';
import type { ChapterOut } from '../api/types';

function PanelHarness({
  initialEntries = ['/somewhere'],
  onClose = vi.fn(),
  onChapterSelect = vi.fn(),
  open = true,
  currentChapterId = 'ch1',
  chapters = TEST_CHAPTERS,
}: {
  initialEntries?: string[];
  onClose?: () => void;
  onChapterSelect?: (id: string) => void;
  open?: boolean;
  currentChapterId?: string;
  chapters?: ChapterOut[];
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="*"
            element={
              <ReaderTocPanel
                open={open}
                onClose={onClose}
                bookId="b1"
                chapters={chapters}
                currentChapterId={currentChapterId}
                onChapterSelect={onChapterSelect}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const TEST_CHAPTERS: ChapterOut[] = [
  { id: 'ch1', title: '第一章 开端', spine_order: 0, word_count: 100 },
  { id: 'ch2', title: '第二章 发展', spine_order: 1, word_count: 200 },
  { id: 'ch3', title: '第三章 高潮', spine_order: 2, word_count: 300 },
  { id: 'ch4', title: '第四章 结局', spine_order: 3, word_count: 400 },
  { id: 'ch5', title: '第五章 尾声', spine_order: 4, word_count: 150 },
];

describe('ReaderTocPanel', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onChapterSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onChapterSelect = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染所有章节项', () => {
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    // 5 个章节标题都出现
    expect(screen.getByText('第一章 开端')).toBeInTheDocument();
    expect(screen.getByText('第二章 发展')).toBeInTheDocument();
    expect(screen.getByText('第三章 高潮')).toBeInTheDocument();
    expect(screen.getByText('第四章 结局')).toBeInTheDocument();
    expect(screen.getByText('第五章 尾声')).toBeInTheDocument();
  });

  it('当前章节用金色左边竖线高亮', () => {
    render(
      <PanelHarness
        onClose={onClose}
        onChapterSelect={onChapterSelect}
        currentChapterId="ch2"
      />,
    );
    // ch2 的 button 含 border-gold-400 class
    const currentBtn = screen.getByText('第二章 发展').closest('button')!;
    expect(currentBtn.className).toContain('border-gold-400');
    // 其他章节不含
    const otherBtn = screen.getByText('第一章 开端').closest('button')!;
    expect(otherBtn.className).toContain('border-transparent');
  });

  it('点击 ✕ 按钮触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.click(screen.getByRole('button', { name: /关闭目录/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    // 遮罩是 aria-hidden=true 的 div
    const overlay = document.querySelector('[aria-hidden="true"]')!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC 键触发 onClose', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭时遮罩不可点', () => {
    render(
      <PanelHarness
        open={false}
        onClose={onClose}
        onChapterSelect={onChapterSelect}
      />,
    );
    const overlay = document.querySelector('[aria-hidden="true"]')!;
    expect(overlay.className).toContain('pointer-events-none');
  });

  it('关闭时面板 translate 滑出', () => {
    render(
      <PanelHarness
        open={false}
        onClose={onClose}
        onChapterSelect={onChapterSelect}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('translate-x-full');
  });

  it('面板 aria 属性正确', () => {
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    const dialog = screen.getByRole('dialog', { name: '目录' });
    expect(dialog).toBeInTheDocument();
  });

  it('点击章节项调用 onChapterSelect 并传入该章节 id', async () => {
    const user = userEvent.setup();
    render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
    await user.click(screen.getByText('第三章 高潮').closest('button')!);
    expect(onChapterSelect).toHaveBeenCalledTimes(1);
    expect(onChapterSelect).toHaveBeenCalledWith('ch3');
  });

  it('打开时当前章节项 scrollIntoView 被调用', async () => {
    const scrollIntoViewSpy = vi.fn();
    // 用原型 hack 给 HTMLElement.prototype.scrollIntoView 安装 spy
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      render(<PanelHarness onClose={onClose} onChapterSelect={onChapterSelect} />);
      await waitFor(() => {
        expect(scrollIntoViewSpy).toHaveBeenCalled();
      });
      const callArg = scrollIntoViewSpy.mock.calls[0]?.[0] as { block?: string } | undefined;
      expect(callArg?.block).toBe('center');
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
```

- [ ] **Step 2: 运行测试，验证全部失败**

```powershell
cd E:\Project\epub_project\web
npm test -- src/components/ReaderTocPanel.test.tsx
```

预期：所有 10 个用例 FAIL，错误信息含 `Cannot find module '../components/ReaderTocPanel'` 或类似（因为 `ReaderTocPanel.tsx` 还不存在）。

- [ ] **Step 3: 提交测试骨架**

```powershell
cd E:\Project\epub_project
git add web/src/components/ReaderTocPanel.test.tsx
git commit -m "test(reader-toc): 失败测试骨架覆盖 10 个用例"
```

---

## Task 2: ReaderTocPanel 最小实现让所有测试通过

**Files:**
- Create: `E:\Project\epub_project\web\src\components\ReaderTocPanel.tsx`

**Interfaces:**
- Consumes: `ChapterOut` from `web/src/api/types`
- Produces: 受控组件 `ReaderTocPanel`，6 个 props：`open: boolean`, `onClose: () => void`, `bookId: string`, `chapters: ChapterOut[]`, `currentChapterId: string`, `onChapterSelect: (id: string) => void`

- [ ] **Step 1: 创建 `ReaderTocPanel.tsx`**

完整代码如下：

```tsx
// 阅读器目录面板：右侧滑入的 sheet（仿 iOS Books）。
// 复用 bookQuery.data.chapters 缓存，零新后端端点。
// 与 ReaderSettings 同架构：遮罩 + transform 滑入；受控组件模式。

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChapterOut } from '../api/types';

export interface ReaderTocPanelProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  chapters: ChapterOut[]; // 已按 spine_order 排序
  currentChapterId: string;
  onChapterSelect: (id: string) => void;
}

export function ReaderTocPanel({
  open,
  onClose,
  bookId,
  chapters,
  currentChapterId,
  onChapterSelect,
}: ReaderTocPanelProps) {
  const navigate = useNavigate();
  const currentRef = useRef<HTMLButtonElement | null>(null);

  // ESC 键关闭面板（与 ReaderSettings 同模式）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时自动滚动到当前章节（视区中央）
  useEffect(() => {
    if (!open) return;
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [open, currentChapterId]);

  const handleItemClick = (chapterId: string) => {
    onChapterSelect(chapterId);
  };

  return (
    <>
      {/* 背景遮罩：点击可关闭 */}
      <div
        onClick={onClose}
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        aria-hidden="true"
      />
      {/* Sheet 面板 */}
      <aside
        role="dialog"
        aria-label="目录"
        className={[
          'fixed top-0 right-0 bottom-0 z-50',
          'w-[85%] sm:w-[360px]',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <div className="h-full flex flex-col">
          <header className="flex items-center justify-between px-4 py-3 border-b border-black/10">
            <h2 className="font-display text-lg font-semibold">目录</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭目录"
              className="px-3 py-1 rounded-md text-sm hover:bg-black/5"
            >
              ✕
            </button>
          </header>

          <ul role="list" className="flex-1 overflow-y-auto py-2">
            {chapters.map((ch, idx) => {
              const isCurrent = ch.id === currentChapterId;
              return (
                <li key={ch.id}>
                  <button
                    ref={isCurrent ? currentRef : undefined}
                    type="button"
                    onClick={() => handleItemClick(ch.id)}
                    className={[
                      'flex items-center gap-3 px-4 py-3 w-full text-left',
                      'border-l-2 transition-colors',
                      isCurrent
                        ? 'border-gold-400 bg-black/5 font-medium'
                        : 'border-transparent hover:bg-black/5',
                    ].join(' ')}
                  >
                    <span className="text-xs tabular-nums text-cream-faint w-6 shrink-0">
                      {idx + 1}
                    </span>
                    <span className="truncate text-sm">{ch.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </>
  );
}

// 保留 navigate 引用以防 lint 警告未来需求（如需内部跳转可启用）
void navigatePlaceholder(navigate);

function navigatePlaceholder(_: ReturnType<typeof useNavigate>) {
  /* no-op；保留给未来"无回调时内部跳转"扩展 */
}
```

- [ ] **Step 2: 运行测试，验证全部通过**

```powershell
cd E:\Project\epub_project\web
npm test -- src/components/ReaderTocPanel.test.tsx
```

预期：10 个用例 PASS。

> 注：上面 `navigatePlaceholder` + `void` 是为了让 `useNavigate()` 不被 unused 警告。**如果测试通过后 ESLint 仍报 `useNavigate` unused，请删除 `useNavigate` 调用、`navigatePlaceholder` 函数和 `void` 语句**——本 spec 设计里点击跳转完全由 `onChapterSelect` 回调上提给 Reader.tsx 处理，组件内部不需要 useNavigate。

> **Plan 维护注**：实际 Task 2 实现采用了更干净的方案——函数签名解构中**不取** `bookId`，不导入 `useNavigate`，整个 `navigatePlaceholder` 段最终被删除。请以实现为准（commit `b4ecd0f`）。

- [ ] **Step 3: 移除未用的 `useNavigate`**

如果上一步 ESLint/noUnusedLocals 报错，把组件顶部改为：

```tsx
import { useEffect, useRef } from 'react';
import type { ChapterOut } from '../api/types';
```

并删除文件底部的 `navigatePlaceholder` 函数和 `void navigatePlaceholder(navigate);` 行。

- [ ] **Step 4: 重新运行测试确认仍通过**

```powershell
cd E:\Project\epub_project\web
npm test -- src/components/ReaderTocPanel.test.tsx
```

预期：10 个用例 PASS。

- [ ] **Step 5: 提交**

```powershell
cd E:\Project\epub_project
git add web/src/components/ReaderTocPanel.tsx
git commit -m "feat(reader-toc): ReaderTocPanel 实现"
```

---

## Task 3: ReaderTopBar 加 onTocOpen 回调 prop

**Files:**
- Modify: `E:\Project\epub_project\web\src\components\ReaderToolbar.tsx` — `ReaderTopBarProps` 加 `onTocOpen: () => void`；标题 `<h1>` 加 `onClick`、`cursor-pointer`、`hover:opacity-70`、`title`、`role="button"`、`aria-label`

**Interfaces:**
- Consumes: 现有的 `ReaderTopBarProps` 4 个 prop
- Produces: 5 个 prop（新增 `onTocOpen`），并在标题上加点击交互

- [ ] **Step 1: 修改 `ReaderTopBarProps` 接口**

把 `ReaderToolbar.tsx` 第 11-16 行：

```ts
export interface ReaderTopBarProps {
  bookId: string;          // 书籍 ID，用于构建返回详情页的链接
  chapterTitle: string;    // 当前章节标题
  visible: boolean;        // 是否可见
  onSettings: () => void;  // 点击"设置"按钮的回调
}
```

改为：

```ts
export interface ReaderTopBarProps {
  bookId: string;          // 书籍 ID，用于构建返回详情页的链接
  chapterTitle: string;    // 当前章节标题
  visible: boolean;        // 是否可见
  onSettings: () => void;  // 点击"设置"按钮的回调
  onTocOpen: () => void;   // 点击章节标题（触发目录面板）的回调
}
```

- [ ] **Step 2: 修改 `ReaderTopBar` 函数签名**

把 `ReaderToolbar.tsx` 第 18-25 行的函数签名：

```ts
export function ReaderTopBar({
  bookId,
  chapterTitle,
  visible,
  onSettings,
}: ReaderTopBarProps) {
```

改为：

```ts
export function ReaderTopBar({
  bookId,
  chapterTitle,
  visible,
  onSettings,
  onTocOpen,
}: ReaderTopBarProps) {
```

- [ ] **Step 3: 修改标题 `<h1>` JSX**

把 `ReaderToolbar.tsx` 第 47-52 行的标题：

```tsx
<h1
  className="flex-1 truncate font-display text-sm font-medium"
  title={chapterTitle}  // 悬停显示完整标题
>
  {chapterTitle}
</h1>
```

改为：

```tsx
<h1
  onClick={onTocOpen}
  className="flex-1 truncate font-display text-sm font-medium cursor-pointer transition-opacity hover:opacity-70"
  title="点击打开目录"  // 悬停提示可点击
  role="button"
  aria-label="打开目录"
>
  {chapterTitle}
</h1>
```

- [ ] **Step 4: 运行 typecheck**

```powershell
cd E:\Project\epub_project\web
npm run typecheck
```

预期：`tsc -b --noEmit` 通过。注意：此时 `Reader.tsx` 调用 `<ReaderTopBar>` 时还没传 `onTocOpen`，typecheck 会报错——这是预期，下一步修复。

- [ ] **Step 5: 暂存提交（不完整）**

```powershell
cd E:\Project\epub_project
git add web/src/components/ReaderToolbar.tsx
git commit -m "wip(reader-toc): ReaderTopBar onTocOpen prop 加好，下游 Reader.tsx 跟进"
```

> 故意 wip：因为 Reader.tsx 没跟上，TS 会报错。但分两步提交流程更清晰——后续 task 4 完成后会修。

---

## Task 4: Reader.tsx 加 tocOpen state 与 tocJumpRef，并修复 ReaderTopBar 调用

**Files:**
- Modify: `E:\Project\epub_project\web\src\pages\Reader.tsx` — 加 import、加 state、加 ref、加 handleTocSelect、加 JSX 渲染

**Interfaces:**
- Consumes: 现有 `bookQuery.data.chapters`（已排序的 chapters 数组）
- Produces: `tocOpen: boolean` state, `tocJumpRef: useRef<boolean>`, `handleTocSelect(id: string): void`

- [ ] **Step 1: 加 `useRef` 到现有 import**

把 `Reader.tsx` 第 11 行 `import { useEffect, useMemo, useRef, useState } from 'react';`（已经是这行，确认 `useRef` 已引入）。

- [ ] **Step 2: 加 `ReaderTocPanel` 到组件 import**

在 `Reader.tsx` 第 19 行后插入：

```tsx
import { ReaderSettings } from '../components/ReaderSettings';
import { ReaderTocPanel } from '../components/ReaderTocPanel';
```

（如果 import 顺序与项目 ESLint 规则冲突，把 `ReaderTocPanel` 放到 `ReaderSettings` 同级或紧随其后）

- [ ] **Step 3: 加 tocOpen state 和 tocJumpRef**

在 `Reader.tsx` 第 47 行 `const [restored, setRestored] = useState(false);` 之后、`const [liveProgress, setLiveProgress] = useState(0);` 之前插入：

```tsx
  const [tocOpen, setTocOpen] = useState(false);
  const tocJumpRef = useRef(false);
```

- [ ] **Step 4: 加 handleTocSelect 函数**

在 `Reader.tsx` 第 80 行之后（即 `nextHref` 计算后）插入：

```tsx
  // 目录选中某章节：关闭面板 + 标记 toc 跳转 + 导航
  const handleTocSelect = (targetChapterId: string) => {
    tocJumpRef.current = true;
    setTocOpen(false);
    navigate(`/books/${bookId}/chapters/${encodeURIComponent(targetChapterId)}`);
  };
```

- [ ] **Step 5: 在 useEffect 的 rAF 回调里消费 tocJumpRef**

把 `Reader.tsx` 第 90-112 行的 useEffect：

```tsx
  useEffect(() => {
    if (!chapterQuery.data) return; // 内容未加载完，不执行
    const el = scrollRef.current;
    if (!el) return;
    const pct = getChapterProgress(bookId, chapterId); // 从 localStorage 读取进度百分比
    setRestored(false);
    // requestAnimationFrame 等浏览器完成一帧渲染（layout 计算），确保 scrollHeight 准确
    requestAnimationFrame(() => {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight; // 可滚动的最大距离
      if (max > 0 && pct > 0 && pct < 1) {
        // 之前读到中间位置：按百分比还原 scrollTop
        el.scrollTop = Math.round(max * pct);
      } else if (pct >= 1) {
        // 之前已经读完了 — 直接置底
        el.scrollTop = el.scrollHeight;
      }
      setRestored(true);
      // 初始化底栏显示的实时进度值
      const finalMax = el.scrollHeight - el.clientHeight;
      setLiveProgress(finalMax > 0 ? el.scrollTop / finalMax : 0);
    });
  }, [bookId, chapterId, chapterQuery.data]); // 依赖数组：这三个值变化时重新执行
```

改为：

```tsx
  useEffect(() => {
    if (!chapterQuery.data) return; // 内容未加载完，不执行
    const el = scrollRef.current;
    if (!el) return;
    const pct = getChapterProgress(bookId, chapterId); // 从 localStorage 读取进度百分比
    setRestored(false);
    // requestAnimationFrame 等浏览器完成一帧渲染（layout 计算），确保 scrollHeight 准确
    requestAnimationFrame(() => {
      if (!el) return;
      // 目录跳转：强制顶部落地，跳过滚位置恢复
      if (tocJumpRef.current) {
        el.scrollTop = 0;
        tocJumpRef.current = false;
      } else {
        const max = el.scrollHeight - el.clientHeight; // 可滚动的最大距离
        if (max > 0 && pct > 0 && pct < 1) {
          // 之前读到中间位置：按百分比还原 scrollTop
          el.scrollTop = Math.round(max * pct);
        } else if (pct >= 1) {
          // 之前已经读完了 — 直接置底
          el.scrollTop = el.scrollHeight;
        }
      }
      setRestored(true);
      // 初始化底栏显示的实时进度值
      const finalMax = el.scrollHeight - el.clientHeight;
      setLiveProgress(finalMax > 0 ? el.scrollTop / finalMax : 0);
    });
  }, [bookId, chapterId, chapterQuery.data]); // 依赖数组：这三个值变化时重新执行
```

- [ ] **Step 6: 修改 `<ReaderTopBar>` 调用，加 onTocOpen**

把 `Reader.tsx` 第 297-302 行的 `<ReaderTopBar>`：

```tsx
      <ReaderTopBar
        bookId={bookId}
        chapterTitle={chapter.title}
        visible={toolbarVisible}
        onSettings={() => setSettingsOpen(true)}
      />
```

改为：

```tsx
      <ReaderTopBar
        bookId={bookId}
        chapterTitle={chapter.title}
        visible={toolbarVisible}
        onSettings={() => setSettingsOpen(true)}
        onTocOpen={() => setTocOpen(true)}
      />
```

- [ ] **Step 7: 在 `<ReaderSettings>` 前渲染 `<ReaderTocPanel>`**

在 `Reader.tsx` 第 349 行 `<ReaderSettings` 前插入：

```tsx
      <ReaderTocPanel
        open={tocOpen}
        bookId={bookId}
        chapters={sortedChapters}
        currentChapterId={chapterId}
        onClose={() => setTocOpen(false)}
        onChapterSelect={handleTocSelect}
      />
```

（放在 `<ReaderSettings>` 之前或之后都可，render 顺序不影响功能；建议紧贴 `<ReaderSettings>` 让两个 sheet 集中。）

- [ ] **Step 8: 运行 typecheck**

```powershell
cd E:\Project\epub_project\web
npm run typecheck
```

预期：通过。

- [ ] **Step 9: 运行所有 web 测试，确认没有回归**

```powershell
cd E:\Project\epub_project\web
npm test
```

预期：所有原有用例 + 10 个新 ReaderTocPanel 用例都 PASS。如果 `Reader.test.tsx` 失败说明 props 改动未匹配上 —— 检查是否传了 onTocOpen 给 `<ReaderTopBar>`。

- [ ] **Step 10: 提交**

```powershell
cd E:\Project\epub_project
git add web/src/pages/Reader.tsx
git commit -m "feat(reader-toc): Reader 编排 tocOpen/tocJumpRef，渲染 ReaderTocPanel"
```

---

## Task 5: Reader 集成测试：点击标题触发目录

**Files:**
- Modify: `E:\Project\epub_project\web\src\pages\Reader.test.tsx` — 新增 1 个集成用例

**Interfaces:**
- 复用现有 `ReaderHarness` 和 `bookJson` / `chapterJson` mock

- [ ] **Step 1: 在 `describe('ReaderPage')` 块末尾新增用例**

在 `Reader.test.tsx` `describe('ReaderPage')` 块的 `it('点击右上章导航链接会切到下一章 URL', ...)`（第 92-107 行）之后、`afterEach` 之前，插入：

```tsx
  it('点击顶栏章节标题弹出目录面板', async () => {
    const user = userEvent.setup();
    render(<ReaderHarness initialRoute={`/books/${BOOK_ID}/chapters/${CHAPTER_ID}`} />);

    // 等加载完成（顶栏标题出现）
    const titleBtn = await screen.findByRole('button', { name: /打开目录/ });
    await user.click(titleBtn);

    // 目录面板 dialog 出现，且列出 mock 数据中的章节
    const dialog = await screen.findByRole('dialog', { name: '目录' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('第一章')).toBeInTheDocument();
    expect(within(dialog).getByText('第二章')).toBeInTheDocument();
  });
```

并确认文件顶部已 `import { within } from '@testing-library/react';`——如果没有，加上：

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
```

- [ ] **Step 2: 运行该用例**

```powershell
cd E:\Project\epub_project\web
npm test -- src/pages/Reader.test.tsx -t "点击顶栏章节标题弹出目录面板"
```

预期：PASS。

- [ ] **Step 3: 运行全量测试确认无回归**

```powershell
cd E:\Project\epub_project\web
npm test
```

预期：所有用例 PASS（11 个新 + 原有）。

- [ ] **Step 4: 提交**

```powershell
cd E:\Project\epub_project
git add web/src/pages/Reader.test.tsx
git commit -m "test(reader-toc): Reader 集成点击标题弹出目录"
```

---

## Task 6: 端到端手工验证（浏览器）

**Files:** 无（验证步骤）

**Interfaces:** 无

- [ ] **Step 1: 确认后端运行中**

```powershell
curl http://127.0.0.1:8001/api/health
```

预期：返回 `{"status":"ok"}` 或类似。如果 8001 端口无响应，参考项目 README 启动后端。

- [ ] **Step 2: 启动前端 dev server**

```powershell
cd E:\Project\epub_project\web
npm run dev
```

预期：Vite 报告 `Local: http://localhost:5173/`（或其他端口）。保持后台运行。

- [ ] **Step 3: 浏览器验证（按下面 5 步走）**

打开 `http://localhost:5173/`，进入任一本书的阅读器（Library → 任一本书 → 任一章节"继续阅读"）。

依次验证：

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 鼠标移到顶栏章节标题上 | 文字透明度降低（`hover:opacity-70`），鼠标变手型 |
| 2 | 点击章节标题 | 右侧滑出目录面板（桌面 360px，手机 85% 宽） |
| 3 | 面板打开时 | 当前章节位于视区中央，且有金色左边竖线 + 浅背景 |
| 4 | 点击别的章节项 | 面板关闭，跳到该章节顶部，正文滚到顶部（不走上次位置恢复） |
| 5 | 重新进入阅读器，打开目录，按 ESC / 点击遮罩 / 点击 ✕ | 面板关闭 |

- [ ] **Step 4: 关闭 dev server**

如本机独占使用，可保留运行；如非，保持后台无需关。

- [ ] **Step 5: 提交验证记录（可选）**

无文件改动时不需要 commit。如有手动调整才补 commit。

---

## Task 7 (Post-Merge): 顶栏加 ≡ 抽屉图标按钮（discoverability 修复）

**为什么有 Task 7**：初版 plan Task 3 把章节标题本身设计成目录入口（"标题即领航"）。Task 6 浏览器手工验证时用户反馈"第一次用这个系统的人根本不知道这个标题还能点"——属于 discoverability 缺陷。仅靠 hover 降透明度暗示不足以让用户发现可点击区域，需要一个显式的图标按钮作为主要入口。

**设计决策**（与 spec v2 对齐）：
- 顶栏右侧新增 ≡ 三横线抽屉图标按钮，作为**主入口**（aria-label="目录菜单"）
- 章节标题保留作为**冗余入口**（aria-label="打开目录"）
- 两个入口共用同一 `onTocOpen` callback

**为什么 aria-label 不一致**（"目录菜单" vs "打开目录"）：
- 章节标题：描述**动作**（"打开目录"）
- 图标按钮：描述**affordance 本身**（"目录菜单"）
- 同时避免 `findByRole('button', { name: /打开目录/ })` 在集成测中多匹配错

**改动**：

### Modify: `E:\Project\epub_project\web\src\components\ReaderToolbar.tsx`

在 ReaderTopBar JSX 中（"设置"按钮**之前**）插入 ≡ 按钮：

```tsx
{/* 目录按钮（抽屉图标）——显式入口，弥补标题可点击的 discoverability 不足 */}
<button
  type="button"
  onClick={onTocOpen}
  className="shrink-0 p-2 rounded-md hover:bg-black/5"
  aria-label="目录菜单"
  title="目录"
>
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
</button>
```

章节标题 `<h1>` 不动（仍可点击触发同一 callback）。

**Steps**:

1. 在 ReaderTopBar JSX 中"设置"按钮之前插入上述 SVG 按钮
2. 跑 `npm run typecheck` 验证通过
3. 跑 `npm test` 验证 28/28 PASS（不要新增测试；既有"点击标题"用例覆盖同 callback）
4. 提交：`git commit -m "fix(reader-toc): 顶栏加 ≡ 抽屉图标按钮，弥补标题 discoverability"`

**未决项（待 follow-up）**：
- 顶栏 hover 显示机制（`toolbarVisible=false` 时 opacity-0）让 ≡ 按钮首次进入时不可见——需滚动/点击中央才能显示。M4 已记录在 final review。
- 集成测可考虑补充"点击 ≡ 按钮"路径验证（独立于"点击标题"路径）。

---

## Self-Review

**1. Spec 覆盖：**
- 顶栏章节标题改为可点击入口 ✅ Task 3 + Task 4.6
- 目录面板为右侧滑入 sheet（响应式宽度） ✅ Task 2
- 列表项：序号 + 标题；当前章节金色左竖线 ✅ Task 2
- 打开时自动滚动到当前章节项（视区中央） ✅ Task 2
- 点击遮罩或 ✕ 关闭；ESC 也关闭 ✅ Task 2
- 点击目录项 → 关闭 + 跳转 + 顶部落地 ✅ Task 4.5
- 10 个 ReaderTocPanel 单测 + 1 个 Reader 集成测 ✅ Task 1 + Task 5

**2. 占位符扫描：** 无 TBD/TODO/留待实现。Task 2 Step 2-3 提示了"如果 ESLint 报 unused，删除 useNavigate"——这是条件分支不是占位符。

**3. 类型一致性：**
- `ReaderTocPanel` props：`open`, `onClose`, `bookId`, `chapters`, `currentChapterId`, `onChapterSelect` 在 Task 1 测试 + Task 2 实现 + Task 4 调用三处一致 ✅
- `ReaderTopBar` props：5 个 prop 在 Task 3 定义 + Task 4 调用一致 ✅
- `handleTocSelect(id: string)`：Task 4 定义 + Task 4 调用 + Task 5 集成测期望值一致 ✅

**无发现问题，无需修订。**