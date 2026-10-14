import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    include: ['zod', 'react', 'react-dom/client', 'vitest-browser-react'],
  },
  plugins: [react()],
  test: {
    include: ['tests/**/*.browser.spec.tsx'],
    browser: {
      enabled: true,
      api: { host: '127.0.0.1' },
      provider: playwright({
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
            [
              'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
              'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            ].find(existsSync),
        },
      }),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
  },
});
