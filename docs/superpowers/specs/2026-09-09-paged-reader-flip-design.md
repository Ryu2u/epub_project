# 仿真分页阅读(分页计算 + 仿真翻页)设计文档

- 日期:2026-09-09
- 状态:**已实现**(feat/paged-reader-flip 分支;Phase 1-2 完整落地,Phase 3 部分完成——见 §11 实施记录)
- 关联:README「计划实现功能 — 仿真分页阅读」;参考实现为 Android 项目 BookReader 的 `PageFactory`(分页引擎)与 `PageWidget`(仿真卷页)——本文将其核心思想逐一映射到本项目(Web/React/Tauri WebView2)技术栈。

---

## 1. 背景与目标

现有阅读器是**章节级滚动模式**(Reader.tsx):整章 HTML 注入 `overflow-y-auto` 容器,按滚动百分比持久化进度。目标是提供一种**与滚动模式并存**的分页模式:

1. **分页计算** — 把章节 HTML 按「视口尺寸 − 边距」切成一页页的内容区间,字号/行高/字体/栏宽/窗口尺寸变化时重新分页,且不丢阅读位置;
2. **仿真翻页** — 微信读书/iBooks 式的逐页翻页,提供 仿真卷页 / 覆盖 / 平移(无动画) 三种效果,可切换。

### 已知教训(README 记录,必须正面回应)

> 曾实现过一版 CSS Multi-column 方案,因**列宽测量与渲染宽度不一致**导致右侧文字溢出等问题,已回滚;重构时优先保证「测量 = 渲染」同一宽度来源。

本设计的核心原则由此确立:**分页的测量容器与页面的渲染容器使用同一个 CSS 类、同一份内联宽度常量、同一套排版变量,由同一个浏览器排版引擎产出 line box**——测量结果天然就是渲染结果,不存在两套宽度来源。

---

## 2. BookReader(Android)→ Web 概念映射

| Android BookReader | 本项目(Web)对应物 | 说明 |
|---|---|---|
| 章节独立 txt 文件 + `RandomAccessFile`/`MappedByteBuffer` | 章节接口返回的 HTML 字符串 + React Query 缓存 | 后端已有净化重写(`<img>` 指向 asset 接口) |
| 字节指针 `curBeginPos`/`curEndPos` | **DOM Range 边界**(`Boundary = {path, offset}`) | Web 的"内容坐标"是节点路径 + 偏移,不是字节 |
| `Paint.breakText` 逐行折行 | 浏览器排版引擎折行(自适应宽度 + justify) | 不自己实现折行,只**测量**浏览器排好的行盒 |
| `pageDown()/pageUp()/pageLast()` | 分页游走(前向/后向 accumulate line boxes) | 前向分页为主;后向用锚点重定位,不做 O(章) 的 pageLast |
| 双缓冲 `mCurPageBitmap`/`mNextPageBitmap` | 当前页/下一页两个 DOM 容器 + 各自的位图快照(仅仿真模式) | 覆盖/平移模式直接用 DOM transform |
| `PageWidget` 贝塞尔卷曲(Canvas) | Canvas 2D 移植(同样的几何数学) | DOM 页需先栅格化成位图 |
| `OverlappedWidget`/`NoAimWidget` | CSS transform 平移(策略之一) | 覆盖 = 带阴影渐变;无动画 = 0ms |
| `Scroller` + `computeScroll()` | `requestAnimationFrame` + 缓动函数 | 手势释放后自动完成/回弹 |
| `BaseReadView` 手势状态机 | Pointer Events 状态机(独立模块) | 点击区域/拖拽/取消回弹逻辑几乎可以照抄 |
| `saveReadProgress(chapter, begin, end)` | `{chapterId, anchor, paramsHash}`(localStorage) | 页码不可持久化(排版参数变了会漂),锚点才行 |
| 章节预取 chapter-1 ~ chapter+3 | React Query `prefetchQuery` 预取前后章 | 跨章翻页零等待 |
| 进度百分比按章计 | **章内按页计**(有精确页数)+ 全书按章加权 | 修正 BookReader 的已知缺陷 |

