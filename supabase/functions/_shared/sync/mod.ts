import { syncDrafts } from "./drafts.ts";
import { syncExhibitions } from "./exhibitions.ts";
import { syncMatchups } from "./matchups.ts";
import { syncResults } from "./results.ts";
import { syncRosters } from "./rosters.ts";
import { syncStats } from "./stats.ts";
import { syncTransactions } from "./transactions.ts";
import type { SyncFn } from "./types.ts";

// Registry of the routine syncs by name. The names are what job
// definitions (functions/sync/jobs.ts) list as steps and what ends up
// in ops.run_steps.step, so treat them as stable identifiers.
export const SYNCS = {
  results: syncResults,
  matchups: syncMatchups,
  rosters: syncRosters,
  transactions: syncTransactions,
  drafts: syncDrafts,
  exhibitions: syncExhibitions,
  stats: syncStats,
} satisfies Record<string, SyncFn>;

export type SyncName = keyof typeof SYNCS;

export { resolveSeasonScope, scopeToSeason } from "./scope.ts";
export type { Client, SeasonScope, SyncContext, SyncFn, SyncResult } from "./types.ts";
