import { expect, test } from "vibehard/playwright";

import { appShell } from "./uses.js";

test("home page prices, counts, and saves a note", {
  uses: [...appShell, 'src/app/actions.ts#saveNote', 'src/app/counter/Counter.tsx#Counter', 'src/app/page.tsx#HomePage', 'src/lib/notes.ts#normalizeNote', 'src/lib/pricing.ts#formatPrice'],
}, async ({ page }) => {
  await page.goto("/?cents=2500");
  await expect(page.getByTestId("total")).toHaveText("$25.00");
  await page.getByTestId("add").click();
  await expect(page.getByTestId("note")).toHaveText("CLICK 1");
});

test("price api applies a discount", {
  uses: [
    'src/app/api/price/route.ts#GET',
    'src/lib/pricing.ts#applyDiscount',
    'src/lib/pricing.ts#formatPrice',
  ],
}, async ({ request }) => {
  const response = await request.get("/api/price?cents=10000&discount=25");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({
    cents: 7500,
    formatted: "$75.00",
  });
});

test("legacy pages route renders per request", {
  uses: [
    'src/lib/pricing.ts#formatPrice',
    'src/pages/legacy.tsx#LegacyPage',
    'src/pages/legacy.tsx#getServerSideProps',
  ],
}, async ({ page }) => {
  await page.goto("/legacy?cents=750");
  await expect(page.getByTestId("legacy-total")).toHaveText("$7.50");
});

test("pages api greets by name", {
  uses: [
    'src/lib/notes.ts#normalizeNote',
    'src/pages/api/hello.ts#handler',
  ],
}, async ({ request }) => {
  const response = await request.get("/api/hello?name=ada");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ hello: "ADA" });
});
