import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 不依赖 process / @types/node：loadEnv 内部读取 .env.*，我们自己处理 VITE_BACKEND_URL
  const env = loadEnv(mode, './', '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:8002';

  return {
    plugins: [react()],
    // Tauri 要求固定端口 + 清屏关闭;devUrl 与 tauri.conf.json 一致。
    // 端口不用 Tauri 惯用的 1420,也不用 Vite 默认的 5173 —— 本机上它们都会踩坑:
    //   1) 1420 落在 Windows 的系统保留段内(Hyper-V/WSL 的 winnat 动态保留,
    //      本机实测 1371-1470 被保留)→ 绑定直接 EACCES,tauri dev 起不来;
    //   2) 本机的动态(临时)端口池是 1024-15000(netsh int ipv4 show dynamicport tcp),
    //      池内端口随时可能被出站连接占走 → 偶发 EADDRINUSE。
    // 15173 同时避开了保留段与临时端口池,是稳定的固定端口。
    clearScreen: false,
    server: {
      // 监听所有网卡:浏览器开发时同一局域网内的手机/平板可直接访问
      host: true,
      port: 15173,
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