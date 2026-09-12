# 分页阅读引擎模块化(公开 API + 内部实现)设计文档

## 1. 背景与目标

分页阅读引擎此前平铺在 `src/reader/paged/` 下(15 个文件:分页计算、测量、锚点、
手势、翻页动画、进度、视图),任何文件都能被业务层直接 `import`。实际发生过的问题:

- `src/pages/Reader.tsx` 直接 `import { PagedReaderView } from '../reader/paged/PagedReaderView'`
  —— 入口文件一旦拆分/改名,调用方全要跟着改;
- 引擎内部的 `Boundary` / `PageSlice` 这类「DOM 路径 + 偏移」坐标是**实现细节**,
  外部一旦依赖,后续改分页算法就会牵连业务层;
- `FlipStyle` 曾在 `src/lib/readerPrefs.ts` 与引擎 `types.ts` 各写了一份字面量联合
  (靠结构类型碰巧兼容),`ReaderMode` 在引擎里定义却无人使用。

本次目标:把引擎收敛成「一个公开入口 + 一个内部实现目录」,边界可验证。

**非目标**(明确不做):

- 不建独立 npm 包、不动构建(仍是仓库内模块,`pnpm build` 无变化);
- 不把分页搬到 Rust 侧 —— 分页的测量必须由浏览器排版引擎完成(见第 2 节);
- 不做视图与数据层的解耦抽象(见 6.3「已知耦合」)。

## 2. 为什么分页不能搬到 Rust(与 BookReader 的对照)

参考项目 Android `BookReader` 的分页在 Java 侧完成,容易误以为 Web 版也能在
后端算好页码。实际两者是同一件事的两种写法:

| BookReader(Android) | 本项目(Web) |
|---|---|
| `Paint.breakText()` / `StaticLayout` 由系统排版引擎测量 | `Range.getClientRects()` 由浏览器排版引擎测量 |
| 在**客户端进程**内测量 | 在**客户端**(WebView)内测量 |

关键点:**测量即渲染**。字体度量、CJK 断行规则、`text-align: justify` 的拉伸、
图片缩放都会参与断行;Rust 侧只能用字符宽度估算,与 WebView 真实排版必然有偏差,
表现就是「后端说这页满了,前端还差两行」。因此引擎必须在浏览器端,`src-tauri/`
下也放不了它 —— 放到那边只能是前端 TS 包与 Cargo 工程目录混住,收益为负。

(Canvas 自绘正文是另一条路:可行但会丢掉图片/样式/文本选择/Ctrl+F,且要自己
重写排版引擎,代价远大于收益。导入导出不受影响,两侧都读 `chapters/{book}/{chapter}.html`。)

## 3. 模块结构与依赖方向

```
src/reader/paged/
├─ index.ts                  ← 唯一公开入口(只导出组件 + 公开类型)
├─ index.test.ts             ← 公开 API 契约测试(见第 4 节)
└─ internal/                 ← 内部实现,外部禁止深层导入
   ├─ types.ts               Boundary / PageSlice / LayoutParams / FlipStyle / PagedProgress
   ├─ anchor.ts              内容的「DOM 路径 + 偏移」坐标换算与定位
   ├─ paginator.ts           布局后切片(行盒二分)+ 切片缓存
   ├─ measureChapter.ts      当前章节 / 相邻章节测量
   ├─ usePaginator.ts        分页状态机(换章、恢复锚点、搜索定位)
   ├─ pagedProgress.ts       锚点进度持久化(localStorage)
   ├─ gestures.ts            指针手势状态机
   ├─ PagedReaderView.tsx    视图装配(舞台 + 离屏测量容器)
   └─ flip/                  翻页策略:SlideFlip(平移/覆盖/瞬翻)+ FlipStrategy 接口
```

依赖方向单向:`index → internal → (hooks/useBooks、api/client、lib/locateText、
lib/readerPrefs)`。业务层只依赖 `index`。

## 4. 公开 API 契约

```ts
import { PagedReaderView } from '../reader/paged';
import type { PagedReaderViewProps, PagePosition, FlipStyle } from '../reader/paged';
```

| 导出 | 说明 |
|---|---|
| `PagedReaderView` | 分页视图组件(唯一运行时导出) |
| `PagedReaderViewProps` | 其 props:bookId / routeChapterId / chapters / fontSize / lineHeight / fontFamily / theme / flipStyle / locator / initialFraction / onPageChange / onCenterClick / onPageTurn / onNavigateChapter |
| `PagePosition` | `{ chapterId, pageIndex, pageCount }`,由 `onPageChange` 上报 |
| `FlipStyle` | `'slide'`(平移,默认)/ `'cover'`(覆盖)/ `'none'`(瞬翻) |

