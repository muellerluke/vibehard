export interface Product {
  sku: string;
  priceCents: number;
}

export const PRODUCTS: Product[] = [
  { sku: "pen", priceCents: 1299 },
  { sku: "notebook", priceCents: 500 },
];

/** Store-only: editing this must not select admin-only tests. */
export function storeTotalCents(): number {
  return PRODUCTS.reduce((sum, product) => sum + product.priceCents, 0);
}
