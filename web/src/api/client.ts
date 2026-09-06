// 统一的 API 层:浏览器(HTTP)与 Tauri 桌面客户端(invoke)双模式。
//
// 对外函数签名与原 HTTP 版完全一致(页面/组件零改动):
//   - 浏览器模式:fetch /api/* (原行为)
//   - Tauri 模式:把每个 HTTP 端点路由到对应的 #[tauri::command]
//     (src-tauri/src/commands.rs),包括:
//       GET    /api/books                          -> list_books
//       GET    /api/books/:id                      -> get_book
//       GET    /api/books/:id/chapters/:cid        -> get_chapter
//       GET    /api/books/:id/search               -> search_in_book
//       POST   /api/books | /cover                 -> upload_book / upload_cover
//       DELETE /api/books/:id | /cover             -> delete_book / delete_cover
//       PATCH  /api/books/:id | chapters/*         -> update_book / update_chapter / reorder
//       异步任务(导入/导出/删除)                   -> *_async 命令 + get_progress 轮询
//       资源图片/字体                               -> epubasset 自定义协议(assetUrl)
// 错误形状两端一致({code,message,existing_book_id} → ApiClientError)。

// 导入后端错误响应的类型定义（从 types.ts 镜像后端 schema）
import type { ApiErrorResponse } from './types';

// 自定义错误类，继承 JavaScript 内置的 Error。
// 相比普通 Error，额外携带状态码、业务错误码、错误阶段等结构化信息，
// 方便 UI 层根据 code 或 phase 做差异化展示（如"书籍已存在"提示）。
export class ApiClientError extends Error {
  readonly code: string;               // 业务错误码，如 'DUPLICATE_FILE'、'NOT_FOUND'
  readonly status: number;             // HTTP 状态码;Tauri invoke 失败时为 0
  readonly phase?: string | null;      // 错误发生的阶段（如 'parsing'），可选
  readonly existingBookId?: string | null; // 上传重复书籍时返回已有书籍的 ID，可选

  constructor(message: string, opts: {
    status: number;
    code: string;
    phase?: string | null;
    existingBookId?: string | null;
  }) {
    super(message);
    this.name = 'ApiClientError';
    this.status = opts.status;
    this.code = opts.code;
    this.phase = opts.phase;
    this.existingBookId = opts.existingBookId;
  }
}

// ==================== Tauri 模式检测与 invoke 封装 ====================

/// 是否运行在 Tauri WebView 里(桌面客户端)
const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/// invoke 包装:CmdError({code,message,existing_book_id}) → ApiClientError,
/// 保持与 HTTP parseError 相同的错误形状,ErrorBanner 无感兼容。
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const ce = e as { code?: string; message?: string; existing_book_id?: string };
    if (ce && typeof ce.code === 'string') {
      throw new ApiClientError(ce.message ?? ce.code, {
        status: 0,
        code: ce.code,
        existingBookId: ce.existing_book_id ?? null,
      });
    }
    throw new ApiClientError(e instanceof Error ? e.message : String(e), {
      status: 0,
      code: 'TAURI_INVOKE_ERROR',
    });
  }
}

/// 解析相对路径(/api/...)的 segments 与 query(用伪 origin 借 URL 解析)
function parseApiPath(path: string): { segs: string[]; params: URLSearchParams } {
  const u = new URL(path, 'http://epub.local');
  const segs = u.pathname.split('/').filter(Boolean); // ['api','books',...]
  return { segs, params: u.searchParams };
}

// ==================== HTTP 错误解析 ====================

// 将 HTTP 错误响应解析为 ApiClientError。
async function parseError(response: Response): Promise<ApiClientError> {
  let code = 'HTTP_ERROR';
  let message = `${response.status} ${response.statusText}`;
  let phase: string | null | undefined;
  let existingBookId: string | null | undefined;
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (body.error) {
      code = body.error.code;
      message = body.error.message || message;
      phase = body.error.phase;
      existingBookId = body.error.existing_book_id;
    }
  } catch {
    // body 不是 JSON，忽略解析错误，使用默认的 HTTP 错误信息
  }
  return new ApiClientError(message, {
    status: response.status,
    code,
    phase,
    existingBookId,
  });
}

