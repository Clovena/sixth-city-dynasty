import { supabase } from './supabase';
import { logoPath, primaryColor } from './format';

export { logoPath, primaryColor };

/**
 * Franchise identity resolution.
 *
 * The `franchises` table uses a temporal identity model: one row per identity
 * era, keyed by `sleeper_id` (stable across eras) with `"from"`/`"to"` marking
 * the years that era's abbr/name/colors were active. Active identities have
 * `"to" IS NULL`. See CLAUDE.md's "Franchise Identity Model" section.
 *
 * `franchises.id` is numerically identical to `Number(franchises.sleeper_id)`
 * for every row (confirmed via `SELECT id, sleeper_id FROM scdfl.franchises
 * WHERE id::text != sleeper_id` → zero rows), and matches.roster_id_a/b
 * equal `franchises.id` directly — so any roster/matchup roster_id can be
 * passed to these functions as `String(rosterId)` in place of a sleeper_id.
 */

export type FranchiseRow = {
  id: number;
  sleeper_id: string;
  abbr: string;
  name: string;
  owner: string;
  conf: string;
  colors: string[];
  from: number;
  to: number | null;
};

/** The identity a franchise carried during a given season. */
export function franchiseForYear(
  rows: FranchiseRow[],
  sleeperId: string,
  year: number,
): FranchiseRow | undefined {
  return rows.find(
    f => f.sleeper_id === sleeperId && f.from <= year && (f.to === null || f.to >= year),
  );
}

/** The identity a franchise carries today (for linking). */
export function activeFranchise(rows: FranchiseRow[], sleeperId: string): FranchiseRow | undefined {
  return rows.find(f => f.sleeper_id === sleeperId && f.to === null);
}

/** Reverse lookup: resolves a stored abbr (e.g. `seasons.scc_champion`) to the identity it named in a given year. */
export function franchiseByAbbrForYear(
  rows: FranchiseRow[],
  abbr: string,
  year: number,
): FranchiseRow | undefined {
  return rows.find(f => f.abbr === abbr && f.from <= year && (f.to === null || f.to >= year));
}

/** Compact identity shape used anywhere a game/side needs both the era abbr (logos) and active abbr (links). */
export type SideIdentity = {
  /** Identity as branded in that season — drives logos */
  abbr: string;
  /** Current identity — drives /franchises/[abbr] links */
  activeAbbr: string;
  name: string;
};

/** Resolves a roster/sleeper id to its era identity for a season, falling back to the active identity. */
export function identityFor(
  rows: FranchiseRow[],
  rosterId: number | string,
  year: number,
): SideIdentity | null {
  const sleeperId = String(rosterId);
  const era = franchiseForYear(rows, sleeperId, year);
  const active = activeFranchise(rows, sleeperId);
  const identity = era ?? active;
  if (!identity) return null;
  return { abbr: identity.abbr, activeAbbr: active?.abbr ?? identity.abbr, name: identity.name };
}

export async function loadFranchises(): Promise<FranchiseRow[]> {
  const { data, error } = await supabase
    .schema('scdfl')
    .from('franchises')
    .select('id, sleeper_id, abbr, name, owner, conf, colors, "from", "to"');

  if (error || !data) throw new Error(`Franchises query failed: ${error?.message ?? 'No data returned'}`);
  return data as FranchiseRow[];
}
