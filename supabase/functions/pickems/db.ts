// Database client + the small set of bookkeeping queries used everywhere.
//
// First Supabase-DB note: inside an Edge Function, SUPABASE_DB_URL is a
// built-in secret pointing at this project's Postgres through the
// *transaction pooler*. The pooler hands each query a connection from a
// shared pool, so server-side prepared statements can't be relied on —
// that's why `prepare: false`. postgres.js (`npm:postgres`) gives us tagged-
// template queries: sql`select ... ${value}` passes values as bind
// parameters, never string-pasted, so there's no SQL-injection surface.
import postgres from 'npm:postgres@3.4.5';

export const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  // a tick does little DB work; keep the pool tiny and short-lived
  max: 2,
  idle_timeout: 20,
});

export type Sql = typeof sql;

// ── config / leagues ────────────────────────────────────────────────────────

export async function getConfig(): Promise<Record<string, string>> {
  const rows = await sql`select key, value from pickems.config`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export type League = {
  key: string;
  display_name: string;
  short_name: string;
  season: number;
  channel_id: string;
  matchup_source: string;
  results_source: string;
  regular_season_weeks: number;
  include_consolation: boolean;
  active: boolean;
};

export async function getActiveLeagues(): Promise<League[]> {
  const rows = await sql`
    select key, display_name, short_name, season, channel_id,
           matchup_source, results_source, regular_season_weeks,
           include_consolation, active
    from pickems.leagues
    where active
    order by key`;
  return rows as unknown as League[];
}

export async function getLeague(key: string): Promise<League | null> {
  const rows = await sql`
    select key, display_name, short_name, season, channel_id,
           matchup_source, results_source, regular_season_weeks,
           include_consolation, active
    from pickems.leagues
    where key = ${key}`;
  return (rows[0] as unknown as League) ?? null;
}

// ── lease (the one-row mutex; see the schema migration for the idea) ────────

export async function acquireLease(): Promise<boolean> {
  const rows = await sql`
    update pickems.lease
    set locked_until = now() + interval '4 minutes'
    where id = 1 and locked_until < now()
    returning id`;
  return rows.length > 0;
}

export async function releaseLease(): Promise<void> {
  await sql`update pickems.lease set locked_until = now() where id = 1`;
}

// ── runs log ────────────────────────────────────────────────────────────────

export async function startRun(action: string): Promise<number> {
  const rows = await sql`
    insert into pickems.runs (action) values (${action}) returning id`;
  return rows[0].id;
}

export async function finishRun(
  id: number,
  summary: unknown,
  error: string | null,
): Promise<void> {
  await sql`
    update pickems.runs
    set finished_at = now(), summary = ${sql.json(summary as never)}, error = ${error}
    where id = ${id}`;
}

// ── weeks (per-league-week progress) ────────────────────────────────────────

export async function ensureWeek(leagueKey: string, season: number, week: number) {
  await sql`
    insert into pickems.weeks (league_key, season, week)
    values (${leagueKey}, ${season}, ${week})
    on conflict do nothing`;
}

export async function getWeek(leagueKey: string, season: number, week: number) {
  const rows = await sql`
    select * from pickems.weeks
    where league_key = ${leagueKey} and season = ${season} and week = ${week}`;
  return rows[0] ?? null;
}

// Set one step's completion timestamp, and clear any standing alert so the
// next failure (of any step) alerts again.
export async function markStep(
  leagueKey: string,
  season: number,
  week: number,
  column: 'posted_at' | 'reminded_at' | 'locked_at' | 'collected_at' | 'scored_at' | 'standings_posted_at',
) {
  await sql`
    update pickems.weeks
    set ${sql(column)} = now(), alert_sent_at = null, last_error = null
    where league_key = ${leagueKey} and season = ${season} and week = ${week}`;
}

export async function getCalendar(season: number) {
  return await sql`
    select season, week, post_at, remind_at, lock_at, score_at
    from pickems.calendar
    where season = ${season}
    order by week`;
}

// ── teams / players / standings ─────────────────────────────────────────────

export type TeamRow = {
  team_key: string;
  display_name: string;
  short_name: string | null;
  emoji: string | null;
};

export async function getTeams(leagueKey: string): Promise<Map<string, TeamRow>> {
  const rows = await sql`
    select team_key, display_name, short_name, emoji
    from pickems.teams
    where league_key = ${leagueKey}`;
  return new Map(rows.map((r) => [r.team_key, r as unknown as TeamRow]));
}

// Insert any voters we haven't seen; refresh only placeholder display names
// so a name Zac typed in by hand is never overwritten (§18.2).
export async function upsertPlayers(
  leagueKey: string,
  users: { id: string; displayName: string }[],
) {
  if (users.length === 0) return;
  for (const u of users) {
    await sql`
      insert into pickems.players (discord_user_id, display_name)
      values (${u.id}, ${u.displayName})
      on conflict (discord_user_id) do update
      set display_name = case
        when pickems.players.display_name like 'player-%' then excluded.display_name
        else pickems.players.display_name
      end`;
    await sql`
      insert into pickems.player_leagues (discord_user_id, league_key, remind)
      values (${u.id}, ${leagueKey}, true)
      on conflict do nothing`; // never resets an opt-out
  }
}

export async function getStandings(leagueKey: string, season: number) {
  return await sql`
    select display_name, correct, incorrect, pct,
           last_week_correct, last_week_total, rank
    from pickems.v_standings
    where league_key = ${leagueKey} and season = ${season}
    order by rank, display_name`;
}