// ==================== 通用请求函数(双模式) ====================

export async function apiGet<T>(path: string): Promise<T> {
  if (isTauri) {
    const { segs, params } = parseApiPath(path);
    if (segs.length === 2 && segs[1] === 'books') {
      return tauriInvoke<T>('list_books', {
        q: params.get('q') ?? '',
        page: Number(params.get('page') ?? '1') || 1,
        size: Number(params.get('size') ?? '20') || 20,
      });
    }
    if (segs.length === 3 && segs[1] === 'books') {
      return tauriInvoke<T>('get_book', { bookId: segs[2] });
    }
    if (segs.length === 5 && segs[1] === 'books' && segs[3] === 'chapters') {
      return tauriInvoke<T>('get_chapter', {
        bookId: segs[2],
        chapterId: segs[4],
        format: params.get('format') ?? 'text',
      });
    }
    if (segs.length === 4 && segs[1] === 'books' && segs[3] === 'search') {
      return tauriInvoke<T>('search_in_book', {
        bookId: segs[2],
        q: params.get('q') ?? '',
        page: Number(params.get('page') ?? '1') || 1,
        size: Number(params.get('size') ?? '20') || 20,
      });
    }
    throw new ApiClientError(`Tauri 模式未映射的 GET 路径: ${path}`, {
      status: 0,
      code: 'UNMAPPED_ROUTE',
    });
  }

  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    throw await parseError(res);
  }
  return (await res.json()) as T;
}

// DELETE 请求:书删除 / 封面删除
export async function apiDelete(path: string): Promise<void> {
  if (isTauri) {
    const { segs } = parseApiPath(path);
    if (segs.length === 3 && segs[1] === 'books') {
      await tauriInvoke<boolean>('delete_book', { bookId: segs[2] });
      return;
    }
    if (segs.length === 4 && segs[1] === 'books' && segs[3] === 'cover') {
      await tauriInvoke<boolean>('delete_cover', { bookId: segs[2] });
      return;
    }
    throw new ApiClientError(`Tauri 模式未映射的 DELETE 路径: ${path}`, {
      status: 0,
      code: 'UNMAPPED_ROUTE',
    });
  }

  const res = await fetch(path, { method: 'DELETE', credentials: 'include' });
  // 204 No Content 是 DELETE 成功的常见状态码
  if (!res.ok && res.status !== 204) {
    throw await parseError(res);
  }
}

// PATCH 请求:元数据更新 / 章节更新 / 章节重排。
// 204 No Content 时返回 undefined(用于 reorder 等无返回体的端点)。
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  if (isTauri) {
    const { segs } = parseApiPath(path);
    if (segs.length === 3 && segs[1] === 'books') {
      return tauriInvoke<T>('update_book', { bookId: segs[2], data: body });
    }
    if (
      segs.length === 5 &&
      segs[1] === 'books' &&
      segs[3] === 'chapters' &&
      segs[4] === 'reorder'
    ) {
      const payload = body as { chapter_ids: string[] };
      return tauriInvoke<T>('reorder_chapters', {
        bookId: segs[2],
        chapterIds: payload.chapter_ids,
      });
    }
    if (segs.length === 5 && segs[1] === 'books' && segs[3] === 'chapters') {
      return tauriInvoke<T>('update_chapter', {
        bookId: segs[2],
        chapterId: segs[4],
        data: body,
      });
    }
    throw new ApiClientError(`Tauri 模式未映射的 PATCH 路径: ${path}`, {
      status: 0,
      code: 'UNMAPPED_ROUTE',
    });
  }

  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await parseError(res);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// 上传进度回调的类型：loaded 是已上传字节数，total 是文件总字节数
export interface UploadProgress {
  loaded: number;
  total: number;
}