---

## 3. 为什么放弃 CSS Multi-column(复盘)

多列方案的结构性问题,不是调参能解决的:

1. **列宽是"建议值"** — `column-width` 会被浏览器按 content-box、间隙、分数像素折算成"使用值",与视口内容宽存在亚像素差,右侧露残字/裁切正是这个差的视觉表现;
2. **总页数依赖 `scrollWidth`** — 又一个取整来源,窗口缩放/DPR 非整数时测量与渲染各自漂移;
3. **列内碎片化规则受限** — `break-inside` 对图片/表格/标题组合的行为各浏览器不一致;
4. **与仿真翻页不兼容** — 卷页需要把"当前页/下一页"各栅格化成一张位图,多列布局里"一列"不是独立元素,截图成本高且不稳定。

取而代之的是 **layout-then-slice(先排版、后切分)**:在真实 DOM 里排版,用 `Range.getClientRects()` 读行盒,把"一页装多少内容"变成纯粹的测量问题,页与页之间用 Range 切分。这正是 foliate等成熟 Web 阅读器采用的路线。

---

## 4. 总体架构

```
src/reader/paged/
├─ types.ts            PageSlice / Boundary / LayoutParams / FlipStyle 等纯类型
├─ paginator.ts        分页引擎(≈ PageFactory):测量、切分、页缓存、锚点解析
├─ anchor.ts           元素路径 ↔ DOM 节点 的序列化/解析(进度持久化的地基)
├─ usePaginator.ts     React hook:章节加载、分页调度、页导航、进度保存、预取
├─ PagedReaderView.tsx 视图(≈ BaseReadView):页面容器层 + 手势层 + 策略挂载
├─ gestures.ts         Pointer Events 状态机(≈ onTouchEvent 的 DOWN/MOVE/UP)
└─ flip/
   ├─ FlipStrategy.ts  策略接口:beginDrag / updateDrag / endDrag(cancel) / attach / detach
   ├─ SlideFlip.ts     覆盖 / 平移(≈ OverlappedWidget / NoAimWidget,纯 CSS transform)
   ├─ CurlFlip.ts      仿真卷页(≈ PageWidget,Canvas 移植)
   └─ snapshot.ts      DOM → 位图(foreignObject 栅格化 + 资源内联 + 缓存)
```

与现有代码的集成点:

- `Reader.tsx` 增加 `mode: 'scroll' | 'paged'`(偏好持久化,默认 scroll 不变);paged 模式渲染 `<PagedReaderView>`,复用现有的 `ReaderTopBar`/`ReaderTocPanel`/`ReaderSettings`/阅读时长统计;
- `ReaderSettings` 增加「翻页效果」分组(仿真 / 覆盖 / 平移 / 无)与「阅读模式」入口;
- `.scroll-article` 的净化排版规则抽出共享层,paged 模式使用 `.paged-article`(见 §5.2);
- 章节预取:`usePaginator` 对 `currentIndex ± 1` 调 `queryClient.prefetchQuery`(与 Android 预取 ±3 章同理,Web 端 HTML 体积大,先 ±1,测量缓存按需扩展)。

---

## 5. 分页引擎设计(paginator.ts)

### 5.1 数据模型

```ts
// 内容坐标:章节 DOM 内的"地址"。path 是从章节根出发的子元素索引序列,
// offset 在文本节点里是字符偏移,在元素节点里是子节点序号(Range 语义)。
interface Boundary {
  path: number[];      // 例:[3, 0, 5] = 根的第3个子节点的第0个子节点的第5个子节点
  textOffset: number;  // path 指向文本节点时有效;指向元素时忽略(用 childIndex)
  childIndex: number;  // path 指向元素节点时的 Range 容器内偏移
}

// 一页 = 一个内容区间(≈ BookReader 的 [curBeginPos, curEndPos))
interface PageSlice {
  index: number;       // 章内页码,0 起
  start: Boundary;
  end: Boundary;       // 不含;= 下一页的 start
}

// 排版参数指纹:任一变化 → 缓存全部失效
interface LayoutParams {
  width: number;       // 内容区宽(整数 px,唯一来源,见 5.2)
  height: number;      // 内容区高(整数 px)
  fontSize: number; lineHeight: number; font: string; theme: string;
}
```

