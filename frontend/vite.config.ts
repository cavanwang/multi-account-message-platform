/**
 * Vite 配置（开发环境）。
 * 生产部署见 Dockerfile：构建产物由 nginx 伺服，/api 与 /ws 由 nginx 反代到 backend。
 * 开发时（npm run dev，端口 5173）通过下面的 proxy 把 /api 与 /ws 转发到本机 3000 的后端，
 * 这样前端始终同源请求，不需要后端开 CORS。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