// 文件上传:浏览器走 XHR(支持字节进度);Tauri 走 invoke(本地读取,
// 字节进度一次性完成,服务端处理进度仍由 subscribeProgress 提供)。
export async function apiUpload(
  path: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,  // 可选的进度回调
): Promise<unknown> {
  if (isTauri) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    onProgress?.({ loaded: file.size, total: file.size });
    const { segs } = parseApiPath(path);
    if (segs.length === 2 && segs[1] === 'books') {
      return tauriInvoke('upload_book', { filename: file.name, bytes });
    }
    if (segs.length === 4 && segs[1] === 'books' && segs[3] === 'cover') {
      return tauriInvoke('upload_cover', {
        bookId: segs[2],
        bytes,
        mediaType: file.type || 'application/octet-stream',
      });
    }
    throw new ApiClientError(`Tauri 模式未映射的上传路径: ${path}`, {
      status: 0,
      code: 'UNMAPPED_ROUTE',
    });
  }

  // 用 Promise 包装 XHR 回调风格的 API
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);

    // 监听上传进度事件（仅在发送有 body 的请求时触发）
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress({ loaded: ev.loaded, total: ev.total });
      }
    });

    // load 事件在 HTTP 错误状态码时也会触发,手动解析错误结构
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve(xhr.responseText);
        }
      } else {
        reject(parseXhrError(xhr));
      }
    });

    // 网络层错误（断网、DNS 失败等），此时 status 为 0
    xhr.addEventListener('error', () => {
      reject(new ApiClientError('网络错误', { status: 0, code: 'NETWORK_ERROR' }));
    });

    // FormData 用于构建 multipart/form-data 请求体，文件上传的标准格式
    const formData = new FormData();
    formData.append('file', file);   // 'file' 对应后端的字段名
    xhr.send(formData);
  });
}

// 生成书籍资源（图片等）的 URL 路径:
// - 浏览器:/api/books/{id}/assets/{aid}(走 HTTP)
// - Tauri :epubasset 自定义协议(Windows 下是 http://epubasset.localhost/...,
//   与 src-tauri/src/commands.rs::asset_url 同构)
export function assetUrl(bookId: string, assetId: string): string {
  if (isTauri) {
    if (navigator.userAgent.includes('Windows')) {
      return `http://epubasset.localhost/books/${bookId}/assets/${assetId}`;
    }
    return `epubasset://localhost/books/${bookId}/assets/${assetId}`;
  }
  return `/api/books/${bookId}/assets/${assetId}`;
}

// ==================== 异步导入/导出/删除 + SSE 进度 ====================

/// 进度快照（与后端 Progress 镜像）。phase 是阶段名
/// （"parsing" / "writing_chapters" / "deleting_chapters" ...），
/// message 是人类可读描述，percent 0-100。
export interface TaskProgress {
  phase: string;
  message: string;
  percent: number;
  done: boolean;
  error_code?: string | null;
  error_message?: string | null;
  /// 上传重复文件时携带的已有 book id
  existing_book_id?: string | null;
  /// 导出任务完成后返回的下载 URL（导入任务为空;Tauri 模式改用
  /// fetchExportFile(taskId) 取文件,该字段仅作完成标志）
  download_url?: string | null;
}

/// 异步导入一本书:Tauri 走 upload_book_async(本地读字节,进度由
/// get_progress 轮询提供);浏览器上传到 /api/books/async。
/// `onProgress(loaded, total)` 是字节上传进度。
export function startImportAsync(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ task_id: string }> {
  if (isTauri) {
    return (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      onProgress?.(file.size, file.size);
      return tauriInvoke<{ task_id: string }>('upload_book_async', {
        filename: file.name,
        bytes,
      });
    })();
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/books/async');
    if (onProgress) {
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
      });
    }
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error(`解析响应失败: ${(e as Error).message}`));
        }
      } else {
        reject(parseXhrError(xhr));
      }
    });
    xhr.addEventListener('error', () => {
      reject(new ApiClientError('网络错误', { status: 0, code: 'NETWORK_ERROR' }));
    });
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/// 导出格式：epub（重建 EPUB 3）/ txt（标题顶格、正文段首两个全角空格）。
export type ExportFormat = 'epub' | 'txt';