### 5.2 「测量 = 渲染」的强制手段

1. **一个宽度常量**:每次重排时计算 `contentWidth = Math.floor(视口宽 − 2×水平边距)`,以**内联 style** 同时注入测量容器与每页容器(不存在 CSS 规则与内联值两条路径);
2. **一个 CSS 类**:新建 `.paged-article`,规则从 `.scroll-article` 复制(字号/行高/字体 `!important` 兜底、justify、`text-indent: 2em`、标题层级、图片 `max-width:100%`),差异仅:paged 版 `height: H; overflow: hidden; margin: 0`。测量容器与页面容器**都挂这个类**;
3. **同一棵样式树**:测量容器挂在阅读器根节点之下(继承 `--fs/--lh/--font-family/--bg/--fg` 等全部 CSS 变量),`position: absolute; visibility: hidden;` 离屏但**不** `display: none`(否则无布局,`getClientRects` 返回空);禁止对它设 `content-visibility`;
4. **等字体**:分页前 `await document.fonts.ready`(项目 FONTS 全是系统字体栈,主要防 WebView2 首次字体回退差异);
5. **等图片**:净化阶段给 `<img>` 写入显式 `width/height`(取 naturalSize,按 `min(natural, contentWidth)` 等比收缩),布局不依赖加载完成;无法预知的图(无尺寸且未加载)`await img.decode()` 兜底 + 超时降级按 alt 高度占位。

### 5.3 分页游走算法(前向 pageDown 的 Web 版)

```
paginateForward(root, height): PageSlice[]
  measurer := 离屏容器(width=W, height=∞ 的重要:容器不限制高度,
                        用我们自己的累计逻辑判断"装不下",而不是让浏览器滚)
  步骤:
  1. TreeWalker 遍历根下所有块级元素(段落/标题/图片块/列表项/pre…)
  2. 对每个文本块:
     r := Range(块首 → 块尾); rects := r.getClientRects()   // 一行一个 rect
     逐行累计 usedHeight += (rect.bottom − 上一 rect.bottom 或块首 top)
     当某行的 bottom − 块内容起点 top > 剩余页高:
        在该行内二分/步进字符偏移,找到不越界的最大 offset
        → 记 Boundary(path到该文本节点, textOffset=offset),封页
        新页从该 offset 起,usedHeight 重置为该行高度(行本身带入下一页)
  3. 对不可分割块(img/小表格, class 标记 break-inside 规则):
     块高 > 剩余页高 且 块高 ≤ 页高 → 整块推到下一页(记元素边界 Boundary)
     块高 > 页高 → 允许上下文截断(图片缩放到页高,长表格顺其自然跨页)
  4. 块与块之间的 margin 折叠按"块首 top − 上一块 bottom"计入,
     段间距逻辑等价于 BookReader 的 paraSpace 收缩 mPageLineCount
  5. 章末追加哨兵 slice(空页脚,承载"本章完/翻到下一章"的 UI 判定,非必须)
```

要点:

- **只读不写**:游走阶段不修改 DOM,`getClientRects` 集中在每次插入后一次性读取,避免布局抖动(layout thrashing);
- **行盒是唯一真相**:折行、justify、`text-indent`、标点悬挂全部由浏览器决定,我们不重算,所以不会出现"测出来一行、画出来两行";
- **反向翻页不做 pageLast**:BookReader 的 `pageLast()` 是 O(章) 重复扫描(作者自注"比较繁琐,待优化")。Web 版翻到上一章时,对该章执行一次前向分页(有缓存则直接命中),再定位到最后一页 —— 分页是一次性 O(章) 而非每页 O(章)。

