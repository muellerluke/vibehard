import { expect, test } from 'vibehard/playwright';

import { priceSymbols } from './uses.js';

test('checkout page shows the cart total', {
  uses: [
    ...priceSymbols,
    'src/app/checkout/page.tsx#CheckoutPage',
    'src/lib/cart.ts#Cart.addItem',
  ],
}, async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#price')).toHaveText('$43.97');
});

test('coupon api accepts a code', {
  uses: ['src/app/api/coupons/route.ts#POST'],
}, async ({ request }) => {
  const response = await request.post('/api/coupons', { data: { code: 'SAVE10' } });
  expect(response.status()).toBe(200);
});
