import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import DetailPage from './pages/Detail';
import LibraryPage from './pages/Library';
import ReaderPage from './pages/Reader';
import UploadPage from './pages/Upload';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/books/:id" element={<DetailPage />} />
          <Route
            path="/books/:bookId/chapters/:chapterId"
            element={<ReaderPage />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}