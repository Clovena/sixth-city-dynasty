import type { SupabaseClient } from "@supabase/supabase-js";

// ------------------------------------------------------------
// Shared season clamping for the routine sync scripts.
//
// By default every routine sync walks all of league history, which
// re-fetches five completed seasons that will never change again.
// This resolves an optional scope so a sync can be clamped to one
// season:
//
//   npx tsx scripts/lib/sync-matchups.ts --latest
//   npx tsx scripts/lib/sync-matchups.ts --year 2023
//   SCDFL_SEASON=latest npm run sync      # the whole chain (sync:recent)
//   SCDFL_SEASON=2023 npm run sync        # the whole chain, one season
//
// CLI flags win over the env var, so a single script can override a
// scope set for the surrounding chain.
//
// "latest" always resolves against MAX(year) in scdfl.seasons rather
// than against each table's own max, so every script in a chain clamps
// to the same year. That matters for drafts and exhibitions, whose own
// max year can lead or lag the season table.
// ------------------------------------------------------------

/** Anything holding a season year — seasons, drafts, exhibitions rows all qualify. */
interface HasYear {
  year: number;
}

export interface SeasonScope {
  /** Target year, or null to sync every season (the default). */
  year: number | null;
  /** Human-readable description for log output. */
  label: string;
}

const ALL_SEASONS: SeasonScope = { year: null, label: "all seasons" };

const LATEST_ALIASES = new Set(["latest", "recent", "current"]);
const ALL_ALIASES = new Set(["", "all", "history"]);

/**
 * Pull the raw scope token from argv, falling back to SCDFL_SEASON.
 * Returns null when no scope was requested anywhere.
 */
function rawScopeToken(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--latest" || arg === "--recent") return "latest";
    if (arg === "--all") return "all";

    if (arg === "--year") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`--year requires a value, e.g. --year 2025`);
      }
      return value;
    }

    if (arg.startsWith("--year=")) return arg.slice("--year=".length);
  }

  return process.env.SCDFL_SEASON ?? null;
}

async function fetchLatestSeasonYear(
  supabase: SupabaseClient<any, any, any>
): Promise<number> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year")
    .order("year", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    throw new Error(`Failed to resolve the most recent season: ${error.message}`);
  }

  return (data as HasYear).year;
}

/**
 * Resolve the season scope for this run. Call once at the top of main().
 * Hits scdfl.seasons only when "latest" was requested.
 */
export async function resolveSeasonScope(
  supabase: SupabaseClient<any, any, any>
): Promise<SeasonScope> {
  const token = rawScopeToken(process.argv.slice(2))?.trim().toLowerCase() ?? null;

  if (token === null || ALL_ALIASES.has(token)) return ALL_SEASONS;

  if (LATEST_ALIASES.has(token)) {
    const year = await fetchLatestSeasonYear(supabase);
    return { year, label: `${year} (most recent season)` };
  }

  const year = Number.parseInt(token, 10);
  if (Number.isNaN(year)) {
    throw new Error(
      `Invalid season scope "${token}" — expected a four-digit year, "latest", or "all".`
    );
  }

  return { year, label: String(year) };
}

/** Narrow a list of season/draft/exhibition rows to the scoped year. */
export function scopeToSeason<T extends HasYear>(rows: T[], scope: SeasonScope): T[] {
  if (scope.year === null) return rows;
  return rows.filter((row) => row.year === scope.year);
}
