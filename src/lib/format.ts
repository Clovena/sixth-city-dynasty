/**
 * Shared, pure formatting helpers with no data dependency.
 */

const ROMAN_VALUES = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
const ROMAN_SYMBOLS = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];

/** Converts a positive integer to a Roman numeral (e.g. `toRoman(6)` → `'VI'`). */
export function toRoman(n: number): string {
  let remaining = n;
  let result = '';
  for (let i = 0; i < ROMAN_VALUES.length; i++) {
    while (remaining >= ROMAN_VALUES[i]) {
      result += ROMAN_SYMBOLS[i];
      remaining -= ROMAN_VALUES[i];
    }
  }
  return result;
}

/** Ordinal suffix for a positive integer (e.g. `ordinal(3)` → `'3rd'`). */
export function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st'
    : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd'
    : 'th';
  return `${n}${suffix}`;
}

/** Zero-pads a number to two digits (week numbers, etc.). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Draft pick label as `round.slot`, slot derived from an overall pick number in a 14-team league. */
export function draftPickLabel(round: number, pickNo: number): string {
  return `${round}.${pad2(((pickNo - 1) % 14) + 1)}`;
}

/** Null-safe fixed-point score/points display; renders missing values as an em dash. */
export function formatPoints(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toFixed(2);
}

/** Joins a player's first/last name, dropping whichever half is missing; falls back if both are absent. */
export function playerName(
  first: string | null | undefined,
  last: string | null | undefined,
  fallback: string,
): string {
  const parts = [first, last].filter(Boolean);
  return parts.length ? parts.join(' ') : fallback;
}

/** Sleeper timestamps are unix ms — render one as `Sep 14, 2021`. */
export function formatTimestamp(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** ESPN headshot URL for a player, or the site placeholder image if no ESPN id is known. */
export function espnHeadshotUrl(espnId: string | null | undefined): string {
  return espnId
    ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`
    : '/images/player-placeholder.png';
}

/**
 * Franchise logo path — logos live in public/images/logos/, filenamed by abbr.
 *
 * Lives here (not franchise-identity.ts) because remark-team-headers.ts runs
 * inside astro.config.mjs's evaluation context, before Vite env vars are
 * available — importing anything that transitively pulls in lib/supabase.ts
 * there crashes the config load. format.ts has no such dependency.
 */
export function logoPath(abbr: string): string {
  return `/images/logos/${abbr}.png`;
}

/** A franchise's primary accent color, with a design-system border color as the fallback. */
export function primaryColor(
  colors: string[] | null | undefined,
  fallback = 'var(--border-default)',
): string {
  return colors?.[0] ?? fallback;
}

/* ── Club colour on a dark ground ──────────────────────────────────────────
 * Franchise palettes are authored for light surfaces, so several primaries
 * (VAN #0c152d, NFD #192f5d) sit within a point or two of the ink band's own
 * ground and disappear on it entirely.
 *
 * The fix keeps the club's hue and raises only its lightness, and only as far
 * as legibility requires. Searching the palette for a brighter entry instead
 * would be simpler but costs the identity — it hands Vancouver its grey
 * tertiary and Gold Coast a pink, neither of which reads as the club.
 *
 * 3:1 is the WCAG threshold for non-text UI, which is what these are: rules,
 * keels, and accent borders rather than anything you read.
 */

const INK_GROUND = '#1C1A17'; // --ink-900
const MIN_RATIO = 3;
const HEX6 = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
  const s = hex.slice(1);
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(v => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + 360) % 360;

  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];

  return '#' + [r, g, b]
    .map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * A colour lightened just enough to read against a dark ground, hue intact.
 * Anything that isn't a 6-digit hex (a CSS variable, say) is returned as-is.
 */
export function readableOnInk(color: string, ground = INK_GROUND): string {
  if (!HEX6.test(color)) return color;
  if (contrastRatio(color, ground) >= MIN_RATIO) return color;

  const [h, s] = toHsl(color);
  let [, , l] = toHsl(color);
  while (l < 0.95) {
    l = Math.min(l + 0.02, 0.95);
    const next = hslToHex(h, s, l);
    if (contrastRatio(next, ground) >= MIN_RATIO) return next;
  }
  return hslToHex(h, s, 0.95);
}

/** A franchise's primary accent, adjusted to read on the dark broadcast band. */
export function primaryColorOnInk(
  colors: string[] | null | undefined,
  fallback = 'var(--ember-500)',
): string {
  const primary = colors?.[0];
  return primary ? readableOnInk(primary) : fallback;
}
