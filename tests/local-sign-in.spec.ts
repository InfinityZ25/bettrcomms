import { expect, test } from '@playwright/test';
import { openSettingsCategory } from './settings-navigation';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const origin = new URL(baseURL).origin;

for (const viewport of [
  { label: 'desktop', width: 1280, height: 720 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`local sign-in is reachable immediately and opens character settings on ${viewport.label}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL, viewport });
    try {
      const page = await context.newPage();
      const providerRequests: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/auth/login') providerRequests.push(request.url());
      });
      await page.goto('/');
      const form = page.getByRole('form', { name: 'Local workspace sign-in', exact: true });
      const submit = form.getByRole('button', { name: 'Enter local workspace', exact: true });
      await expect(submit).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole('textbox', { name: 'Your name', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(form.getByRole('textbox', { name: 'Your email', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByText('A WorkOS account is not required.', { exact: false })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`local-sign-in-${viewport.label}.png`), fullPage: true });

      const name = `Local ${viewport.label} QA`;
      const email = `local-sign-in-${viewport.label}-${Date.now()}@example.test`;
      await form.getByRole('textbox', { name: 'Your name', exact: true }).fill(name);
      await form.getByRole('textbox', { name: 'Your email', exact: true }).fill(email);
      const response = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/v1/auth/dev');
      await submit.click();
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('button', { name: `${name} and account options`, exact: true })).toBeVisible();
      expect(providerRequests).toEqual([]);
      const profile = await openSettingsCategory(page, 'Profile');
      await expect(profile.getByRole('region', { name: 'Your character', exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: `${name} and account options`, exact: true })).toBeVisible();
      expect(providerRequests).toEqual([]);
    } finally {
      await context.request.post('/api/v1/auth/logout', { headers: { Origin: origin }, data: {} });
      await context.close();
    }
  });
}
