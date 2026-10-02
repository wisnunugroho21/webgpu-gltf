import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  timeout: 30_000,
  use: {
    channel: process.env.GPU_BROWSER_CHANNEL ?? 'msedge',
    headless: true,
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1200, height: 850 },
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
