export interface Product {
  sku: string;
  name: string;
  priceCents: number;
}

const PRODUCTS: Product[] = [
  { sku: "pen", name: "Pen", priceCents: 1299 },
  { sku: "notebook", name: "Notebook", priceCents: 500 },
];

export function findProduct(sku: string): Product | null {
  return PRODUCTS.find((p) => p.sku === sku) ?? null;
}

export function priceOrder(unitCents: number, quantity: number): number {
  const qty = Math.max(1, Math.floor(quantity));
  const subtotal = unitCents * qty;
  return qty >= 10 ? Math.round(subtotal * 0.9) : subtotal;
}
