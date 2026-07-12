// 统一的 fetch wrapper + 错误格式解析。

import type { ApiErrorResponse } from './types';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly phase?: string | null;
  readonly existingBookId?: string | null;

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
    // body 不是 JSON，忽略
  }
  return new ApiClientError(message, {
    status: response.status,
    code,
    phase,
    existingBookId,
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    throw await parseError(res);
  }
  return (await res.json()) as T;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'include' });
  if (!res.ok && res.status !== 204) {
    throw await parseError(res);
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export async function apiUpload(
  path: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress({ loaded: ev.loaded, total: ev.total });
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve(xhr.responseText);
        }
      } else {
        // 尝试解析为 ApiError
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
          // ignore
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
    xhr.addEventListener('error', () => {
      reject(new ApiClientError('网络错误', { status: 0, code: 'NETWORK_ERROR' }));
    });
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export function assetUrl(bookId: string, assetId: string): string {
  return `/api/books/${bookId}/assets/${assetId}`;
}