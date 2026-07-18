// TanStack Query hooks —— 将后端 API 调用封装为 React hooks。
// 为什么抽成 hooks：
//   1. 自动管理加载/错误/成功状态（isLoading/error/data）
//   2. 内置请求缓存与去重（相同 queryKey 的请求自动合并）
//   3. 提供失效机制（mutation 成功后自动刷新相关查询）
//   4. 组件只需调用 hook 即可获取数据，无需关心请求细节

// useQuery 用于 GET 请求（查询），useMutation 用于 POST/PUT/DELETE（变更）。
// useQueryClient 获取缓存管理器，用于手动失效/更新缓存。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiUpload, type UploadProgress } from '../api/client';
import type {
  BookDetail,
  BookListResponse,
  BookUpdate,
  ChapterContent,
  ChapterReorder,
  ChapterUpdate,
  UploadResult,
} from '../api/types';

// queryKey 是缓存的唯一标识。用 as const 断言为只读元组类型，
// 确保 TypeScript 将其推断为 readonly ['books'] 而非 string[]，
// 这样在 invalidateQueries 等 API 中可以获得更精确的类型检查。
export const booksKey = ['books'] as const;

// 书籍列表查询 hook。参数 q（搜索关键词）、page（页码）、size（每页条数）
// 都作为 queryKey 的一部分，任何一个变化都会触发新的请求并独立缓存。
export function useBooks(q: string, page = 1, size = 20) {
  return useQuery({
    // queryKey 使用展开运算符 ...booksKey 拼接额外参数，
    // 最终缓存键类似 ['books', { q: 'xxx', page: 1, size: 20 }]
    queryKey: [...booksKey, { q, page, size }],
    // queryFn 是实际执行请求的函数，必须返回 Promise
    queryFn: () =>
      apiGet<BookListResponse>(
        `/api/books?q=${encodeURIComponent(q)}&page=${page}&size=${size}`,
      ),
    // staleTime: 数据在 30 秒内视为"新鲜"，期间不会自动重新请求。
    // 适合书籍列表这种变化不频繁的场景，减少不必要的网络请求。
    staleTime: 30_000,
  });
}

// 单本书详情查询 hook。id 可能为 undefined（路由参数未加载时），
// enabled: Boolean(id) 确保 id 为空时不发起请求，避免无意义的 404。
export function useBook(id: string | undefined) {
  return useQuery({
    queryKey: ['book', id],
    queryFn: () => apiGet<BookDetail>(`/api/books/${id}`),
    enabled: Boolean(id), // 条件启用：id 有值时才执行查询
  });
}

// 章节内容查询 hook。
// format 参数决定后端返回纯文本还是 HTML，默认 'text'。
// bookId 和 chapterId 同时存在时才启用查询。
export function useChapter(
  bookId: string | undefined,
  chapterId: string | undefined,
  format: 'text' | 'html' = 'text',
) {
  return useQuery({
    // 三个参数都作为缓存键，切换章节或格式都会自动请求新数据
    queryKey: ['chapter', bookId, chapterId, format],
    queryFn: () =>
      apiGet<ChapterContent>(
        `/api/books/${bookId}/chapters/${chapterId}?format=${format}`,
      ),
    enabled: Boolean(bookId && chapterId), // 两个 ID 都存在时才启用
  });
}

// 上传书籍的 mutation hook。
// mutationFn 接收一个对象参数 { file, onProgress }，解构后传给 apiUpload。
// onSuccess 在上传成功后调用 qc.invalidateQueries，将书籍列表缓存标记为"过期"，
// 触发自动重新请求，使新上传的书籍出现在列表中。
export function useUpload() {
  const qc = useQueryClient(); // 获取缓存管理器实例
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (p: UploadProgress) => void; // 可选的上传进度回调
    }) => apiUpload('/api/books', file, onProgress) as Promise<UploadResult>,
    onSuccess: () => {
      // invalidateQueries 将匹配 booksKey 的缓存标记为 stale，
      // 下次组件挂载或窗口聚焦时会自动重新请求最新数据
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// 删除书籍的 mutation hook。
export function useDeleteBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/books/${id}`),
    onSuccess: () => {
      // 删除成功后刷新列表缓存
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// 上传/替换书籍封面（POST /api/books/{id}/cover）
export function useUploadCover() {
  const qc = useQueryClient();
  return useMutation({
    // mutationFn 的参数类型用对象解构，包含 bookId（用于请求路径）和 file（上传的图片）
    mutationFn: ({ bookId, file }: { bookId: string; file: File }) =>
      apiUpload(`/api/books/${bookId}/cover`, file) as Promise<BookDetail>,
    onSuccess: async (_data, vars) => {
      // _data 是 mutationFn 的返回值（此处不需要使用，用下划线前缀是惯例）
      // vars 是 mutationFn 的输入参数，此处用 vars.bookId 指定要失效的详情缓存
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
      // bookId 直接作为第二个参数传入（单参数 mutationFn 时，vars 就是那个参数）
      await qc.invalidateQueries({ queryKey: ['book', bookId] });
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// ========== 编辑功能 hooks ==========

// 部分更新书籍元数据（标题、作者、简介等）
export function useUpdateBook(bookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BookUpdate) =>
      apiPatch<BookDetail>(`/api/books/${bookId}`, data),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['book', bookId] });
      qc.invalidateQueries({ queryKey: booksKey });
    },
  });
}

// 更新章节标题和/或正文
export function useUpdateChapter(bookId: string, chapterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ChapterUpdate) =>
      apiPatch<ChapterContent>(`/api/books/${bookId}/chapters/${chapterId}`, data),
    onSuccess: async () => {
      // 章节内容可能变了，失效 book 详情 + 所有章节缓存
      await qc.invalidateQueries({ queryKey: ['book', bookId] });
      qc.invalidateQueries({ queryKey: ['chapter', bookId] });
    },
  });
}

// 批量重排章节顺序
export function useReorderChapters(bookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chapterIds: string[]) =>
      apiPatch<void>(`/api/books/${bookId}/chapters/reorder`, {
        chapter_ids: chapterIds,
      } satisfies ChapterReorder),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['book', bookId] });
    },
  });
}