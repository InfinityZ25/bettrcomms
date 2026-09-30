import { defineConfig } from '@playwright/test';
import config from './playwright.config';

// Exercise the optimized assets that are embedded in the native app too.
// Run against the usual local API/database; an explicit E2E_BASE_URL can
// point to a separately running preview with its own isolated API.
export default defineConfig({
  ...config,
  testMatch: 'mobile-sheets.spec.ts',
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command:
          'npm exec --workspace apps/web -- vite preview --host 127.0.0.1 --port 5173 --strictPort',
        url: 'http://127.0.0.1:5173',
        reuseExistingServer: false,
      },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'webkit',
      use: { browserName: 'webkit', launchOptions: { args: [] } },
    },
  ],
});
