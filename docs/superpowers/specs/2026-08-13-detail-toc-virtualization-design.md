# Detail 页章节目录虚拟化设计 Spec

- 状态：待审
- 日期：2026-08-13
- 关联：详情页详情接口 `/api/books/:id` 返回 2000+ 章节时浏览器卡顿（点击"编辑"按钮后鼠标卡顿）

## 1. 问题

`/books/:id` 详情页对 2000+ 章书籍（如 c55b95e4481b42098ddf676ed3c65cdc，2264 章）有以下症状：

- 点击顶栏"编辑"按钮后整个页面卡顿，鼠标 hover 也卡
- headless Chrome 测量 reflow 10× 仅 14ms、2264 个 dragover 21ms，无 long task → **卡顿不在 JS**
- 真机卡顿源于浏览器 paint/composite + 2264 个常驻 DOM `<li>` + 2264 个 `draggable=true` 的协同成本

根因量化：

| 指标 | 数值 | 来源 |
|---|---|---|
| 章节数 | 2264 | GET /api/books/{id} 响应 |
| 总 DOM 节点 | 15,919 | headless Chrome 测量 |
| `transition-all` li 元素 | 2264 | `<li class="rounded-md transition-all">` |
| `draggable=true` li（edit 模式） | 2264 | `draggable={editMode}` |
| 每个 li 子元素 | 6~7 个（手柄/序号/标题/进度/编辑链接/词数） | Detail.tsx:435-527 |
| React 切换 editMode 时每项变化 | Link→button + 新增 draggable + 新增 2 子元素 | 全量重 reconcile |
| 每次渲染读 localStorage（getChapterProgress） | 2264 次同步 JSON.parse | useReaderProgress.ts:59-62 |
| 2264 个 li 的 outerHTML 总字节 | 1,818,782 B（≈ 1.8 MB） | headless 测量 |

## 2. 目标

- 详情页章节目录区域在 1~10,000 章规模下保持 60fps 交互
- "编辑"模式切换瞬时无感
- 不破坏现有交互：编辑标题、保存、拖拽重排、点击进入阅读、进度显示
- 保留 `<ol>/<li>` 语义，辅助技术/SEO 友好
- 不增加后端负担（前端方案）

## 3. 非目标

- 不重写后端分页接口（API 形态不变；2264 章后端 55ms 返 256KB 没问题）
- 不引入新的搜索/筛选交互（搜索走现有 useBookSearch 流程）
- 不改拖拽重排的交互语义（仍按原 DnD 流程；仅是 DOM 数量减少）

## 4. 方案选型

候选：react-window v1.8.11 / react-virtuoso / @tanstack/react-virtual

| 项 | react-window@1.8.11 | react-virtuoso | @tanstack/react-virtual |
|---|---|---|---|
| 固定行高场景性能 | 最佳 | 中（测量有开销） | 最佳 |
| 保留 `<ol>` 语义 | `outerElementType="ol"` 直接支持 | 用 components 包装 | 自己写 |
| Bundle（gz） | ~2KB | ~12KB | ~3KB |
| 学习曲线 | 低 | 中 | 中 |
| 拖拽 reorder 友好度 | `itemKey=ch.id` 直解 | 需自己实现 | 需自己实现 |

**选择 react-window@1.8.11** —— 章节行高固定（仅"编辑"模式多 1 个拖拽手柄，行高不变），且 `outerElementType="ol"` 一行保留语义。

> 注意：pin v1.8.11 而非 v2.x。v2 是完全重写（无 `FixedSizeList`/`itemData`/`outerElementType`），与现有 pattern 不兼容。

## 5. 设计

### 5.1 提取 ChapterRow 组件

把 Detail.tsx:435-527 的 `<li>...</li>` 提取为独立 `ChapterRow` 组件：

- props：`chapter`, `index`, `bookId`, `editMode`, `editingChapterId`, `dragIdx`, `overIdx`, `onStartEdit`, `onDragStart`, `onDragOver`, `onDrop`, `onDragEnd`, `progress`
- 内部用 `React.memo` 包裹，避免非必要时重渲染
- 行高固定 44px（与现有 `py-2` + `text-sm` 一致）

### 5.2 引入 FixedSizeList