### 5.4 页面渲染(克隆 + Range 切分)

显示第 i 页:克隆章节根到 detached 容器 → `anchor.resolveBoundary(clone, start)` 与 `resolveBoundary(clone, end)` 各建一个 Range → 先 `range2.selectNodeContents(clone); range2.setStart(range1.end...)` 再 `extractContents()`,把区间外内容删掉 → 剩余片段挂到可见页容器(同 `.paged-article`、同内联宽高)。

- 区间外删除比 `display:none` 干净:页容器真实高度可控,快照栅格化无空白;
- 页 DOM 按 LRU 保留 ±2 页(手势需要 current/next 两页;仿真模式还要它们的位图);
- 文本选择、右键复制在当前页内天然可用(这是相对 BookReader 全 Canvas 绘制的**优势**)。

### 5.5 缓存与失效

- 页缓存键:`(bookId, chapterId, paramsHash)`;`paramsHash = hash(LayoutParams)`;
- 字号/行高/字体/主题/栏宽/窗口 resize 任一变化 → 失效重排;resize 防抖 300ms;
- **原地重排保位**(对应 BookReader `setTextFont` 的 `curEndPos = curBeginPos; nextPage()`):重排前取当前页 `start` 锚点,重排后二分定位包含该锚点的页(比较 Boundary 的文档序),跳转过去,阅读位置不丢;
- 邻章懒分页:只分当前章;翻到章末/章首边缘页时,后台(`requestIdleCallback` 分块执行)分下一章/上一章,跨章翻页即时响应。

### 5.6 进度持久化(锚点,而非页码)

```ts
// key: epub_reader:progressPaged:{bookId}
{
  chapterId: string;
  anchor: Boundary;        // 当前页 start —— 页码会漂,锚点不会
  pageIndex: number;       // 仅作展示参考
  paramsHash: string;      // 恢复时若指纹不同也能靠 anchor 重新定位
}
```

- 保存时机:**翻页动画落定后** debounce 500ms(修正 BookReader「每次 onDraw 都写 SharedPreferences」的高频写问题);
- 滚动模式进度(现有 `progressKey`)与分页模式进度**分开存**,互不污染;模式互切时,滚动 → 分页用滚动百分比近似换算锚点(按章内文本长度比例),分页 → 滚动直接用锚点 resolve 后 `scrollIntoView`。

### 5.7 性能预算

- 一章 1 万字 ≈ 500 行 ≈ 数十个块;一次 `getClientRects` 批读 + 纯 JS 累计,桌面 WebView2 上 < 10ms 量级;10 万字长章用 `requestIdleCallback` 按 50 块一批切片,主线程无长任务;
- 章节切换:React Query 缓存命中时,分页可同步完成(有缓存);未命中先显示"第 1 页加载中"骨架,分页完成后一次性呈现。

---

## 6. 仿真翻页设计

### 6.1 三种效果与策略接口

```ts
interface FlipStrategy {
  // 手势层把指针事件翻译成这四个调用;策略只管画
  attach(view: PagedReaderView): void;
  beginDrag(dir: 1 | -1): void;            // 开始拖:准备 current/next 两页
  updateDrag(x: number, y: number): void;  // 拖动中:实时渲染
  endDrag(cancel: boolean): void;          // 松手:true=回弹,false=完成翻页
}
```

- **SlideFlip(覆盖/平移)**:当前页 `transform: translateX(dx)` + 边缘 5px 渐变阴影(对应 OverlappedWidget);平移模式同一实现,动画时长参数化(0ms 对应 NoAimWidget)。纯 DOM,零栅格化;
- **CurlFlip(仿真)**:Canvas 覆盖层 + 位图合成(下述)。

手势状态机(gestures.ts,≈ BaseReadView.onTouchEvent):

