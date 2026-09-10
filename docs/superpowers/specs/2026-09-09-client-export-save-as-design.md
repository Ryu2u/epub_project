# 客户端导出:原生「另存为」直接写盘 设计文档

- 日期:2026-09-09
- 状态:已实现
- 关联:README「📤 导出(EPUB / TXT)」;触发:用户反馈「改为客户端之后,导出功能是不是没改」

---

## 1. 问题

导出流程是照浏览器时代写的:导出完成 → `fetchExportFile` 取 blob →
`URL.createObjectURL` + `<a download>` 触发保存。

在桌面端(Tauri/WebView2)里这条路走不通:WebView 没有下载管理器,
`<a download>` 既不弹保存框也不落盘,`src-tauri` 里也没有 `on_download`
处理器。用户点「下载」实际什么都不会发生。

## 2. 新流程

**桌面端(客户端)**:

```
选格式 → 原生「另存为」对话框(pickExportSavePath) → 导出任务(startExportAsync)
      → 进度轮询 → 完成后 save_export_file(taskId, destPath) → 后端直接写盘
      → 界面显示「已保存到 <路径>」,不再有「下载」按钮
```

- 取消「另存为」→ 不开始导出(避免白跑一次打包);
- **字节不经过前端**:打包结果本来就在后端任务槽里(`TaskKind::Export.result`),
  写盘命令直接取出写文件,省掉一次几十 MB 的 IPC 往返;
- 写盘失败(占用/权限/磁盘满)会把字节**放回任务槽**,界面提示错误并可「返回重试」换路径。

**浏览器端**:保持原样(取 blob → `<a download>`),`fetchExportFile` 保留。

## 3. 实现

| 位置 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` | 新增 `save_export_file(task_id, dest_path)`;抽出 `write_export_bytes`(补建父目录 + 覆盖已存在文件) |
| `src-tauri/src/lib.rs` | 注册命令 |
| `src/api/client.ts` | `pickExportSavePath(defaultName, ext)`(dialog 插件 `save()`,取消返回 null)、`saveExportFile(taskId, destPath)` |
| `src/components/ExportDialog.tsx` | 桌面端:`chooseFormat` 先弹保存框再设 format;运行 effect 等 `savePath` 就绪;完成后调 `saveExportFile` 并展示路径;成功态不渲染「下载」按钮 |

权限:复用已有的 `dialog:default`(含 `allow-save`),无需新增 capabilities。

## 4. 测试

- **Rust**(`commands::export_save_tests`,3):父目录不存在时自动补建、覆盖已存在文件、路径不可写时返回 Err;
- **前端**:`ExportDialog.desktop.test.tsx`(4,桌面端):选格式先弹保存框、
  取消则不导出、完成后写入选定路径且无「下载」按钮、写盘失败可返回重试;
  `ExportDialog.test.tsx`(4,浏览器端)保持原行为不回归。

## 5. 注意

客户端是编译产物:**改完 Rust 需要重启/重建 Tauri 应用**(`pnpm tauri dev` 会自动重编译);
浏览器里访问 `http://localhost:1420` 时仍走下载路径(未检测到 Tauri 运行时)。
