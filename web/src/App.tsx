// TanStack Query（原 React Query）：管理服务端状态（缓存、请求、失效、重试等）。
// QueryClient 是整个缓存的管理实例，所有 useQuery/useMutation 共享同一个客户端。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// react-router-dom 提供客户端路由，BrowserRouter 基于 HTML5 History API（无 hash）。
// Routes/Route 声明路径与页面组件的映射，Navigate 用于重定向。
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
// 各页面级组件（按功能拆分到独立文件）
import DetailPage from './pages/Detail';
import LibraryPage from './pages/Library';
import ReaderPage from './pages/Reader';
import UploadPage from './pages/Upload';

// 创建 QueryClient 实例，整个应用生命周期内只创建一次（放在组件外部，避免每次渲染重建）。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,                    // 请求失败时只重试 1 次（默认 3 次），减少无效请求
      refetchOnWindowFocus: false, // 禁止窗口重新获得焦点时自动重新请求（默认 true），避免阅读时频繁请求
    },
  },
});

export default function App() {
  return (
    // QueryClientProvider 将 queryClient 注入 React Context，子组件中所有 useQuery/useMutation 都能访问缓存
    <QueryClientProvider client={queryClient}>
      {/* BrowserRouter 包裹整个应用，启用客户端路由 */}
      <BrowserRouter>
        {/* Routes 是路由匹配容器，内部的 Route 按顺序匹配，第一个匹配的生效 */}
        <Routes>
          {/* 首页：书籍库列表 */}
          <Route path="/" element={<LibraryPage />} />
          {/* 上传页面 */}
          <Route path="/upload" element={<UploadPage />} />
          {/* 书籍详情页，:id 是动态路由参数，通过 useParams 获取 */}
          <Route path="/books/:id" element={<DetailPage />} />
          {/* 阅读器页面，同时包含 bookId 和 chapterId 两个动态参数 */}
          <Route
            path="/books/:bookId/chapters/:chapterId"
            element={<ReaderPage />}
          />
          {/* 通配路由：所有未匹配的路径都重定向到首页，replace 表示替换历史记录而非新增 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}