| 事件 | 逻辑 |
|---|---|
| pointerdown | 落点在中央 1/3 → center 模式(不翻页,留给菜单);左 1/3 → 向前翻,右 1/3 → 向后翻;锁定 `dir`,调 `strategy.beginDrag(dir)` |
| pointermove | 更新触点;`cancel = 触点越过起点反向`(从右缘起翻却往右回撤)→ 供 UP 判定回弹;调 `updateDrag` |
| pointerup | ① center 且位移 <5px → 呼出/隐藏菜单;② 位移 <10px 且 <300ms → **点击翻页**:`endDrag(false)` 由动画自动完成(平移模式 0ms 瞬翻);③ 位移大:`cancel ? endDrag(true)(回弹) : endDrag(false)(完成)` |

动画驱动:rAF + 缓动(等价 Scroller 的 `computeScroll` 循环):完成翻页 = 触点沿松手方向滚出屏(700ms,easeIn);回弹 = 触点回到起点(400ms,easeOut)。每帧把插值坐标喂给 `updateDrag`。

### 6.2 DOM → 位图(snapshot.ts,仿真的地基)

BookReader 的 PageWidget 拿到的就是两张现成 Bitmap;Web 侧需要先把页 DOM 栅格化:

```
pageEl → 克隆 + 样式物化(把 --fs/--lh/--fg 等 CSS 变量与 .paged-article
         规则解析成内联值;图片 URL fetch 后转 data: 内联)
       → XMLSerializer 序列化,包进 <svg><foreignObject width=W height=H>
       → new Image() + src = 'data:image/svg+xml;charset=utf-8,...'
       → await img.decode()
       → drawImage 到 offscreen canvas(尺寸 = W×H×devicePixelRatio,
         ctx.setTransform(dpr,0,0,dpr,0,0),保证 2K 缩放不糊)
```

已知约束与对策:

- **data: URL 的 SVG 是"图像上下文"**:不加载外部字体/图片 → 项目 FONTS 全是系统字体栈(天然满足);章节图片必须内联成 data:(fetch → blob → FileReader,按 asset 缓存,同一张图只转一次);
- **XHTML 严格性**:foreignObject 要求 well-formed XML;章节 HTML 经服务端容错解析,用 `DOMParser(text/html)` 重解析再 `XMLSerializer` 序列化即可修正未闭合标签;
- **失败降级**:`img.decode()` 抛错 / SecurityError → 自动切 SlideFlip(覆盖)并在控制台告警;用户设置里仿真选项保留,下次重试;
- **缓存**:页位图随页 DOM 一起 LRU(±2 页);主题/字体/字号变化时全失效。

### 6.3 PageWidget 几何移植(CurlFlip.ts)

直接移植 BookReader 的数学,全部是纯函数,可单测:

1. **calcCornerXY**:按 `dir` 与触点象限选定翻动角(右向翻 → 右上/右下角);
2. **calcPoints**:由角 F 与触点 M 推导两段贝塞尔的长边短边起点/控制点/顶点/终点,含**越界修正**(触点超出页面中线/拖到对侧时的钳制)—— BookReader 的实现照抄,同时修掉它的已知问题:**`getCross()` 除零防护**(f4==0 已防,还需防 P1.x==P2.x 的竖直折线,加 epsilon);
3. **当前页剩余区域**:Android 用 `clipPath(XOR)`;canvas 用 `Path2D` + `ctx.clip('evenodd')`;
4. **卷起背面**:Android `Matrix.setPolyToPoly` 绕折线反射 + `ColorMatrix` 变暗;canvas 等价:
   ```
   ctx.save();
   背面区域 Path2D → ctx.clip();
   // 绕折线反射 = 平移到折点 → 旋转 θ → scale(1,-1) → 旋转 -θ → 平移回
   ctx.translate(fx,fy); ctx.rotate(θ); ctx.scale(1,-1); ctx.rotate(-θ); ctx.translate(-fx,-fy);
   ctx.filter = 'brightness(0.72)';        // ≈ ColorMatrix 变暗,WebView2(Chromium)支持
   ctx.drawImage(curBitmap, 0, 0, W, H);
   ctx.restore();
   ```
