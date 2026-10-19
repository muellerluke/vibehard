import { formatPrice } from "../lib/pricing";
import { getProduct } from "../lib/products";

// Per-request rendering (prerendered routes execute at build time and
// can never be observed while a test runs).
export const dynamic = "force-dynamic";

export default async function ProductPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string }>;
}) {
  const { sku } = await searchParams;
  const product = await getProduct(sku ?? "pen");
  return (
    <main>
      <h1 data-testid="name">{product.name}</h1>
      <p data-testid="price">{formatPrice(product.priceCents)}</p>
    </main>
  );
}
