import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 不依赖 process / @types/node：loadEnv 内部读取 .env.*，我们自己处理 VITE_BACKEND_URL
  const env = loadEnv(mode, './', '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:8002';

  return {
    plugins: [react()],
    // Tauri 要求固定端口 + 清屏关闭;devUrl 与 tauri.conf.json 一致(1420)
    clearScreen: false,
    server: {
      // 监听所有网卡:浏览器开发时同一局域网内的手机/平板可直接访问
      host: true,
      port: 1420,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
    // Tauri WebView 环境的构建目标(Windows WebView2 / macOS WKWebView)
    build: {
      target: 'chrome110',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});