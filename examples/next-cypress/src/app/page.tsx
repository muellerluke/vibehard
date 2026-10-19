import Counter from "./counter/Counter";
import { formatPrice } from "../lib/pricing";

// Prerendered routes execute at build time, not while a test runs, so
// their symbols can never be observed. Routes under test must render
// per request.
export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ cents?: string }>;
}) {
  const { cents } = await searchParams;
  const total = Number(cents ?? "4397");
  return (
    <main>
      <h1>Checkout</h1>
      <p data-testid="total">{formatPrice(total)}</p>
      <Counter />
    </main>
  );
}
