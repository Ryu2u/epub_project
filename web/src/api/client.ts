// 统一的 fetch wrapper + 错误格式解析。
// 将 HTTP 请求封装为类型安全的函数，统一处理错误响应，
// 使业务代码只需关心成功路径，错误由调用方用 try/catch 捕获。

// 导入后端错误响应的类型定义（从 types.ts 镜像后端 Pydantic schema）
import type { ApiErrorResponse } from './types';

// 自定义错误类，继承 JavaScript 内置的 Error。
// 相比普通 Error，额外携带 HTTP 状态码、业务错误码、错误阶段等结构化信息，
// 方便 UI 层根据 code 或 phase 做差异化展示（如"书籍已存在"提示）。
export class ApiClientError extends Error {
  readonly code: string;               // 业务错误码，如 'BOOK_EXISTS'、'NOT_FOUND'
  readonly status: number;             // HTTP 状态码，如 404、500；网络错误时为 0
  readonly phase?: string | null;      // 错误发生的阶段（如 'parsing'），可选
  readonly existingBookId?: string | null; // 上传重复书籍时返回已有书籍的 ID，可选

  // constructor 参数使用"选项对象"模式（opts），避免位置参数过多导致可读性差
  constructor(message: string, opts: {
    status: number;
    code: string;
    phase?: string | null;           // ? 表示可选属性，值可以是 string、null 或 undefined
    existingBookId?: string | null;
  }) {
    super(message);                  // 调用父类 Error 的构造函数，设置 message
    this.name = 'ApiClientError';    // 覆盖 name，方便 console 中快速识别错误类型
    this.status = opts.status;
    this.code = opts.code;
    this.phase = opts.phase;
    this.existingBookId = opts.existingBookId;
  }
}

// 将 HTTP 错误响应解析为 ApiClientError。
// 后端返回的 JSON 结构为 { error: { code, message, phase?, existing_book_id? } }，
// 如果 body 不是 JSON（如 502 网关错误），则回退到 HTTP 状态码文本。
async function parseError(response: Response): Promise<ApiClientError> {
  let code = 'HTTP_ERROR';
  let message = `${response.status} ${response.statusText}`;
  let phase: string | null | undefined;
  let existingBookId: string | null | undefined;
  try {
    // as ApiErrorResponse 是 TypeScript 的"类型断言"（type assertion），
    // 告诉编译器 response.json() 的返回值符合 ApiErrorResponse 接口结构
    const body = (await response.json()) as ApiErrorResponse;
    if (body.error) {
      code = body.error.code;
      message = body.error.message || message;  // 后端 message 为空时回退到 HTTP 状态文本
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

// 泛型函数：<T> 是类型参数，调用时指定 T 即可获得类型安全的返回值。
// 例如 apiGet<BookListResponse>('/api/books') 返回 Promise<BookListResponse>。
export async function apiGet<T>(path: string): Promise<T> {
  // credentials: 'include' 让浏览器在跨域请求中也携带 Cookie（如 session token）
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    // res.ok 是 HTTP 状态码 200-299 的布尔快捷属性
    throw await parseError(res);
  }
  // 返回的 JSON 强制断言为泛型 T，保证调用方拿到正确类型
  return (await res.json()) as T;
}

// DELETE 请求不需要返回值，所以返回 Promise<void>
export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'include' });
  // 204 No Content 是 DELETE 成功的常见状态码，此时 res.ok 为 false，需要特殊放行
  if (!res.ok && res.status !== 204) {
    throw await parseError(res);
  }
}

// PATCH 请求：部分更新，发送 JSON body，返回解析后的 JSON。
// 204 No Content 时返回 undefined（用于 reorder 等无返回体的端点）。
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
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

