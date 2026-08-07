# 搜索清空时回到全库列表 — 设计

**日期:** 2026-08-07
**状态:** Approved

## 背景

`web/src/pages/Library.tsx` 中的搜索框使用受控输入,并以"用户回车"作为提交触发:

- `q` — 受控的输入框当前值
- `submitted` — 用户按回车后真正用于查询的搜索词

点击浏览器原生 X 按钮(`<input type="search">` 自带)只会把 `q` 清空,但 `submitted` 不会变,导致:

- 列表仍以 `submitted` 为关键词向后端请求
- 结果区停留在"过滤后"的子集或"未寻得此卷"空状态
- 用户期望"清空 = 回到全库"的行为不成立

## 目标

`q` 一旦变成空字符串,立刻把 `submitted` 同步为空并回到第 1 页,使列表回到全库视图。适用于:

- 浏览器原生 X 按钮清空
- 键盘删除键逐字清空
- `Ctrl/⌘ + A` 后删除
- 粘贴覆盖为空

## 非目标

- 不改造搜索框为自定义 X 按钮
- 不修改后端 API
- 不改 `useBooks` hook
- 不引入防抖 / 自动提交
- 不改回车提交逻辑

## 设计

### 行为

修改 `Library.tsx` 中搜索 `<input>` 的 `onChange`,在用户清空 `q` 时同步把 `submitted` 也清空并回到第 1 页。回车提交(`onSubmit`)的逻辑保持不变 — 仍由用户决定何时把当前 `q` "提交"为搜索词;只是 `q` 已为空时该提交等于空查询。

### 代码改动

`web/src/pages/Library.tsx`,搜索 input 的 `onChange`:

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

### 数据流

1. 用户清空输入 → 触发 `change` 事件 → onChange 设置 `q = ''`
2. onChange 检测到空值 → 设置 `submitted = ''`、`page = 1`
3. `useBooks(submitted, page, PAGE_SIZE)` 因 `submitted` 变化触发新查询 → 后端 `q=&page=1` 返回全库首页

### 浏览器 X 按钮路径

`<input type="search">` 的原生 X 按钮触发的是同一个 `input` 事件链(onChange 走 React 的 SyntheticEvent),因此复用同一处理函数。

### 错误处理

无需新增错误路径;空 `q` 查询是后端已支持的合法状态。

### 测试

`web/src/pages/Library.test.tsx` 新增一个测试用例:

```
it('点击原生 X 按钮清空搜索,回到全库')
```

步骤:

1. 输入 `epub` 并按回车 → 验证 fetch URL 中含 `q=epub`
2. 通过 `userEvent.clear(searchInput)` 触发清空(X 与键盘删除走同一 React 事件)
3. 等待 fetch 重新调用
4. 验证最新一次 fetch URL 不含 `q=` 参数

现有三个测试保持不动。

## 风险与回退

- **风险:** 若产品方希望 X 与键盘删除行为不同,此实现将两者合并。回退:把 onChange 中的清空分支挪到一个由按钮 onClick 显式触发的函数里。
- **风险:** 同步清 submitted 会增加一次请求。`useBooks` 启用 TanStack Query 缓存 + 30s staleTime,影响极小。

## 验证

- `pnpm test web/src/pages/Library.test.tsx` 通过(原 3 个 + 新增 1 个)
- `pnpm build` 通过
- 手动验证:启动前后端,搜索"epub" → 点 X → 看到"共 N 册"统计与全库一致