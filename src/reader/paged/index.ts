// 分页阅读引擎 —— 对外唯一入口(公开 API)。
//
// 只公开三样东西:
//   - <PagedReaderView />   分页视图:内部负责测量/切片/翻页动画/手势/进度
//   - PagedReaderViewProps  它的 props(章节数据、字号行距字体、主题、翻页效果、搜索定位)
//   - FlipStyle             翻页效果:'slide'(平移,默认)/ 'cover'(覆盖)/ 'none'(瞬翻)
//
// 其余文件都在 internal/ 下,属于内部实现。外部请只从这个入口导入:
//   内部结构与「测量 = 渲染」这条硬约束绑得很紧(离屏测量容器必须与页面容器
//   共用 .paged-article 与同一个整数宽度),直接 import ./internal/paginator
//   之类很容易绕过约定,并把 Boundary / PageSlice 这些内部坐标泄漏到业务层 ——
//   以后改分页算法就会牵连所有调用方。边界由 index.test.ts 钉住:模块外
//   出现深层导入会直接测试失败。
//
// 已知耦合(有意保留,不做额外抽象):视图内部通过 useChapter / apiGet 取章节
// HTML,通过 pagedProgress(localStorage)存锚点进度,与业务数据层共用。

export { PagedReaderView } from './internal/PagedReaderView';
export type { PagedReaderViewProps, PagePosition } from './internal/PagedReaderView';
export type { FlipStyle } from './internal/types';
