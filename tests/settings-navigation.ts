import { expect, type Page } from '@playwright/test';

/** Opens the current settings UI without reloading the document or its media. */
export async function openSettingsCategory(page: Page, category = 'Voice & devices') {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  if (!await dialog.isVisible()) {
    await page.getByRole('button', { name: /(?:^Account options$| and account options$)/ }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(dialog).toBeVisible();
  }
  const picker = dialog.getByRole('combobox', { name: 'Settings category' });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole('option', { name: category, exact: true }).click();
  } else {
    await dialog.getByRole('button', { name: category, exact: true }).click();
  }
  return dialog;
}
