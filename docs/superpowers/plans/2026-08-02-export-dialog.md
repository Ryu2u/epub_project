# 导出弹窗交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Detail 页的「导出」按钮加弹窗反馈:导出中 → 导出完成(手动下载)/ 错误重试。

**Architecture:** 新增 `ExportDialog` 组件(状态机 idle/loading/success/error),用 fetch 拉取导出二进制到 blob;Detail 页按钮从原生 `<a download>` 改为 `onClick` 打开弹窗。后端 `GET /api/books/:id/export` 不改。

**Tech Stack:** React 18 + TypeScript + Tailwind + React Router(vite dev server 代理 /api → 8001)。

## Global Constraints

- 前端只在 `web/` 下改动:新增 `web/src/components/ExportDialog.tsx`,修改 `web/src/pages/Detail.tsx`
- 后端 `backend-rs/` 不碰
- 下载文件名从后端 `Content-Disposition` 解析;失败回退 `<bookTitle>.epub`
- 弹窗样式沿用现有暗色图书馆配色(背景 `bg-ink-800`,金色 `gold-400` 主按钮)
- 每次导出点击新 fetch,不缓存 blob(避免内存泄漏)

---

### Task 1: 新建 ExportDialog 组件

**Files:**
- Create: `web/src/components/ExportDialog.tsx`
- Test: 无独立测试(纯 UI 组件,沿用项目现有做法,靠手动验证)

**Interfaces:**
- Consumes: 无(独立组件)
- Produces:
  - `interface ExportDialogProps { open: boolean; bookId: string; bookTitle: string; onClose: () => void; }`
  - `export function ExportDialog({ open, bookId, bookTitle, onClose }: ExportDialogProps): JSX.Element | null`
  - 内部状态 `type Phase = 'idle' | 'loading' | 'success' | 'error'`
  - 内部 `const [filename, setFilename] = useState<string>('')`(成功时的文件名)

- [ ] **Step 1: 编写组件初始骨架**

创建 `web/src/components/ExportDialog.tsx`:

```tsx
// 导出弹窗:导出中 → 完成(手动下载)/ 错误重试。
import { useEffect, useState } from 'react';

interface ExportDialogProps {
  open: boolean;
  bookId: string;
  bookTitle: string;
  onClose: () => void;
}

type Phase = 'idle' | 'loading' | 'success' | 'error';

export function ExportDialog({ open, bookId, bookTitle, onClose }: ExportDialogProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [filename, setFilename] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);

  // open 为 true 时触发首次导出;关闭时清空 blob 释放内存
  useEffect(() => {
    if (open) {
      setPhase('loading');
      setError('');
      void doExport();
    } else {
      setBlob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return <div>placeholder</div>;
}
```

- [ ] **Step 2: 实现 doExport + 下载触发**

在组件内补上 `doExport` 与 `handleDownload`:

```tsx
  async function doExport() {
    setPhase('loading');
    setError('');
    try {
      const res = await fetch(`/api/books/${bookId}/export`, { credentials: 'include' });
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          /* 非 JSON,用默认文本 */
        }
        throw new Error(message);
      }
      const b = await res.blob();
      setFilename(parseFilename(res.headers.get('Content-Disposition'), bookTitle));
      setBlob(b);
      setPhase('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
      setPhase('error');
    }
  }

  function handleDownload() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `${bookTitle}.epub`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 3: 实现文件名解析 + 完整 JSX**

在模块底部添加独立函数(模块作用域,非组件内):

```tsx
// 从 Content-Disposition 解析文件名。后端已在 filename* 和 filename 里带 .epub 后缀,
// 这里只解码不追加;没有匹配时回退用书名。
function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return `${fallback}.epub`;
  // filename*=UTF-8''<percent-encoded><.epub>
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 解码失败则回退 */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/);
  if (plain) return plain[1];
  return `${fallback}.epub`;
}
```

替换 `return <div>placeholder</div>;` 为完整弹窗 JSX:

```tsx
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-gold-400/15 bg-ink-800 p-6 shadow-2xl">
        <h3 className="font-display text-lg text-cream">导出</h3>

        {phase === 'loading' && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gold-400/30 border-t-gold-400" />
            <p className="text-sm text-cream-muted">正在导出,请稍候…</p>
          </div>
        )}

        {phase === 'success' && (
          <div className="mt-4">
            <p className="text-sm text-cream-muted">导出完成</p>
            <p className="mt-1 truncate text-sm text-gold-200">{filename}</p>
          </div>
        )}

        {phase === 'error' && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {phase === 'error' && (
            <button
              type="button"
              onClick={() => void doExport()}
              className="rounded-full border border-gold-400/25 px-4 py-2 text-sm text-gold-200 transition-colors hover:bg-gold-400/10"
            >
              重试
            </button>
          )}
          {phase === 'success' && (
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-full bg-gold-400 px-4 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-gold-200"
            >
              下载
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={phase === 'loading'}
            className="rounded-full px-4 py-2 text-sm text-cream-muted transition-colors hover:bg-ink-700/60 hover:text-cream disabled:opacity-50"
          >
            {phase === 'success' ? '关闭' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 4: 运行 TypeScript 类型检查**

Run:
```bash
cd web && npx tsc --noEmit
```
Expected: 无新增错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ExportDialog.tsx
git commit -m "feat(web): 新增 ExportDialog 导出弹窗组件"
```

---

### Task 2: Detail 页接入 ExportDialog

**Files:**
- Modify: `web/src/pages/Detail.tsx:327-333`(导出 `<a>` → `<button>`)

**Interfaces:**
- Consumes: `ExportDialog`(Task 1 产出)
- Produces: 无

- [ ] **Step 1: 引入组件 + 状态**

`Detail.tsx` 顶部 import 区加:

```tsx
import { ExportDialog } from '../components/ExportDialog';
```

组件内 state 区(约第 39 行 `const [confirmOpen, setConfirmOpen] = useState(false);` 附近)加:

```tsx
  const [exportOpen, setExportOpen] = useState(false);
```

- [ ] **Step 2: 替换导出 `<a>` 为按钮**

将 Detail.tsx:327-333 的原代码:

```tsx
            <a
              href={`/api/books/${book.id}/export`}
              download
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              导出
            </a>
```

替换为:

```tsx
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              className="rounded-full border border-gold-400/25 px-3 py-1.5 text-sm text-cream-muted transition-colors hover:border-gold-400/50 hover:text-gold-200"
            >
              导出
            </button>
```

- [ ] **Step 3: 渲染 ExportDialog**

在组件返回 JSX 末尾(删除按钮所在 header 之后、关闭 `</div>` 之前)加:

```tsx
      <ExportDialog
        open={exportOpen}
        bookId={book.id}
        bookTitle={book.title}
        onClose={() => setExportOpen(false)}
      />
```

- [ ] **Step 4: 运行 TypeScript 类型检查**

Run:
```bash
cd web && npx tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 5: 手动验证**

浏览器打开一本小书的 Detail 页:
1. 点「导出」→ 弹窗显示「正在导出…」+ 转圈
2. 几秒后显示「导出完成」+ 文件名
3. 点「下载」→ 浏览器保存 .epub
4. 点「关闭」→ 弹窗消失
5. 换一本 664 章大书再测一遍导出

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Detail.tsx
git commit -m "feat(web): Detail 页导出按钮接入弹窗交互"
```
