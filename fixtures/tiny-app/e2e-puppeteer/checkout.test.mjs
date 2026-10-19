import assert from "node:assert/strict";

import puppeteer from "puppeteer";
import { describeTest, withVibehardPage } from "vibehard/puppeteer";

import { priceSymbols } from "./uses.mjs";

const baseUrl = process.env["VIBEHARD_BASE_URL"] ?? "http://127.0.0.1:4173";

describeTest('checkout page shows the cart total', {
  uses: [
    ...priceSymbols,
    'src/app/checkout/page.tsx#CheckoutPage',
    'src/lib/cart.ts#Cart.addItem',
  ],
}, async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  try {
    const page = await withVibehardPage(browser);
    await page.goto(`${baseUrl}/`);
    await page.waitForFunction(
      () => document.querySelector("#price")?.textContent === "$43.97",
    );
  } finally {
    await browser.close();
  }
});

describeTest('coupon api accepts a code', {
  uses: ['src/app/api/coupons/route.ts#POST'],
}, async () => {
  const response = await fetch(`${baseUrl}/api/coupons`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "SAVE10" }),
  });
  assert.equal(response.status, 200);
});