/// 异步导出:两模式下均返回 {task_id},完成后用 fetchExportFile 取文件。
export async function startExportAsync(
  bookId: string,
  format: ExportFormat = 'epub',
): Promise<{ task_id: string }> {
  if (isTauri) {
    return tauriInvoke<{ task_id: string }>('export_book_async', {
      bookId,
      format,
    });
  }
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/export/async?format=${format}`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  if (!res.ok) {
    throw await parseError(res);
  }
  return (await res.json()) as { task_id: string };
}

/// 异步删除:大书删除(级联删章节 + FTS + 文件 + COS)耗时可观。
export async function startDeleteAsync(
  bookId: string,
): Promise<{ task_id: string }> {
  if (isTauri) {
    return tauriInvoke<{ task_id: string }>('delete_book_async', { bookId });
  }
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/delete/async`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  if (!res.ok) {
    throw await parseError(res);
  }
  return (await res.json()) as { task_id: string };
}

/// 订阅任务的实时进度。浏览器 = SSE;Tauri = 200ms 轮询 get_progress
/// (与原 SSE 推送节奏一致)。返回取消订阅的函数;任务完成后自动停止。
export function subscribeProgress(
  taskId: string,
  onUpdate: (p: TaskProgress) => void,
  onError?: (err: unknown) => void,
): () => void {
  if (isTauri) {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    };
    const poll = async () => {
      if (stopped) return;
      try {
        const p = await tauriInvoke<TaskProgress | null>('get_progress', { taskId });
        if (stopped) return;
        if (p === null) {
          // 任务不存在(已过期清理)或尚未注册——视为连接错误
          stop();
          onError?.(new Error('task not found'));
          return;
        }
        onUpdate(p);
        if (p.done) stop();
      } catch (e) {
        if (!stopped) {
          stop();
          onError?.(e);
        }
      }
    };
    void poll();
    timer = setInterval(poll, 200);
    return stop;
  }

  const url = `/api/progress/${encodeURIComponent(taskId)}`;
  const es = new EventSource(url, { withCredentials: true });
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as TaskProgress;
      onUpdate(data);
      if (data.done) es.close();
    } catch {
      // 忽略单帧解析错误,继续接收后续帧
    }
  };
  es.onerror = (ev) => {
    onError?.(ev);
    es.close();
  };
  return () => es.close();
}

/// 取导出文件:浏览器 fetch download_url;Tauri 用 task_id 取文件名+字节。
/// 返回 { blob, filename },调用方走 <a download> 触发保存。
export async function fetchExportFile(
  downloadUrl: string | null,
  taskId: string,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  if (isTauri) {
    const filename =
      (await tauriInvoke<string | null>('get_export_filename', { taskId })) ??
      fallbackName;
    const buf = await tauriInvoke<ArrayBuffer>('take_export_bytes', { taskId });
    return { blob: new Blob([buf]), filename };
  }
  if (!downloadUrl) throw new Error('导出未返回文件');
  const res = await fetch(downloadUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const filename = parseFilename(res.headers.get('Content-Disposition'), fallbackName);
  return { blob, filename };
}

/// 从 Content-Disposition 解析文件名（后端 filename* UTF-8'' 编码）。
function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
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
  return fallback;
}

function parseXhrError(xhr: XMLHttpRequest): ApiClientError {
  let code = 'HTTP_ERROR';
  let message = `${xhr.status} ${xhr.statusText}`;
  try {
    const body = JSON.parse(xhr.responseText) as ApiErrorResponse;
    if (body.error) {
      code = body.error.code;
      message = body.error.message || message;
    }
  } catch {
    /* non-JSON */
  }
  return new ApiClientError(message, { status: xhr.status, code });
}
