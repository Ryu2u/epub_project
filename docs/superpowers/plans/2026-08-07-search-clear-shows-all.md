# 搜索清空时回到全库列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主页搜索框被清空(包括浏览器原生 X 按钮)时,列表立即回到全库第一页。

**Architecture:** 在 `Library.tsx` 搜索 input 的 `onChange` 中,当新值为空字符串时同步把 `submitted` 设为空并把 `page` 重置为 1。回车提交逻辑保持不变。浏览器原生 X 按钮与键盘删除共用同一个 React `change` 事件链,因此行为统一。

**Tech Stack:** React 18 + TypeScript + TanStack Query(via `useBooks`)+ Vitest + Testing Library。

## Global Constraints

- 仅改动 `web/src/pages/Library.tsx` 与 `web/src/pages/Library.test.tsx`。
- 不引入新依赖、不改后端 API、不改 `useBooks` hook。
- 现有三个 Library 测试必须保持通过。
- 遵循既有提交格式:`<type>(<scope>): <summary>`,Co-Authored-By 行保留。

---

### Task 1: 添加"清空输入框回到全库"测试

**Files:**
- Modify: `web/src/pages/Library.test.tsx`(在 `describe('LibraryPage', ...)` 内、最后一个 `it` 之后追加一个新的 `it`)

**Interfaces:**
- Consumes: 现有 `renderWithProviders` helper,`LibraryPage` 组件。
- Produces: 一个名为 `'清空输入框时回到全库'` 的测试用例,作为 Task 2 实现后必须通过的验收条件。

- [ ] **Step 1: 打开 `web/src/pages/Library.test.tsx`,在文件末尾(`describe` 闭合 `});` 前)添加以下测试**

```tsx
  it('清空输入框时回到全库', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, page: 1, size: 20 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LibraryPage />);

    const search = screen.getByPlaceholderText(/搜索/);

    // 1) 输入并回车,产生一次带 q 参数的请求
    await user.type(search, 'epub');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((url) => url.includes('q=epub'))).toBe(true);
    });

    // 2) 清空输入(覆盖 X 按钮 / Ctrl+A + Del / 键盘删除等多条路径)
    await user.clear(search);

    // 3) 应触发新请求,URL 中不再带 q 参数
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      const latest = urls[urls.length - 1];
      expect(latest).not.toMatch(/[?&]q=/);
    });
  });
```

插入位置:定位文件中 `it('搜索框触发查询', ...) { ... });` 这一整段结束的 `});` 之后、紧跟的 `});`(关闭 `describe` 的)之前。

- [ ] **Step 2: 运行测试,确认它在实现前失败**

```bash
cd web && corepack pnpm test src/pages/Library.test.tsx -t "清空输入框时回到全库"
```

Expected: 测试 FAIL,提示 fetch URL 仍含 `q=epub`(因为当前实现不会因 `user.clear` 清空 `submitted`)。

- [ ] **Step 3: 不写实现代码,只提交测试骨架**

```bash
cd web && git add src/pages/Library.test.tsx
git commit -m "test(library): 添加清空搜索回到全库的失败测试"
```

(此时 test 应当是红的;提交只为了把 TDD 的红锁到 git 上,后续 Task 2 让它转绿。)

---

### Task 2: 在 `Library.tsx` 中实现清空同步逻辑

**Files:**
- Modify: `web/src/pages/Library.tsx`(改搜索 `<input>` 的 `onChange` 回调,行 67 附近)

**Interfaces:**
- Consumes: 当前 `q`、`submitted`、`page` 三个 state(`useState`)。
- Produces: 输入框 `onChange` 处理函数,在 `next === ''` 时调用 `setSubmitted('')` 与 `setPage(1)`,其余情况只 `setQ(next)`。

- [ ] **Step 1: 改写 `onChange`**

定位 `web/src/pages/Library.tsx` 第 67 行:

```tsx
              onChange={(e) => setQ(e.target.value)}
```

替换为:

```tsx
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                if (next === '') {
                  setSubmitted('');
                  setPage(1);
                }
              }}
```

- [ ] **Step 2: 跑整个 Library 测试文件,确认全部通过**

```bash
cd web && corepack pnpm test src/pages/Library.test.tsx
```

Expected: 4 个 `it` 全部 PASS(原 3 个 + Task 1 新增 1 个)。

- [ ] **Step 3: 跑 web 类型检查 / 构建,确认无类型回归**

```bash
cd web && corepack pnpm build
```

Expected: 构建成功,无 TypeScript 错误。

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/Library.tsx
git commit -m "feat(library): 清空搜索框时同步清 submitted 回到全库"
```

---

### Task 3: 手动端到端验证(可选,但推荐)

**Files:** 无。

- [ ] **Step 1: 确认前后端已运行;若未运行,执行**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

等待 `backend=200 frontend=200`。

- [ ] **Step 2: 浏览器访问 `http://localhost:3000`,操作如下并肉眼确认:**

1. 在搜索框输入"epub" → 按回车 → 列表过滤(可能为空)。
2. 点击搜索框右侧浏览器原生 X 按钮 → 列表立刻恢复全库。
3. 再次输入"xxx" → 按回车 → 改用键盘逐字删除,列表同样恢复全库。
4. 翻到第 3 页 → 搜索 → 清空 → 确认 page 回到第 1。

- [ ] **Step 3: 若一切正常,无需提交;若发现新问题,创建后续 issue 跟踪。**