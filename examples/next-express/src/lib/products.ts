export interface ApiProduct {
  sku: string;
  name: string;
  priceCents: number;
}

export async function getProduct(sku: string): Promise<ApiProduct> {
  const base = process.env["API_URL"] ?? "http://127.0.0.1:4100";
  const response = await fetch(
    `${base}/api/products?sku=${encodeURIComponent(sku)}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`api /api/products failed: ${response.status}`);
  }
  return (await response.json()) as ApiProduct;
}
