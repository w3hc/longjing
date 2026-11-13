import { defineConfig, devices } from '@playwright/test';

/**
 * The browser client's e2e test: Chromium only, against Anvil and a local
 * gateway. Run with `pnpm test:browser`, Anvil listening on 127.0.0.1:8545.
 */
export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.e2e.ts',
  timeout: 10 * 60_000,
  workers: 1,
  reporter: process.env.CI ? 'list' : 'line',
  globalSetup: './test/browser/global-setup.ts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