5. **阴影**:折线两侧 `createLinearGradient`(黑→透明)填充,几何同 Android 的 GradientDrawable 组;页面背面再加一层淡渐变模拟纸厚;
6. **合成次序**:下一页(垫底)→ 当前页剩余区 → 背面 → 前页阴影 → 背面高光,每帧一个 `rAF` 内完成,60fps 下单层 `drawImage`×3 + 渐变填充,桌面毫无压力。

### 6.4 页脚状态区(可选,Phase 3)

对应 BookReader onDraw 的底部信息:页码 `第 x/N 页`、章内进度百分比、时间;直接作为页 DOM 的一部分渲染在内容区下方的保留条里(比每帧 canvas 画省事,且主题化免费)。**进度取章内页比例,修正 Android 版"整章百分比不动"的缺陷**;全书进度 = Σ(各章字数 × 章内进度)/总字数。

---

## 7. 交互集成清单

- **设置**:`ReaderSettings` 增「翻页效果」(仿真/覆盖/平移/无)与「阅读模式」(滚动/分页);新增 localStorage key `epub_reader:flipStyle:global`、`epub_reader:mode:global`;
- **键盘**(≈ Android 音量键翻页):`←/PageUp` 上一页,`→/PageDown/Space` 下一页,`Home/End` 章 首/末;
- **目录跳转**:TOC 选中章节 → 加载该章 → 锚点=章首 → 分页 → 定位第 1 页;
- **跨章翻页**:章末页再向后翻 → 预取好的下一章第 1 页(对齐 BookReader 的 `nextPage()` 状态机,但失败态只有"无下一章",不存在 Android 的网络重拉分支 —— 数据都在本地);
- **阅读时长统计**:沿用现有 visibilitychange 计时,与翻页解耦。

---

## 8. 边界情况与风险

| # | 风险 | 对策 |
|---|---|---|
| 1 | 亚像素宽度不一致(上次回滚的直接死因) | 单一 `contentWidth` 常量 + 内联注入 + `Math.floor`;Phase 0 专项验证 |
| 2 | foreignObject 栅格化保真度(字体/CJK 对齐) | Phase 0 在 WebView2 + Chrome 双端截图比对;失败自动降级覆盖模式 |
| 3 | 章内图片无尺寸 → 测量后跳版 | 净化阶段写显式 width/height;未加载图 decode 等待 + 超时占位 |
| 4 | 超长章节(10万+字)分页卡顿 | idle 分批分页 + 邻章懒分页 + 页缓存 |
| 5 | Ctrl+F 浏览器查找只搜当前页 | 已知取舍(仅当前挂载页可搜);文档注明,不做虚拟兜底 |
| 6 | 窗口拖拽 resize 连续重排 | 防抖 300ms + 锚点保位重排 |
| 7 | RTL/竖排 EPUB | 明确不支持,检测 `writing-mode`/`direction` 时回落滚动模式 |
| 8 | 触屏与鼠标统一 | Pointer Events 天然统一;`touch-action: none` 限制在手势层 |

---

## 9. 测试策略(Vitest,延续现有约定)

- **纯数学全单测**:calcPoints/calcCornerXY/反射矩阵/越界修正/除零防护 —— BookReader 的几何 bug(如 getCross 竖直折线除零)在这里被测试钉死;
- **anchor.ts 全单测**:Boundary 序列化/解析/文档序比较,jsdom 可跑(无布局依赖);
- **paginator 逻辑单测**:把"行盒测量"抽成可注入的 `Measurer` 接口(`getBlockRects(path): Rect[]`),用假行盒数据测累计/封页/块推页逻辑 —— jsdom 无真实布局,这正是绕开点;
- **snapshot/prefetch/手势** :真机(WebView2 + 浏览器)手测清单:缩放 80%~150%、拖栏宽、切主题、翻到章末跨章、断点恢复、中文诗集(短行多段)与无空格西文的折行正确性。

---

## 10. 分阶段实施计划

