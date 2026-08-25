import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 不依赖 process / @types/node：loadEnv 内部读取 .env.*，我们自己处理 VITE_BACKEND_URL
  const env = loadEnv(mode, './', '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:8002';

  return {
    plugins: [react()],
    server: {
      // 监听所有网卡：同一局域网内的手机/平板可直接访问 http://<电脑IP>:3000
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      open: true,
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