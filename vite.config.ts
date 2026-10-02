import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { viewer: 'index.html', game: 'game.html' } } },
});