两个可选 props 支撑「与滚动模式互通」(见 §6.4):

- `initialFraction?: number` —— 首次分页的落点比例(0..1)。只在「本章没有已保存
  锚点 + 第一次测量」时消费一次,之后翻页/改字号/换章都不再参与;
- `onPageChange?: (info: PagePosition) => void` —— 页码变化(翻页/跳转/换章)后上报。
  过渡期(切片仍属旧章)不上报,避免把旧章页码记到新章上。

`FlipStyle` 以**引擎为单一来源**:`src/lib/readerPrefs.ts` 只做类型转发
(`export type { FlipStyle } from '../reader/paged'`)。type-only 转发编译后被抹掉,
偏好模块不会因此依赖引擎运行时。`ReaderMode`('scroll' | 'paged')是应用偏好,
只留在 `readerPrefs.ts`,已从引擎 `types.ts` 移除。

## 5. 边界如何被强制

三层,由弱到强:

1. **目录命名** —— `internal/` 一眼可辨,代码评审可见;
2. **文件头标注** —— `internal/` 下每个文件首行写明「内部实现,勿从外部直接导入
   —— 对外入口见 ../index.ts」;
3. **契约测试** `index.test.ts`(仓库没有 ESLint,不为此引入 lint 依赖与构建改动):
   - 运行时导出面锁定为 `['PagedReaderView']` —— 以后要公开新东西,必须同时改测试,
     属于**有意的破坏性变更**;
   - 用 Vite `import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw' })` 把源码当文本
     读进来,扫描模块外是否存在指向 `reader/paged/` **深层路径**的引用
     (import / export from / `vi.mock` / 动态 import 都会命中),失败信息直接列出
     违规文件与路径。不用 `node:fs`:本项目未装 `@types/node`;
   - 扫描自检:确认确实读到了源码、且 `Reader.tsx` / `readerPrefs.ts` 用的是入口路径,
     防止「扫描失效 → 假绿」。

   > 该守卫已用「故意放一个深层导入」验证过:测试如期失败并打印违规文件,删掉后恢复通过。

## 6. 取舍与已知耦合

### 6.1 为什么不做成独立包

独立包要动 pnpm workspace、构建产物、发布配置;而当前只有一个消费者
(`src/pages/Reader.tsx`)。接口先稳定下来,真要跨项目复用时再抽包 —— 届时只需把
`src/reader/paged/` 整体搬走,对外契约已经就位。

### 6.2 为什么不引入 ESLint 规则

仓库无 lint 配置,为一条边界引入 ESLint + `no-restricted-imports` 会带来依赖与
构建改动,而测试已经能给出同等强度的保证(且失败信息更直白)。

### 6.3 已知耦合(有意保留)

视图内部通过 `useChapter` / `apiGet` 取章节 HTML、通过 `pagedProgress` 存进度,
与业务数据层共用,没有另做「数据源注入」抽象:分页语义与章节数据形态强相关,
提前抽象只会多一层间接。若将来要在别的应用复用,再引入一个
`fetchChapterHtml: (chapterId) => Promise<string>` 之类的注入点。

### 6.4 与滚动模式的位置互通(2026-09-12 追加)

两种模式各存各的进度(滚动存百分比、分页存锚点),而且**分页模式下滚动容器不渲染**
——父组件既算不出进度、也读不到位置。实测两个缺陷:

1. 分页模式顶栏进度恒为 0%(`progressPct = restored ? liveProgress : 0`,而
   `restored` 只由滚动恢复流程置位);
2. 切模式掉位置:滚动→分页落回章首,分页→滚动跳回很久以前的滚动位置。

修法就是 §4 的两个可选 props:引擎上报 `PagePosition`,父组件据此显示进度、并按
`pageIndex / pageCount` 写一份滚动模式的百分比;反方向由父组件在切换那一刻快照
滚动百分比,作为 `initialFraction` 传给分页视图。引擎不直接读写滚动模式的存储
(那是应用层的事),两边只通过 props 对接。

## 7. 验证

- `pnpm typecheck` 0 错误(搬迁后 7 处跨目录 import 加深一层,编译期即暴露遗漏);
- `pnpm test` **26 个文件 / 164 项通过**(原 161 项 + 公开 API 契约 3 项);
- `pnpm build` 成功;
- 守卫测试做了一次「故意违规」验证(见 5.3)。

## 8. 后续可做

- 超长章节 idle 分页的更细粒度让出(Phase 3,原 README 待打磨项);
- 图片高于整页时的缩放策略;
- 若出现第二个消费者,再按 6.1 抽包。
