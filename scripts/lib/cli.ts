import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { resolveSeasonScope } from "../../supabase/functions/_shared/sync/scope.ts";
import type { SyncFn } from "../../supabase/functions/_shared/sync/types.ts";

// ------------------------------------------------------------
// Node entry point for the routine syncs.
//
// The sync logic itself lives in supabase/functions/_shared/sync/ so
// the `sync` Edge Function (pg_cron, nightly) and these npm scripts
// run the same code. This file is the Node-only part: dotenv, argv,
// SCDFL_SEASON, and the exit code.
//
// Season scope:
//
//   npx tsx scripts/lib/sync-matchups.ts --latest
//   npx tsx scripts/lib/sync-matchups.ts --year 2023
//   SCDFL_SEASON=latest npm run sync      # the whole chain (sync:recent)
//   SCDFL_SEASON=2023 npm run sync        # the whole chain, one season
//
// CLI flags win over the env var, so a single script can override a
// scope set for the surrounding chain.
// ------------------------------------------------------------

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

/**
 * Run one sync from the command line. Per-season failures are logged and
 * the run carries on (exit 0), as the scripts always have; only a failure
 * that stops the whole sync — bad scope, seasons lookup down — exits 1.
 */
export async function runSync(sync: SyncFn): Promise<void> {
  try {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const scope = await resolveSeasonScope(supabase, rawScopeToken(process.argv.slice(2)));
    await sync({ supabase, scope });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
