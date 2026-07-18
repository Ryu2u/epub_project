// TanStack Query hooks

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiUpload, type UploadProgress } from '../api/client';
import type {
  BookDetail,
  BookListResponse,
  ChapterContent,
  UploadResult,
} from '../api/types';
export const booksKey = ['books'] as const;

export function useBooks(q: string, page = 1, size = 20) {
  return useQuery({
    queryKey: [...booksKey, { q, page, size }],
    queryFn: () =>
      apiGet<BookListResponse>(
        `/api/books?q=${encodeURIComponent(q)}&page=${page}&size=${size}`,
      ),
    staleTime: 30_000,
  });
}

export function useBook(id: string | undefined) {
  return useQuery({
    queryKey: ['book', id],
    queryFn: () => apiGet<BookDetail>(`/api/books/${id}`),
    enabled: Boolean(id),
  });
}

export function useChapter(
  bookId: string | undefined,
  chapterId: string | undefined,
  format: 'text' | 'html' = 'text',
) {
  return useQuery({
    queryKey: ['chapter', bookId, chapterId, format],
    queryFn: () =>
      apiGet<ChapterContent>(
        `/api/books/${bookId}/chapters/${chapterId}?format=${format}`,
      ),
    enabled: Boolean(bookId && chapterId),
  });
}

export function useUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (p: UploadProgress) => void;
    }) => apiUpload('/api/books', file, onProgress) as Promise<UploadResult>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

export function useDeleteBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/books/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// 上传/替换书籍封面（POST /api/books/{id}/cover）
export function useUploadCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookId, file }: { bookId: string; file: File }) =>
      apiUpload(`/api/books/${bookId}/cover`, file) as Promise<BookDetail>,
    onSuccess: async (_data, vars) => {
      // 详情：覆盖式更新避免封面闪烁；列表：重新拉取封面
      await qc.invalidateQueries({ queryKey: ['book', vars.bookId] });
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// 删除上传的封面（DELETE /api/books/{id}/cover）
export function useDeleteCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bookId: string) => apiDelete(`/api/books/${bookId}/cover`),
    onSuccess: async (_data, bookId) => {
      await qc.invalidateQueries({ queryKey: ['book', bookId] });
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}