import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // 独自ドメイン取得後に変更
  site: 'https://zenkoku-interschool.pages.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
