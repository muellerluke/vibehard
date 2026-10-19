import assert from "node:assert/strict";

import puppeteer from "puppeteer";
import { describeTest, withVibehardPage } from "vibehard/puppeteer";

const baseUrl = process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:4174";

describeTest("home page shows the cart total", async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  try {
    const page = await withVibehardPage(browser);
    await page.goto(`${baseUrl}/?cents=1299`);
    await page.waitForFunction(
      () => document.querySelector("#total")?.textContent === "$30.98",
    );
    const seed = await page.$eval("#seed", (el) => el.textContent);
    assert.equal(seed, "$12.99");
  } finally {
    await browser.close();
  }
});

describeTest("price api applies a discount", async () => {
  const response = await fetch(`${baseUrl}/api/price?cents=10000&discount=25`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cents: 7500, formatted: "$75.00" });
});
