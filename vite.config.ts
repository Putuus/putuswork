import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 用相对路径：本地直接打开、GitHub Pages 子目录部署都能跑
export default defineConfig({
  base: './',
  plugins: [react()],
  // strictPort: 端口被占时直接报错。悄悄换成 5174 会变成另一个 origin，
  // 用户打开就是一副空数据，看起来就像「记录丢了」。
  server: { host: true, port: 5173, strictPort: true },
  preview: { host: true, port: 4173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
