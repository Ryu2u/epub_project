// 内部实现,勿从外部直接导入 —— 对外入口见 ../index.ts(只公开 PagedReaderView / FlipStyle)。
// 分页阅读模式的共享类型。
//
// 概念映射(来自 Android BookReader 的 PageFactory,见设计文档
// docs/superpowers/specs/2026-09-09-paged-reader-flip-design.md):
//   - BookReader 用「字节偏移」定位章节内位置;Web 侧的等价物是
//     「DOM 节点路径 + 偏移」(Boundary),它天然与编码/字体无关,
//     只依赖章节 HTML 的结构稳定性(服务端返回的 HTML 是确定性的)。
//   - BookReader 的一页 = [curBeginPos, curEndPos);这里的一页 =
//     PageSlice = [start, end) 两个 Boundary 的区间。

/** DOM 位置:node/offset 是 Range 的 setStart/setEnd 语义。 */
export interface DomPosition {
  node: Node;
  offset: number;
}

/**
 * 内容坐标:从章节根元素出发的「子节点索引路径 + 偏移」。
 *
 * - path 指向文本节点时,用 textOffset(字符偏移);
 * - path 指向元素节点时,用 childIndex(子节点序号,Range 语义)。
 * - path = [] 指章节根元素本身(childIndex=0 即内容最前,
 *   childIndex=子节点数 即内容最后)。
 */
export interface Boundary {
  path: number[];
  textOffset: number;
  childIndex: number;
}

/** 一页 = 章节内容区间 [start, end)。end == 下一页的 start。 */
export interface PageSlice {
  index: number;
  start: Boundary;
  end: Boundary;
}

/** 分页排版参数。任一字段变化都必须重新分页。 */
export interface LayoutParams {
  /** 内容区宽(整数 px,测量容器与页面容器共用同一常量)。 */
  width: number;
  /** 内容区高(整数 px)。 */
  height: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

// 翻页效果(对应 BookReader 的 OverlappedWidget/NoAimWidget 家族):
// slide = 平移(左右轮播式滑动,默认);cover = 覆盖(新页滑入盖住当前页);
// none = 无动画瞬翻。仿真卷页已按用户要求移除。
// 引擎里唯一的翻页效果定义,经入口公开出去(阅读偏好里的 FlipStyle 转发自此)。
export type FlipStyle = 'cover' | 'slide' | 'none';

/** 分页进度(锚点持久化,页码只作展示参考)。 */
export interface PagedProgress {
  chapterId: string;
  anchor: Boundary;
  pageIndex: number;
  paramsHash: string;
}
