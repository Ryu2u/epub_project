import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期后端地址：可用 VITE_BACKEND_URL 环境变量覆盖
const backendUrl = process.env.VITE_BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发期：把前端 /api/* 转发到 FastAPI 后端
      '/api': {
        target: backendUrl,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});