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