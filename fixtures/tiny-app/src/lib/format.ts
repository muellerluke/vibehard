export const CENTS_PER_DOLLAR = 100;

export const formatPrice = (cents: number): string => {
  return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
};
