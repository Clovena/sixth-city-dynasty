import type { SupabaseClient } from "@supabase/supabase-js";

// ------------------------------------------------------------
// Shared contract for the routine syncs.
//
// Each sync module exports one function, (ctx) => SyncResult, and
// is runtime-agnostic: no dotenv, no process.*, no Deno.* — only
// fetch, console, and the client it is handed. That lets the same
// code run under Node (scripts/lib/sync-*.ts, via tsx) and under
// Deno (the `sync` Edge Function, on pg_cron).
// ------------------------------------------------------------

export type Client = SupabaseClient<any, any, any>;

export interface SeasonScope {
  /** Target year, or null to sync every season (the default). */
  year: number | null;
  /** Human-readable description for log output. */
  label: string;
}

export interface SyncContext {
  supabase: Client;
  scope: SeasonScope;
}

export interface SyncResult {
  /** Rows written (upserted / inserted) across the whole sync. */
  rows: number;
  /** Per-season / per-item failures that were caught so the rest could continue. */
  errors: string[];
  /** Non-fatal oddities worth surfacing (e.g. rosters skipping unknown players). */
  warnings: string[];
}

export type SyncFn = (ctx: SyncContext) => Promise<SyncResult>;

export function emptyResult(): SyncResult {
  return { rows: 0, errors: [], warnings: [] };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
