// Small pure helpers shared by the pick'ems modules.
//
// First Deno note: Deno runs TypeScript directly — no build step, no
// package.json. A file like this is just imported by path
// (`import { toRoman } from './util.ts'`, extension required).

// Duplicate of src/lib/format.ts `toRoman` (spec §18.7): the Edge Function
// can't safely import from src/lib, so the Dynasty Bowl numeral logic is
// copied here. If the site version ever changes, change both.
export function toRoman(n: number): string {
  const vals: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [v, sym] of vals) {
    while (rest >= v) {
      out += sym;
      rest -= v;
    }
  }
  return out;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
