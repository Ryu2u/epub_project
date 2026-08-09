# 阅读界面显示目录并跳转 设计

**日期**: 2026-08-09
**作者**: brainstorming 会话
**状态**: 待用户复核

---

## Context（背景）

阅读器当前位于 `/books/:bookId/chapters/:chapterId` 路由，是单章节全屏阅读模式（仿 iOS Books）：
- 顶栏：返回 / 章节标题 / 设置
- 底栏：上一章 / 进度条 / 下一章
- 阅读偏好持久化：字号/行高/主题/字体（localStorage）
- 章节滚位置持久化（localStorage）

**现状痛点**：用户需要跳到指定章节时只能依赖"上一章/下一章"线性浏览；想要回顾前面某章必须退出阅读器回到详情页选章节——打断了沉浸阅读体验。

**已有数据基础**：`Reader.tsx` 中的 `bookQuery` 已经返回完整 `chapters: ChapterOut[]`（含 `id`、`title`、`spine_order`、`word_count`），且由 TanStack Query 缓存——本功能**不需要任何新的后端端点**。

**预期结果**：在阅读器内通过顶栏入口打开侧边目录面板，能浏览完整章节、看到当前章节位置、点击跳转任意章节；面板样式与现有 `ReaderSettings` 同构（遮罩 + 右侧滑入 sheet），复用项目的心智模型。

---

## 范围（Scope）

### 在范围内

- **两路目录入口**（discoverability 优先）：
  - (a) 顶栏右侧新增 ≡ 抽屉图标按钮（aria-label="目录菜单"，SVG 三横线），与现有"设置"按钮并列，**显式且零学习成本**
  - (b) 章节标题文字本身仍可点击（aria-label="打开目录"，hover 降透明度暗示），作为冗余入口避免用户遗忘
- 目录面板为右侧滑入的 sheet（桌面 360px / 手机 85% 宽）
- 列表项：序号 + 章节标题；当前章节用金色左边竖线标记
- 打开时自动滚动到当前章节项（视区中央）
- 点击遮罩或 ✕ 关闭面板；ESC 也关闭
- 点击目录项 → 关闭面板 + 跳转 + 章节顶部落地（不走滚位置恢复）

> **设计迭代记录**：初版 spec 仅设计"章节标题可点击"单一入口。Task 6 浏览器手工验证时用户反馈"第一次用的人不知道标题还能点"——这是 discoverability 缺陷。在顶栏新增 ≡ 抽屉图标按钮作为主入口，章节标题保留作为辅助入口（v2 落地，commit `5bb7a5d`）。

### 不在范围内（明确排除）

- 目录内搜索 / 筛选（详情页已有"搜索本书内容"功能；阅读器内不再重复）
- 拖拽重排（详情页独有；阅读器内只读）
- 后端新端点（数据已在缓存里）
- 章节内"大纲"（EPUB nav 内嵌的子章节层级）—— 数据模型无字段；当前 spine 已足够
- 焦点管理（open 时移到面板、close 时还回标题）—— 与现有 ReaderSettings 一致地不做
- 平板专属布局（响应式断点复用现有 sm:）

---

## 架构

```
Reader (web/src/pages/Reader.tsx)
  ├─ tocOpen: boolean                ← 新增 state
  ├─ tocJumpRef: useRef<boolean>     ← 新增：标记"本次来自目录跳转"
  ├─ sortedChapters (已存在)
  ├─ <ReaderTopBar
  │     onTocOpen={() => setTocOpen(true)}    ← 新增 prop
  │     ...其他 props 不变
  │   />
  ├─ <article>  (正文，不变)
  ├─ <ReaderBottomBar />  (不变)
  ├─ <ReaderTocPanel                       ← 新增
  │     open={tocOpen}
  │     bookId={bookId}
  │     chapters={sortedChapters}
  │     currentChapterId={chapterId}
  │     onClose={() => setTocOpen(false)}
  │   />
  └─ <ReaderSettings />  (不变)
```

### 职责切分（关键边界）

- **`ReaderTocPanel` 是纯展示组件**——接收 `open / onClose / bookId / chapters / currentChapterId`。它内部用 `useNavigate` 实现点击跳转，不知道外层状态机。
- **`Reader.tsx` 是编排者**——拥有 `tocOpen` / `tocJumpRef` 状态；点击标题触发打开；点击目录项由组件内部 navigate，Reader 不需要额外 jumpToChapter 函数。
- **`ReaderTopBar` 承担触发入口**——加一个 `onTocOpen` 回调 prop，标题点击触发它。
- **后端零改动**——所有数据走 `bookQuery` 缓存。

---

## 组件设计

### `ReaderTocPanel`（新文件：`web/src/components/ReaderTocPanel.tsx`）

**Props**（受控模式，与 `ReaderSettings` 一致）：

