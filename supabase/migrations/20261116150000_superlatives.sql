-- Superlatives race (SUPERLATIVES.md): the current top five for each of the
-- 14 Superlative Awards, recomputed nightly by the `sync` Edge Function's
-- `superlatives` step and read by /superlatives at build time.
--
-- Objects:
--   scdfl.nfl_schedule              nflverse games.csv (B7) — byes and missed games
--   scdfl.injury_overrides          manual fixes for the Tough Break proxy (§4.10)
--   scdfl.trade_exclusions          joke trades / contract dumps (§4.13)
--   scdfl.superlative_leaders       the output contract (§5), one row per award × rank
--   scdfl.superlative_leaders_final write-once snapshot taken at as_of_week = 14
--   scdfl.compute_superlative_leaders(season, as_of_week, top, pick_horizon)
--                                   the computation (pure; …_superlatives_compute.sql)
--   …_superlatives_grants.sql       revokes, applied by hand
--
-- Apply via MCP / the SQL editor (`db push` is broken for this project —
-- docs/pickems-bot-spec.md §19.1). Re-runnable: every statement is
-- create-if-not-exists or create-or-replace. Split in three files so that
-- this one and the compute function contain nothing destructive; the sync
-- step writes scdfl.superlative_leaders itself (no refresh function).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists scdfl.nfl_schedule (
  game_id   text primary key,          -- nflverse game_id, e.g. 2026_01_DAL_PHI
  season    int  not null,
  week      int  not null,
  game_type text not null,             -- REG / WC / DIV / CON / SB
  gameday   date,
  home_team text not null,             -- Sleeper team codes (nflverse LA → LAR)
  away_team text not null
);
create index if not exists nfl_schedule_season_week_idx on scdfl.nfl_schedule (season, week);

create table if not exists scdfl.injury_overrides (
  year        int  not null,
  player_id   text not null,
  action      text not null check (action in ('include', 'exclude', 'adjust')),
  injury_week int,                     -- week the spell began (include / adjust)
  return_week int,                     -- week he returned; null = still out
  note        text,                    -- shown on the card, e.g. "Traded to Choccolocco"
  primary key (year, player_id)
);

create table if not exists scdfl.trade_exclusions (
  transaction_id text primary key,
  note           text
);

create table if not exists scdfl.superlative_leaders (
  season         int  not null,
  as_of_week     int  not null,        -- "through Week N"
  award_code     text not null,        -- matches accolades.award_code
  rank           int  not null,        -- 1–5
  player_id      text,                 -- player awards
  sleeper_id     text,                 -- franchise awards (roster id as text)
  transaction_id text,                 -- trade awards
  franchise_abbr text,                 -- display franchise(s): "TOR", "TOR/PEI", "TBY / TOR"
  score          numeric,
  headline       text,
  detail_lines   text[] not null default '{}',
  flags          text[] not null default '{}',
  payload        jsonb  not null default '{}',
  generated_at   timestamptz not null default now(),
  primary key (season, award_code, rank)
);

-- The ballot nominee list: frozen once, when the refresh first runs with
-- as_of_week = 14. Delete a season's rows to let the next refresh re-freeze.
create table if not exists scdfl.superlative_leaders_final (
  like scdfl.superlative_leaders including all,
  frozen_at timestamptz not null default now()
);

alter table scdfl.nfl_schedule              enable row level security;
alter table scdfl.injury_overrides          enable row level security;
alter table scdfl.trade_exclusions          enable row level security;
alter table scdfl.superlative_leaders       enable row level security;
alter table scdfl.superlative_leaders_final enable row level security;

do $$
declare t text;
begin
  foreach t in array array['nfl_schedule', 'injury_overrides', 'trade_exclusions', 'superlative_leaders', 'superlative_leaders_final'] loop
    if not exists (select 1 from pg_policies where schemaname = 'scdfl' and tablename = t and policyname = 'public_read') then
      execute format('create policy public_read on scdfl.%I for select to anon, authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- The computation reads two sandbox tables (preseason ADP, the 2021–2025
-- baseline) as the caller — the sync step's service role — which had no
-- rights on that schema.
grant usage on schema sandbox to service_role;
grant select on sandbox.player_projections_2026, sandbox.player_windows_thru_2025 to service_role;

