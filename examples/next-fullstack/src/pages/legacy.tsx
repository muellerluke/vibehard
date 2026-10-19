import { formatPrice } from "../lib/pricing";

interface LegacyProps {
  cents: number;
}

// getServerSideProps forces per-request rendering: without it this page
// would be prerendered at build time and its symbols never observed.
export function getServerSideProps(context: {
  query: { cents?: string };
}): { props: LegacyProps } {
  return { props: { cents: Number(context.query.cents ?? "500") } };
}

export default function LegacyPage({ cents }: LegacyProps) {
  return (
    <main>
      <h1>Legacy (Pages Router)</h1>
      <p data-testid="legacy-total">{formatPrice(cents)}</p>
    </main>
  );
}
