import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const origin = new URL(baseURL).origin;
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

type Violation = { id: string; impact: string | null; targets: string[][] };

async function audit(page: Page): Promise<Violation[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.map(String)),
  }));
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function devLogin(context: BrowserContext): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await context.request.post("/api/v1/auth/dev", {
    headers: { Origin: origin },
    data: { name: "Accessibility QA", email: `a11y-${suffix}@example.test` },
  });
  expect(response.ok()).toBeTruthy();
  const roomName = `Accessible room ${suffix}`;
  const roomResponse = await context.request.post("/api/v1/rooms", {
    headers: { Origin: origin },
    data: { name: roomName },
  });
  expect(roomResponse.ok()).toBeTruthy();
  return roomName;
}

test("public login has no A/AA violations or viewport overflow", async ({ browser }) => {
  const violations: Record<string, Violation[]> = {};

  for (const viewport of viewports) {
    const context = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name: /continue with workos/i })).toBeVisible();
    await page.screenshot({
      path: `tests/screenshots/a11y-public-${viewport.name}.png`,
      fullPage: true,
    });
    await assertNoHorizontalOverflow(page);
    violations[viewport.name] = await audit(page);
    const join=page.getByRole('button',{name:'Sign in to join',exact:true});
    await expect(join).toBeVisible();
    const localLogin=page.getByRole('button',{name:'Enter local workspace',exact:true});
    await localLogin.scrollIntoViewIfNeeded();
    await expect(localLogin).toBeInViewport({ratio:0.9});
    await context.close();
  }

  console.log("public axe violations", JSON.stringify(violations));
  expect(violations).toEqual({ desktop: [], compact: [], mobile: [] });
});

test("signed room has no A/AA violations or viewport overflow", async ({ browser }) => {
  const violations: Record<string, Violation[]> = {};

  for (const viewport of viewports) {
    const context = await browser.newContext({ baseURL, viewport });
    const roomName = await devLogin(context);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("main").getByText(roomName).first()).toBeVisible();
    await page.screenshot({
      path: `tests/screenshots/a11y-room-${viewport.name}.png`,
      fullPage: true,
    });
    await assertNoHorizontalOverflow(page);
    violations[viewport.name] = await audit(page);
    await context.close();
  }

  console.log("signed axe violations", JSON.stringify(violations));
  expect(violations).toEqual({ desktop: [], compact: [], mobile: [] });
});

test("utility screens have no A/AA violations or viewport overflow", async ({ browser }) => {
  const violations: Record<string, Violation[]> = {};
  const screens = [
    { route: "settings", label: "Settings" },
    { route: "recordings", label: "Recordings" },
  ] as const;

  for (const viewport of [viewports[0], viewports[2]]) {
    const context = await browser.newContext({ baseURL, viewport });
    await devLogin(context);
    const page = await context.newPage();
    for (const screen of screens) {
      await page.goto(`/#/${screen.route}`);
      const main = page.getByRole("main", { name: screen.label });
      await expect(main).toBeVisible();
      await expect(main.getByRole("heading", { name: screen.label, level: 1 })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      violations[`${screen.route}-${viewport.name}`] = await audit(page);
      await page.screenshot({
        path: `.local/screens-${screen.route}${viewport.name === "mobile" ? "-mobile" : ""}.png`,
        fullPage: true,
      });
    }
    await context.close();
  }

  console.log("utility screen axe violations", JSON.stringify(violations));
  expect(violations).toEqual({
    "settings-desktop": [],
    "recordings-desktop": [],
    "settings-mobile": [],
    "recordings-mobile": [],
  });
});

test("settings screen closes with Escape and restores focus", async ({ browser }) => {
  const context = await browser.newContext({ baseURL, viewport: viewports[0] });
  await devLogin(context);
  const page = await context.newPage();
  await page.goto("/");

  const trigger = page.getByRole("button", { name: /audio and video settings/i });
  await trigger.focus();
  await trigger.click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/#\/$/);
  await expect(page.getByRole("main", { name: "Settings" })).toBeHidden();
  await expect(trigger).toBeFocused();

  await context.close();
});