-- The computation takes 60–130 s on this instance (I/O-bound) and the sync
-- step calls it over PostgREST, whose inherited statement timeout cancelled
-- it. The service role is only ever our own scripts and functions.
alter role service_role set statement_timeout = '5min';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- §2.9 position buckets. Anything else (P, OL, …) is null and drops out.
create or replace function scdfl.pos_bucket(p text) returns text
language sql immutable as $$
  select case
    when p in ('QB', 'RB', 'WR', 'TE', 'K') then p
    when p = 'FB' then 'RB'
    when p in ('DE', 'DT', 'NT', 'DL') then 'DL'
    when p in ('LB', 'OLB', 'ILB', 'MLB') then 'LB'
    when p in ('CB', 'S', 'SS', 'FS', 'DB') then 'DB'
  end
$$;

create or replace function scdfl.sl_fmt(n numeric, d int default 2) returns text
language sql immutable as $$
  select case
    when n is null then '—'
    when d <= 0 then to_char(round(n), 'FM9,999,999,990')
    else to_char(round(n, d), 'FM9,999,999,990.' || repeat('0', d))
  end
$$;

create or replace function scdfl.sl_ordinal(n int) returns text
language sql immutable as $$
  select n::text || case
    when n % 100 between 11 and 13 then 'th'
    when n % 10 = 1 then 'st'
    when n % 10 = 2 then 'nd'
    when n % 10 = 3 then 'rd'
    else 'th' end
$$;

-- Overloads so bigint ranks / row_numbers and double-precision sums format
-- without a cast at every call site.
create or replace function scdfl.sl_ordinal(n bigint) returns text
language sql immutable as $$ select scdfl.sl_ordinal(n::int) $$;

create or replace function scdfl.sl_fmt(n double precision, d int default 2) returns text
language sql immutable as $$ select scdfl.sl_fmt(n::numeric, d) $$;

-- Season-aware franchise abbreviation (adoption logic from CLAUDE.md), falling
-- back to the active identity for seasons that haven't happened yet.
create or replace function scdfl.sl_abbr(p_roster_id int, p_year int) returns text
language sql stable as $$
  select coalesce(
    (select abbr from scdfl.franchises f
      where f.id = p_roster_id and f."from" <= p_year and (f."to" is null or f."to" >= p_year) limit 1),
    (select abbr from scdfl.franchises f where f.id = p_roster_id and f."to" is null limit 1))
$$;

-- One-line stat summary for a card, by position bucket.
create or replace function scdfl.sl_stat_line(pos text, st jsonb) returns text
language sql immutable as $$
  select case when st is null then null else case pos
    when 'QB' then format('%s pass yds, %s pass TD, %s rush yds, %s rush TD',
      scdfl.sl_fmt(coalesce((st->>'pass_yds')::numeric, 0), 0), coalesce((st->>'pass_tds')::int, 0),
      scdfl.sl_fmt(coalesce((st->>'rush_yds')::numeric, 0), 0), coalesce((st->>'rush_tds')::int, 0))
    when 'RB' then format('%s scrimmage yds, %s car / %s rec, %s TD',
      scdfl.sl_fmt(coalesce((st->>'rush_yds')::numeric, 0) + coalesce((st->>'rec_yds')::numeric, 0), 0),
      coalesce((st->>'rush_att')::int, 0), coalesce((st->>'receptions')::int, 0),
      coalesce((st->>'rush_tds')::int, 0) + coalesce((st->>'rec_tds')::int, 0))
    when 'WR' then format('%s rec, %s scrimmage yds, %s TD',
      coalesce((st->>'receptions')::int, 0),
      scdfl.sl_fmt(coalesce((st->>'rush_yds')::numeric, 0) + coalesce((st->>'rec_yds')::numeric, 0), 0),
      coalesce((st->>'rush_tds')::int, 0) + coalesce((st->>'rec_tds')::int, 0))
    when 'TE' then format('%s rec, %s scrimmage yds, %s TD',
      coalesce((st->>'receptions')::int, 0),
      scdfl.sl_fmt(coalesce((st->>'rush_yds')::numeric, 0) + coalesce((st->>'rec_yds')::numeric, 0), 0),
      coalesce((st->>'rush_tds')::int, 0) + coalesce((st->>'rec_tds')::int, 0))
    when 'K' then format('%s/%s FG', coalesce((st->>'fg_made')::int, 0), coalesce((st->>'fg_att')::int, 0))
    else format('%s tkl, %s TFL, %s sacks, %s QB hits, %s PBU, %s INT',
      coalesce((st->>'tkl')::int, 0), scdfl.sl_fmt(coalesce((st->>'tfl')::numeric, 0), 0),
      scdfl.sl_fmt(coalesce((st->>'sack')::numeric, 0), 1), coalesce((st->>'qb_hit')::int, 0),
      coalesce((st->>'pbu')::int, 0), coalesce((st->>'interception')::int, 0))
  end end
$$;

