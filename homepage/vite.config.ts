import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 网页端部署到 GitHub Pages 建议使用相对路径，防止子路径部署时白屏
  base: './',
});