- 包：`<FixedSizeList height={listHeight} width="100%" itemSize={44} itemCount={chapters.length} itemData={data} itemKey={keyFn} outerElementType="ol">`
- `outerElementType="ol"` → 库渲染 `<ol>` 作为外层
- 每行渲染 `<li style={style} className="...">`（**必须 spread style**，否则 absolute positioning 失效）
- `listHeight`：用 ResizeObserver 测右侧 `<section>` 的可视高度（当前 md:overflow-y-auto 区域）。先 fallback 到 600px 避免 SSR 闪烁。
- `itemSize=44`：与 read mode 现有 `py-2` 视觉高度一致；edit mode 多手柄但仍 44px 容纳

### 5.3 状态和 handler 提升

- 所有 handler（`onStartEdit`/`onDragStart`/`onDragOver`/`onDrop`/`onDragEnd`/`onSaveTitle`）继续留在 DetailPage 顶层（用 useCallback 稳定引用）
- 通过 `itemData` 传给行：`{ chapters, bookId, editMode, editingChapterId, dragIdx, overIdx, progressMap, handlers... }`
- `itemData` 用 `useMemo` 避免每次渲染重建对象
- `itemKey` 用 `useCallback((index) => chapters[index].id, [chapters])` —— 关键：拖拽时 index 变化但 React 仍按 id 找节点

### 5.4 解决 React.memo + handlers 引用问题

- `progressMap`：在 DetailPage 顶层 `useMemo` 一次性 `readProgressMap(bookId)`，传给每行 `data.progressMap[ch.id]`
- **关键性能修复**：`getChapterProgress` 不再在每章渲染时 JSON.parse。2264 次 → 1 次

### 5.5 拖拽 DnD 仍然可用

- `draggable={editMode}` 继续生效（写在 `<li>` 上）
- 但只有视口内 ~30 个 li 是 draggable；浏览器 hit-test 范围从 2264 缩到 ~30
- `onDragOver` 仍按 index 处理；DnD 协议本身不感知虚拟化
- 边界：拖动中快速滚动到列表外时，库不重新挂载已拖离的 li（dragstart 后无重渲染触发），安全

### 5.6 进度百分比显示

- 现：`<span>{progressPct}%</span>` 当 `0 < progress < 1`
- 改：直接读 `progressMap[ch.id]`，无变化
- 仍走 useReaderProgress 同步读取，但仅一次

### 5.7 搜索结果不受影响

- 搜索时切到 `SearchResults`（Detail.tsx:417），不走虚拟化（结果数小）
- 退出搜索回到目录 → 重新挂载 FixedSizeList，cheap

## 6. 兼容性 & 风险

| 风险 | 缓解 |
|---|---|
| 浏览器原生 `find in page` 跳不到虚拟化外的章节 | 用户报告里没要求；不在范围内 |
| 拖拽到 list 边界时 DnD 失焦 | 当前无此 UX；保留 |
| 屏幕阅读器对虚拟列表的 announce | v1 + `<ol>` 仍是语义化结构；章节数 ARIA 提示可后续 |
| react-window v1 已冻结（2024-12）| pin 1.8.11；未来若需要换 v2 重写列表（范围可控） |
| 章节标题极长（多行）被 44px 截断 | 现版同样截断（`truncate`）；保持 |

## 7. 验收

- 打开 `/books/c55b95e4481b42098ddf676ed3c65cdc` 页面首次加载 ≤ 500ms 完成（不卡）
- 点击顶栏"编辑" 切换 ≤ 100ms 完成（真机无感知）
- 编辑模式下拖动章节快速滚动：流畅
- 2264 章时总 DOM 节点从 15,919 降到 ~1500（数量级改善）
- 现有 Detail.test.tsx / Library.test.tsx / Reader.test.tsx 全部通过
- 新增 ChapterRow 组件单测：memo 行不变时引用相等
- 新增 FixedSizeList 集成测：editMode 切换后视口内 li draggable=true

## 8. 实施拆分（待 plan 阶段细化）

1. 安装 react-window@1.8.11
2. 提取 ChapterRow + 进度 map 优化
3. 替换 Detail.tsx 的 `<ol>` 块为 FixedSizeList
4. 补单测 + 集成测
5. 真机回归
