# AGENTS.md（src —— 前端细则）

**根目录的 `AGENTS.md` 仍然是总规则,始终优先适用。本文件只补充 `src/` 目录下的细则。**

存在形式是**增量**:这里的每一条都是根文件的细化,不是根文件的替代。通用规则(安全、数据、Git、虚假验证等)此处不重复。

> 本文件只在 Agent 工作到 `src/` 时被加载(Claude Code 惰性加载;Codex 需从本目录启动才会读到)。
> 因此**不要把任何「漏掉会出事」的规则只写在这里** —— 那些必须写在根文件。
>
> 注意:`vite.config.ts`、`tsconfig.json`、`package.json`、`index.html` 都在**仓库根**,不在本目录。
> 与它们相关的规则(端口、编译目标、TS 严格项)因此写在**根 `AGENTS.md`**,不在这里。

---

## 1. 目录布局

```
src/
  App.tsx          路由表 + QueryClient + 错误边界
  api/             唯一的 API 层
    client.ts      双模式(浏览器 HTTP / Tauri invoke)
    types.ts       与后端 schema 镜像的 TS 类型
  components/      通用组件
  hooks/           useBooks / useReaderProgress / useReaderSettings
  lib/             工具库(readerPrefs、appTheme、formatFileSize、locateText…)
  pages/           页面组件(Library / Detail / Reader / ChapterEditor / Upload)
  reader/paged/    分页阅读引擎,对外只暴露 index.ts
  test-setup.ts    测试环境全局配置
```

## 2. API 层是双模式的

`src/api/client.ts` 检测 `window.__TAURI_INTERNALS__`:

- **Tauri 环境** → invoke 到对应的 `#[tauri::command]`
- **浏览器环境** → `fetch /api/*`

新增后端能力时,**两个分支都要补**,并保持对外函数签名一致,这样页面组件零改动。错误形状两端一致(`{ code, message, existing_book_id? }` → `ApiClientError`)。

Rust 侧对应命令的注册要求见 `src-tauri/AGENTS.md`。

## 3. 错误处理的一个有意设计

「尽力而为」的操作要**显式吞掉异常并写明理由**,而不是让它冒泡成失败。

例:`client.ts` 的 `openContainingFolder` —— 导出完成后打开所在目录,失败了只是少一个便利动作,**不应该影响「导出已成功」这个结论**。这是有意为之,不要「顺手修正」成抛错。

## 4. 测试环境(改动前必读 `src/test-setup.ts`)

前端测试是 vitest + jsdom,配置内嵌在**根目录**的 `vite.config.ts`,`setupFiles` 指向本目录的 `test-setup.ts`。

`test-setup.ts` 里有三处**看着像样板、实则修了真实问题**的东西,删掉或「简化」会导致大规模误报失败:

| 代码 | 修的是什么 |
|---|---|
| `restoreStorage('localStorage' / 'sessionStorage')` | **Node ≥ 22 自带原生 storage 全局(默认未初始化,读值为 `undefined`)会遮蔽 jsdom 的实现**,导致裸用 `localStorage` 的测试全部拿到 `undefined` |
| `configure({ asyncUtilTimeout: 4000 })` | 全量并行时分页测量 + 翻页动画较慢,用默认 1s 会偶发超时 |
| `ResizeObserver` / `window.scrollTo` 桩 | jsdom 未实现,Detail 页测量目录高度会报错/出噪音 |

**不要在测试里绕过它们**,也不要把它们当成可以清理的样板代码。

## 5. 性能现状(描述勿扩大)

- **详情页**的章节列表与目录用 `react-window` 虚拟滚动 —— 全仓**唯一**的 `FixedSizeList` 在 `src/pages/Detail.tsx`
- 分页引擎采用 layout-then-slice 与邻章预取

> ⚠️ **阅读器的目录面板 `src/components/ReaderTocPanel.tsx` 没有虚拟化。**
> 若任务涉及「阅读页长目录卡顿」,那是**真实瓶颈**,不要因为「本仓库已有性能设计」就判断那块不是你该动的地方。

## 6. 主页移除后的遗留状态(已清理,勿回退)

移除主页时已一并清理它留下的孤儿代码。**主页这条线上没有待清理项了**——注意这**不等于**「全仓没有死代码」:仓库另有若干既存死代码(如 `useBooks.ts` 里未被调用的 `useUpload` / `useBatchUpload` / `useDeleteBook` / `useUpdateChapter`),与本轮清理无关,尚未处理。

已清理:

- `src/components/icons.tsx`:删除 `HomeIcon` / `TargetIcon` / `ClockIcon` / `ChevronRightIcon`(全仓零引用)
- `src/lib/readingStats.ts`:删除展示层(`getTodayMinutes` / `getGoalMinutes` / `setGoalMinutes` / `getWeekStats` / `getCurrentStreak` / `getLongestStreak` / `WeekDayStat` / `READING_STATS_EVENT`),**只保留写入端 `addTodayMinutes`**
- `src/hooks/useReaderProgress.ts` 与 `src/lib/readerPrefs.ts`:删除 `getLastReadAt` 与 `lastReadAtKey`——后者存在的唯一理由是主页「之前读过」的时间排序

**一个已知取舍**:删除 `lastReadAtKey` 后,老用户 localStorage 里既有的 `epub_reader:lastReadAt:*` 键**再无任何清除路径**。当前没有任何读取方,无功能影响;但若将来从 git 历史恢复「之前读过」排序,这批陈旧时间戳会让已被标记「未读」的书错误地重新出现——恢复展示层时要一并处理。

两点必须注意:

1. **`readingStats.ts` 仍在使用**,`src/pages/Reader.tsx` 会调 `addTodayMinutes` 记录阅读时长。历史数据继续累积,只是不再有界面展示——**不要当成死代码删掉**。
2. 该模块现在**不含任何 UI 依赖**。将来若要恢复统计界面,从 git 历史取回展示层,不要在记录层里重新长出半套 UI 逻辑。

## 7. 本目录测试基线

见**根 `AGENTS.md` 第 28.5 节**(前端 30 文件 / 179 passed)。此处不重复,避免两处维护同一份数字。

命令与静态门禁(前端没有 ESLint / Prettier)同样见**根 `AGENTS.md`** 第 14 节。