// 文件上传使用 XMLHttpRequest 而非 fetch，因为 fetch 不支持上传进度事件（upload.onprogress）。
// onProgress 回调让 UI 可以实时显示上传百分比。
// 返回 unknown 而非具体类型，因为调用方会用 as Promise<UploadResult> 做类型断言。
export async function apiUpload(
  path: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,  // 可选的进度回调
): Promise<unknown> {
  // 用 Promise 包装 XHR 回调风格的 API，使其可以被 async/await 使用
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);

    // 监听上传进度事件（仅在发送有 body 的请求时触发）
    xhr.upload.addEventListener('progress', (ev) => {
      // ev.lengthComputable 为 false 表示服务器未返回 Content-Length，无法计算进度
      if (ev.lengthComputable && onProgress) {
        onProgress({ loaded: ev.loaded, total: ev.total });
      }
    });

    // 请求完成（注意：load 事件在 HTTP 错误状态码如 400/500 时也会触发，不像 fetch 会 reject）
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // 成功：尝试解析 JSON，如果响应体为空则返回原始文本
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve(xhr.responseText);
        }
      } else {
        // 失败：手动解析错误结构（逻辑与 parseError 相同，但 XHR 没有 Response 对象）
        let code = 'HTTP_ERROR';
        let message = `${xhr.status} ${xhr.statusText}`;
        let phase: string | null | undefined;
        let existingBookId: string | null | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as ApiErrorResponse;
          if (body.error) {
            code = body.error.code;
            message = body.error.message || message;
            phase = body.error.phase;
            existingBookId = body.error.existing_book_id;
          }
        } catch {
          // ignore —— 非 JSON 响应体
        }
        reject(
          new ApiClientError(message, {
            status: xhr.status,
            code,
            phase,
            existingBookId,
          }),
        );
      }
    });

    // 网络层错误（断网、DNS 失败等），此时 status 为 0
    xhr.addEventListener('error', () => {
      reject(new ApiClientError('网络错误', { status: 0, code: 'NETWORK_ERROR' }));
    });

    // FormData 用于构建 multipart/form-data 请求体，这是文件上传的标准格式
    const formData = new FormData();
    formData.append('file', file);   // 'file' 对应后端的字段名
    xhr.send(formData);
  });
}

// 生成书籍资源（图片等）的 URL 路径，供 <img src> 等使用。
// 注意：这里返回的是相对路径，浏览器会自动拼接当前域名。
export function assetUrl(bookId: string, assetId: string): string {
  return `/api/books/${bookId}/assets/${assetId}`;
}

// ==================== 异步导入/导出 + SSE 进度 ====================

/// 进度快照（与后端 Progress 镜像）。phase 是阶段名（"parsing" / "writing_chapters" 等），
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
  /// 导出任务完成后返回的下载 URL（导入任务为空）
  download_url?: string | null;
}

/// 异步导入一本书：上传到 /api/books/async 后立即返回 {task_id}。
/// `onProgress(loaded, total)` 是字节上传进度，任务本身的处理进度请用
/// `subscribeProgress(task_id, ...)` 订阅。
export function startImportAsync(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ task_id: string }> {
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

/// 异步导出：POST /api/books/{id}/export/async?format=，返回 {task_id}。
/// 完成后用 task_id 调 downloadTask 或直接 GET download_url。
export async function startExportAsync(
  bookId: string,
  format: ExportFormat = 'epub',
): Promise<{ task_id: string }> {
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

/// 订阅任务的实时进度（SSE）。返回取消订阅的函数。
/// 任务完成后（progress.done = true）自动关闭连接。
export function subscribeProgress(
  taskId: string,
  onUpdate: (p: TaskProgress) => void,
  onError?: (err: Event) => void,
): () => void {
  const url = `/api/progress/${encodeURIComponent(taskId)}`;
  const es = new EventSource(url, { withCredentials: true });
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as TaskProgress;
      onUpdate(data);
      if (data.done) es.close();
    } catch (e) {
      // 忽略单帧解析错误,继续接收后续帧
    }
  };
  es.onerror = (ev) => {
    onError?.(ev);
    es.close();
  };
  return () => es.close();
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