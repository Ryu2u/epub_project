import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 不依赖 process / @types/node：loadEnv 内部读取 .env.*，我们自己处理 VITE_BACKEND_URL
  const env = loadEnv(mode, './', '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:8002';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
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
  };
});