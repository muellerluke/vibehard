import { expect, test } from "vibehard/playwright";

// The store is the config `app` (Playwright baseURL). The admin
// frontend is a labeled `servers` entry; vibehard exports its URL as
// VIBEHARD_ADMIN_URL, and tests navigate to it by absolute URL.
const adminUrl = process.env["VIBEHARD_ADMIN_URL"] ?? "http://127.0.0.1:4176";

test("store page shows the catalog total", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#store-total")).toHaveText("$17.99");
  await expect(page.locator("#store-count")).toHaveText("2 products, $17.99");
});

test("admin page shows the revenue summary", async ({ page }) => {
  await page.goto(`${adminUrl}/`);
  await expect(page.locator("#admin-summary")).toHaveText("revenue $425.00");
  await expect(page.locator("#admin-note")).toHaveText("revenue $425.00");
});

test("shopper journey crosses both frontends", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#store-total")).toHaveText("$17.99");
  await page.goto(`${adminUrl}/`);
  await expect(page.locator("#admin-summary")).toHaveText("revenue $425.00");
});
