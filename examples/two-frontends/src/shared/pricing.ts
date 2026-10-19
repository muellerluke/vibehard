/** Shared by both frontends: editing this selects tests of each. */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
