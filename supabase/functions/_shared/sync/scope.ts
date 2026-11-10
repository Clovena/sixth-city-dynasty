import type { Client, SeasonScope } from "./types.ts";

// ------------------------------------------------------------
// Season clamping for the routine syncs.
//
// By default every routine sync walks all of league history, which
// re-fetches completed seasons that will never change again. A scope
// token clamps a sync to one season. Where the token comes from is
// the caller's business — argv / SCDFL_SEASON for the Node CLIs
// (scripts/lib/cli.ts), the job definition for the Edge Function
// (functions/sync/jobs.ts).
//
// "latest" always resolves against MAX(year) in scdfl.seasons rather
// than against each table's own max, so every sync in a chain clamps
// to the same year. That matters for drafts and exhibitions, whose
// own max year can lead or lag the season table.
// ------------------------------------------------------------

/** Anything holding a season year — seasons, drafts, exhibitions rows all qualify. */
interface HasYear {
  year: number;
}

const ALL_SEASONS: SeasonScope = { year: null, label: "all seasons" };

const LATEST_ALIASES = new Set(["latest", "recent", "current"]);
const ALL_ALIASES = new Set(["", "all", "history"]);

async function fetchLatestSeasonYear(supabase: Client): Promise<number> {
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
 * Resolve a scope token ("latest", "2023", "all", or null) to a SeasonScope.
 * Hits scdfl.seasons only when "latest" was requested.
 */
export async function resolveSeasonScope(
  supabase: Client,
  rawToken: string | null
): Promise<SeasonScope> {
  const token = rawToken?.trim().toLowerCase() ?? null;

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
