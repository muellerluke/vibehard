import { expect, test } from "vibehard/playwright";

// Vibehard exports each labeled server's URL as VIBEHARD_<NAME>_URL.
// For a plain `playwright test` run, start the API on its default port.
const apiUrl = process.env["VIBEHARD_API_URL"] ?? "http://127.0.0.1:4100";

test("product page shows the api price", async ({ page }) => {
  await page.goto("/?sku=notebook");
  await expect(page.getByTestId("name")).toHaveText("Notebook");
  await expect(page.getByTestId("price")).toHaveText("$5.00");
});

test("order api prices an order", async ({ request }) => {
  const response = await request.post(`${apiUrl}/api/orders`, {
    data: { sku: "pen", quantity: 2 },
  });
  expect(response.status()).toBe(201);
  await expect(response.json()).resolves.toEqual({
    sku: "pen",
    totalCents: 2598,
  });
});
