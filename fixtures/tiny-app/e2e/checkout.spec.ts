import { expect, test } from 'vibehard/playwright';

test('checkout page shows the cart total', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#price')).toHaveText('$43.97');
});

test('coupon api accepts a code', async ({ request }) => {
  const response = await request.post('/api/coupons', { data: { code: 'SAVE10' } });
  expect(response.status()).toBe(200);
});