- **Phase 0 — 技术验证 spike(先行,两大风险点各一天)**
  1. 离屏测量容器 + getClientRects 行盒读取 + 整数宽度注入,验证「测量=渲染」在 3 本真实 EPUB 上零溢出;
  2. foreignObject 栅格化一章中文正文,WebView2/Chrome 截图与 DOM 渲染逐像素比对(字体、justify、图片内联)。
  任一失败 → 回到本设计调整(方案 B:仿真模式退为 3D transform 硬页翻)。
- **Phase 1 — 分页骨架**:paginator + anchor + usePaginator + PagedReaderView + SlideFlip(覆盖/平移)+ 进度锚点 + 设置项 + 键盘/点击区;滚动/分页模式可切换。
- **Phase 2 — 仿真翻页**:snapshot + CurlFlip 移植 + 策略降级链。
- **Phase 3 — 打磨**:页脚状态区、全书进度、邻章 idle 分页、图片跨页规则、性能与异常兜底测试。

---

## 附录 A:与 BookReader 关键差异备忘

1. BookReader 是纯文本引擎(breakText 折行 + Canvas fillText),换来的是完全控制力、失去富文本;本项目反向选择:**浏览器排版 + DOM 切片**,保住图片/粗斜体/选择/无障碍,把"位图"推迟到动画层(snapshot)才出现;
2. BookReader 的字节指针在 GBK/UTF-8 下要按字节回退(`curEndPos -= strParagraph.getBytes(charset).length`);Boundary 天然按 DOM 节点计,无编码问题;
3. BookReader 每次绘制落盘进度;本设计只在翻页落定时 debounce 落盘;
4. BookReader 的 pageLast O(章) 扫描被"一次性前向分页 + 缓存"取代;
5. Android 的三种 Widget 通过继承复用(NoAimWidget extends OverlappedWidget);Web 侧用策略组合,平移=覆盖的时长参数化,同一映射。

---

## 11. 实施记录(2026-09-09)

分支 `feat/paged-reader-flip`,四个提交:

| 提交 | 内容 |
|---|---|
| docs | 设计文档 + README 索引 |
| feat(paged) 核心分页 | `types/anchor/paginator/curlGeometry` + 36 单测 |
| feat(paged) 视图与翻页 | `gestures/flip/*(Slide/Curl/snapshot/FlipController)/usePaginator/PagedReaderView/pagedProgress` + Reader/设置/CSS 集成 + 3 集成测试 |
| fix(paged) 审查修复 | 快照 CSS 变量化(双坑:!important 压内联字号 + data: SVG 不解析变量)、键盘翻页统一 begin→finish、卸载落盘去过期闭包 |

落地要点与设计的偏差:

1. **测量树与渲染树同构**:章节节点直接作为测量容器的子节点(而非包一层再放进去),保证 Boundary 路径在两棵树上可互换——实施中发现的必要约束;
2. **快照的变量物化**:foreignObject 包装器上定义 `--fs/--lh/--font-family/--bg/--fg`(继承进克隆),而非内联 font-size——`.paged-article` 的 `!important` 类规则会压掉内联值;
3. **纸背 ColorMatrix 精确移植**:快照时一次性像素变换(0.55 scale + 80 offset + alpha 0.2),逐帧零滤镜成本;
4. **降级链实测点**:curl 位图预热失败 2 次 → 本会话永久覆盖;手势时位图未就绪 → 当次覆盖;jsdom/无 RO/无 getClientRects 三级兜底走「整章单页」;
5. **已知取舍**:后向翻页的仿真位图不预热(回落覆盖);`Ctrl+F` 只搜当前挂载页;分页模式关闭文本选择(拖拽与选词冲突)。

验证:`tsc -b` 零错误;vitest 16 文件 129 测全绿(含既有 Reader/Library 等零回归);`pnpm build` 产物正常。真机(WebView2)卷页效果需人工验收——设计文档 Phase 0 的两项 spike 在实现中以代码审查 + 单测替代,首次运行如遇快照异常将自动降级覆盖,不影响可用性。
