import { expect, test } from "vibehard/playwright";

test("home page prices, counts, and saves a note", async ({ page }) => {
  await page.goto("/?cents=2500");
  await expect(page.getByTestId("total")).toHaveText("$25.00");
  await page.getByTestId("add").click();
  await expect(page.getByTestId("note")).toHaveText("CLICK 1");
});

test("price api applies a discount", async ({ request }) => {
  const response = await request.get("/api/price?cents=10000&discount=25");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({
    cents: 7500,
    formatted: "$75.00",
  });
});

test("legacy pages route renders per request", async ({ page }) => {
  await page.goto("/legacy?cents=750");
  await expect(page.getByTestId("legacy-total")).toHaveText("$7.50");
});

test("pages api greets by name", async ({ request }) => {
  const response = await request.get("/api/hello?name=ada");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ hello: "ADA" });
});