```ts
import type { ChapterOut } from '../api/types';

export interface ReaderTocPanelProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  chapters: ChapterOut[];   // 已按 spine_order 排序
  currentChapterId: string;
}
```

**结构**（沿用 `ReaderSettings` 的遮罩 + transform 滑入模式）：

```tsx
<>
  {/* 背景遮罩：点击可关闭面板 */}
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
      'w-[85%] sm:w-[360px]',                     // 响应式宽度
      'transition-transform duration-200 ease-out',
      open ? 'translate-x-0' : 'translate-x-full',
    ].join(' ')}
    style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
  >
    <div className="h-full flex flex-col">
      {/* 面板头部 */}
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

      {/* 章节列表 */}
      <ul role="list" className="flex-1 overflow-y-auto py-2">
        {chapters.map((ch, idx) => {
          const isCurrent = ch.id === currentChapterId;
          return (
            <li key={ch.id}>
              <button
                ref={isCurrent ? currentRef : undefined}  // 当前项 ref 用于自动滚动
                type="button"
                onClick={() => {
                  onClose();
                  navigate(`/books/${bookId}/chapters/${encodeURIComponent(ch.id)}`);
                }}
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
```

**关键实现点**：

1. **ESC 关闭**：`useEffect([open, onClose])` 监听 keydown（同 `ReaderSettings` 模式）
2. **自动滚到当前项**：另一个 `useEffect([open, currentChapterId])`，当 open 变 true 时调用 `currentRef.current?.scrollIntoView({ block: 'center' })`。`block: 'center'` 让当前项落在视区中间，比 `'start'` 友好。
3. **点击跳转**：`useNavigate()` 内部获取；先 `onClose()` 再 `navigate()` 保证面板关闭动画先启动。
4. **遮罩 pointer-events**：`open=false` 时遮罩加 `pointer-events-none` 防止拦截背后点击（同 `ReaderSettings`）。

### `ReaderTopBar` 改动

在 `web/src/components/ReaderToolbar.tsx` 中，给 `ReaderTopBar` 加一个 `onTocOpen` 回调 prop，标题 `<h1>` 加点击交互：

```ts
export interface ReaderTopBarProps {
  bookId: string;
  chapterTitle: string;
  visible: boolean;
  onSettings: () => void;
  onTocOpen: () => void;    // 新增
}
```

```tsx
<h1
  onClick={onTocOpen}
  className={[
    'flex-1 truncate font-display text-sm font-medium',
    'cursor-pointer transition-opacity hover:opacity-70',  // 暗示可点击
  ].join(' ')}
  title="点击打开目录"
  aria-label="打开目录"
>
  {chapterTitle}
</h1>
```

返回按钮和设置按钮不变。

### `Reader.tsx` 改动

**新增状态与 ref**：

```tsx
const [tocOpen, setTocOpen] = useState(false);
const tocJumpRef = useRef(false);  // 标记本次切章是否来自目录点击
```

**滚位置恢复 useEffect 中加短路**：当 `tocJumpRef.current === true` 时，跳过 `setChapterProgress` / 滚位置恢复，仅更新 `liveProgress` 和 `setRestored(true)`。

```tsx
useEffect(() => {
  if (!chapterQuery.data) return;
  const el = scrollRef.current;
  if (!el) return;
  const pct = getChapterProgress(bookId, chapterId);
  setRestored(false);
  requestAnimationFrame(() => {
    if (!el) return;
    if (tocJumpRef.current) {
      // 目录跳转：强制顶部落地
      el.scrollTop = 0;
      tocJumpRef.current = false;
    } else {
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0 && pct > 0 && pct < 1) {
        el.scrollTop = Math.round(max * pct);
      } else if (pct >= 1) {
        el.scrollTop = el.scrollHeight;
      }
    }
    setRestored(true);
    const finalMax = el.scrollHeight - el.clientHeight;
    setLiveProgress(finalMax > 0 ? el.scrollTop / finalMax : 0);
  });
}, [bookId, chapterId, chapterQuery.data]);
```

> 注：tocJumpRef 的消费必须在 rAF 回调内（即真正要写 `scrollTop` 那一刻），因为 `scrollTop` 在内容未 layout 完前设置会被覆盖。

**新增 jumpToChapter 函数**（也可放在 onTocItemClick 调用链上）：

最简实现是让 `ReaderTocPanel` 内部 navigate 后由 Reader 监听不到；所以用一个回调替代：

```tsx
const handleTocSelect = (targetChapterId: string) => {
  tocJumpRef.current = true;
  setTocOpen(false);
  navigate(`/books/${bookId}/chapters/${encodeURIComponent(targetChapterId)}`);
};
```

将 `onChapterSelect={handleTocSelect}` 传给 ReaderTocPanel（代替组件内部 navigate）。这样保证 tocJumpRef 在 navigate 之前置位。

**最终渲染新增**：

