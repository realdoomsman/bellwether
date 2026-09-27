import type { Format } from '@number-flow/react';

/**
 * Share of supply burned, as the token page prints it everywhere (figure, gauge, share card):
 * two decimals from 1%, three significant digits below so a small burn never reads as 0.00%.
 */
export function burnFormat(frac: number): Format {
  return frac >= 0.01 ? { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 } : { style: 'percent', maximumSignificantDigits: 3 };
}

export function burnedLabel(frac: number): string {
  return frac.toLocaleString('en-US', burnFormat(frac));
}
