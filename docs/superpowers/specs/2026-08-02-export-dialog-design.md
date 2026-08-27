# 导出弹窗交互设计

日期:2026-08-02
状态:已确认

## 背景

Detail 页的「导出」按钮目前是原生 `<a href="/api/books/{id}/export" download>` 链接
(Detail.tsx:327-333)。点击后无任何反馈,浏览器静默开始下载,几秒后完成。
用户期望看到明确的「导出中 → 导出完成 → 手动下载」反馈。

后端导出端点已完备:`GET /api/books/:id/export` 返回 `application/epub+zip`,
带 `Content-Disposition`(含书名,UTF-8 filename*)。**后端无需改动。**

## 方案

前端新增导出流程,只改 `web/src/pages/Detail.tsx` + 新增一个导出弹窗组件。

### 组件:ExportDialog

`web/src/components/ExportDialog.tsx`,风格沿用现有暗色图书馆配色
(参考 ConfirmDialog 的样式,但用金色主按钮,语义不同)。

Props:
- `open: boolean` — 显隐
- `bookId: string` — 导出目标书
- `bookTitle: string` — 用于成功后展示
- `onClose: () => void` — 关闭回调

内部状态机:`idle → loading → success | error`

- **loading**:转圈图标 + 「正在导出…」,关闭按钮禁用,防重复触发
- **success**:「导出完成」+ 文件名,提供「下载」按钮(`onClick` 手动触发保存)+ 关闭
- **error**:后端 `{error:{message}}` 的错误文案 + 「重试」按钮

### 下载实现

不用原生 `<a download>`。改 fetch 二进制:

1. `fetch('/api/books/{id}/export')` 拿到 `response`
2. 非 200 → 解析错误 JSON 展示
3. 200 → `await response.blob()` 暂存
4. 点「下载」时创建临时 `<a href={URL.createObjectURL(blob)} download={filename}>`
   触发点击后 `revokeObjectURL`

文件名从后端 `Content-Disposition` 解析(优先 `filename*` 的 UTF-8 部分,
失败则回退 `<bookTitle>.epub`)。

### Detail 页集成

- 原 `<a>` 改 `<button onClick={() => setExportOpen(true)}>`,按钮文字保持「导出」
- 新增 `const [exportOpen, setExportOpen] = useState(false)`
- 渲染 `<ExportDialog open={exportOpen} bookId={book.id} bookTitle={book.title} onClose={...} />`

## 取舍

- **fetch 全量到内存**:大书(几百 MB)导出时前端内存占用高。
  当前后端本身就是「等几秒一次性返回全量」模型,配合弹窗已满足需求;
  流式进度留作后续优化,本次不做(YAGNI)。
- 不做实时进度百分比:后端一次性返回,前端拿不到中间进度。

## 错误处理

- 导出中重复点击 → 组件层禁用,天然防止
- 网络失败 / 后端 500 → error 状态展示 message,可重试(重试重新 fetch)
- 下载按钮点击后 blob URL 即时 revoke,避免内存泄漏

## 验证

- 手动:点击导出 → 弹窗显示「正在导出…」→ 几秒后「导出完成」+ 文件信息 → 点下载保存
- 用一本小书 + 一本 664 章的大书各测一次
- 后端异常路径:临时停后端再导出 → 弹窗显示错误