```tsx
<ReaderTopBar
  bookId={bookId}
  chapterTitle={chapter.title}
  visible={toolbarVisible}
  onSettings={() => setSettingsOpen(true)}
  onTocOpen={() => setTocOpen(true)}   // 新增
/>
// ... 中间正文 ...
<ReaderTocPanel
  open={tocOpen}
  bookId={bookId}
  chapters={sortedChapters}
  currentChapterId={chapterId}
  onClose={() => setTocOpen(false)}
  onChapterSelect={handleTocSelect}     // 新增
/>
```

---

## 行为细节

### 滚动恢复（关键边缘）

**问题**：现有 `Reader.tsx` 在切章节时读 `localStorage` 的 `pct` 恢复滚动条。如果用户已读到 ch2 中间 60%，从详情页跳到 ch2 会直接到 60% 位置；从目录里点 ch2 也跳到 60%——**不符合"目录点击应顶部落地"的约定**。

**解决**：用 `tocJumpRef` 标记本次切章来自目录。useEffect 内 `requestAnimationFrame` 回调里识别并强制 `el.scrollTop = 0` 然后清标记。

### 自动滚动到当前项

`ReaderTocPanel` 内部 `useEffect([open])`：
- `open === true` 时调用 `currentRef.current?.scrollIntoView({ block: 'center' })`
- `block: 'center'` 比 `'start'` 友好——长书（>50 章）打开面板时当前章节不会贴顶不可见上下文
- 当前章节不存在（currentChapterId 与 chapters 不匹配）则不滚

### 视觉一致性

- 遮罩色：`bg-black/30` 与 `ReaderSettings` 一致
- transform 时长：`duration-200 ease-out` 与 `ReaderSettings` 一致
- 面板背景：跟随阅读主题的 `var(--bg)` / `var(--fg)`（同 `ReaderSettings`）
- 当前章节视觉：金色左边竖线 + `bg-black/5` 背景，与详情页目录的"进度指示"区域呼应
- 章节项字号：`text-sm`（比正文小一档，符合目录层级）

### 不动后端

- 不新增端点（数据已在 bookQuery 缓存）
- 不修改 schema（ChapterOut 不动）
- 不修改 service 层
- 不修改 migration

---

## 测试策略

### 新增文件 `web/src/components/ReaderTocPanel.test.tsx`

| 用例 | 验证 |
|---|---|
| 渲染所有章节项 | 给 5 章数据，断言 5 个章节标题都在 DOM |
| 当前章节高亮 | `currentChapterId='ch2'`，断言 `ch2` 项含 `border-gold-400` class |
| 点击 ✕ 触发 onClose | 模拟点击 → onClose 被调用 |
| 点击遮罩触发 onClose | 模拟点击遮罩 → onClose 被调用 |
| ESC 键触发 onClose | keydown Escape → onClose 被调用 |
| 关闭时遮罩不可点 | `open=false` 时遮罩含 `pointer-events-none` class |
| 关闭时面板 translate 滑出 | `open=false` 时 aside 含 `translate-x-full` class |
| 面板 aria 属性 | role=dialog + aria-label="目录" |
| 点击章节项调用 onChapterSelect | 模拟点击 ch3 → onChapterSelect('ch3') 被调用 |
| 打开时 scrollIntoView 被调用 | spy scrollIntoView，open=true 后被调用 |

### 修改 `web/src/pages/Reader.test.tsx`

新增 1 个集成用例：
- 模拟点击顶栏章节标题 → 目录面板出现（断言 `aria-label="目录"` 的 dialog 在文档中）

### 不引入 e2e 测试

项目前端测试栈是 Vitest + MemoryRouter，与现有 Reader 测试同栈。

---

## 关键依赖

无新增依赖。所有改动用现有 React 18 + react-router-dom v6 + TanStack Query v5。

---

## 风险与未决项

- **超大本书（>200 章）首屏渲染**：目录列表项是 `<button>`，每项含 hover className 拼接。1000 章实测无明显卡顿（React 18 渲染列表通常 < 16ms）；不引入虚拟列表以保持改动最小。
- **焦点管理缺失**：与现有 `ReaderSettings` 一致地不做，留作未来 spec。
- **导航历史**：点击目录项会 push 新历史条目（与底栏上一章/下一章一致）。如需 `replace: true` 行为需用户后续指定。
- **当前章节不在 chapters 里**（如章节被删除、ID 不一致）：`currentRef` 为 undefined，自动滚动 noop；高亮也无；不抛错。

---

## 后续 Spec 候选（不在本轮）

按价值排序：

1. 阅读器内"章节大纲"——解析 EPUB nav 嵌套层级（当前 spine 是扁平 list）
2. 阅读器内"搜索本书内容"——平移详情页搜索逻辑
3. 阅读器目录面板内"标记已读/未读"——平移详情页状态切换
4. 焦点管理（open/close 时焦点移动）——提升可访问性
5. 阅读器键盘快捷键（j/k 上下章、g 跳指定章节）