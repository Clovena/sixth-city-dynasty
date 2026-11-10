-- Pick'ems bot schema (spec: docs/pickems-bot-spec.md §6, with §18 amendments).
-- Everything the bot owns lives in its own `pickems` schema; it READS scdfl.*
-- but never writes there.

create schema if not exists pickems;

-- A note on Discord IDs ("snowflakes"): Discord identifies everything
-- (users, channels, messages) with 64-bit integers like 1569485776968745070.
-- Those exceed JavaScript's safe-integer range (2^53), so we store them as
-- text and never parse them to Number anywhere in the bot.

create table pickems.leagues (
  key                 text primary key,            -- 'dfl' ('efl' possible later; §18.1)
  display_name        text not null,
  short_name          text not null,
  season              int  not null,
  channel_id          text not null,               -- Discord channel snowflake
  matchup_source      text not null check (matchup_source in ('scdfl','sleeper','manual')),
  results_source      text not null check (results_source in ('sleeper','scdfl','manual')),
  regular_season_weeks int not null default 14,
  include_consolation boolean not null default true,
  active              boolean not null default true
);

create table pickems.config (                      -- small key/value store
  key text primary key,
  value text not null
);  -- rows: admin_channel_id, dry_run ('true'/'false')

-- All four timestamps are timestamptz: Postgres stores them in UTC and the
-- seed converts ET wall-clock times once, at insert. The bot only ever
-- compares now() >= <step>_at, so it never does timezone math at runtime.
create table pickems.calendar (
  season int,
  week int,
  post_at   timestamptz not null,
  remind_at timestamptz not null,
  lock_at   timestamptz not null,
  score_at  timestamptz not null,
  primary key (season, week)
);

create table pickems.teams (                       -- presentation layer
  league_key text references pickems.leagues(key),
  team_key   text,                                 -- DFL: Sleeper roster_id as text
  display_name text not null,                      -- 'Bikini Bottom Stars'
  short_name   text,                               -- 'Stars'
  emoji        text,                               -- Unicode emoji character (§18.13)
  primary key (league_key, team_key)
);

create table pickems.manual_matchups (             -- fallback pairing entry (DFL playoffs)
  league_key text references pickems.leagues(key),
  season int, week int, slot int,
  team_a_key text not null,
  team_b_key text not null,
  label text,                                      -- optional, e.g. 'Semifinal'
  winner_key text,                                 -- null until known
  primary key (league_key, season, week, slot)
);

create table pickems.players (
  discord_user_id text primary key,
  display_name    text not null                    -- defaults to Discord username until Zac sets a real name
);

create table pickems.player_leagues (
  discord_user_id text references pickems.players,
  league_key text references pickems.leagues(key),
  remind boolean not null default true,            -- include in Thursday reminders
  primary key (discord_user_id, league_key)
);

create table pickems.weeks (                       -- progress per league-week
  league_key text references pickems.leagues(key),
  season int, week int,
  posted_at timestamptz, reminded_at timestamptz, locked_at timestamptz,
  collected_at timestamptz, scored_at timestamptz,
  skipped boolean not null default false,
  standings_posted_at timestamptz,                 -- §18.3: recap+standings posted once by SCORE
  alert_sent_at timestamptz,                       -- dedupe admin alerts
  last_error text,
  primary key (league_key, season, week)
);

create table pickems.polls (
  league_key text, season int, week int, slot int,
  team_a_key text not null,
  team_b_key text not null,
  label text,                                      -- 'Atom Bowl' | 'Semifinal' | null
  message_id text unique,                          -- Discord message snowflake; null until posted
  answer_a_id int, answer_b_id int,                -- from Discord's response; don't assume 1/2
  winner_key text,
  is_void boolean not null default false,          -- tied score → nobody credited or charged
  primary key (league_key, season, week, slot),
  foreign key (league_key, season, week) references pickems.weeks
);

create table pickems.picks (
  league_key text, season int, week int, slot int,
  discord_user_id text references pickems.players,
  pick_key text not null,                          -- team_key picked
  is_correct boolean,                              -- null until scored; stays null if poll void
  primary key (league_key, season, week, slot, discord_user_id),
  foreign key (league_key, season, week, slot) references pickems.polls
);

create table pickems.carryover (                   -- kept for a later spreadsheet import; empty for now (§18.9)
  league_key text, season int,
  discord_user_id text references pickems.players,
  correct int not null,
  incorrect int not null,
  through_week int not null,
  primary key (league_key, season, discord_user_id)
);

-- The lease is a one-row mutex: a tick first tries to claim this row with
-- "update ... where locked_until < now()". If two ticks overlap (cron fires
-- while a slow run is still going), only one update wins and the other tick
-- exits immediately. This is what makes "no duplicate polls" robust.
create table pickems.lease (
  id int primary key default 1 check (id = 1),
  locked_until timestamptz not null default '-infinity'
);

create table pickems.runs (                        -- debugging log, one row per invocation
  id bigint generated always as identity primary key,
  started_at timestamptz default now(),
  finished_at timestamptz,
  action text,
  summary jsonb,
  error text
);

-- Row Level Security, belt-and-braces: RLS on with zero policies means the
-- public PostgREST API can read/write nothing here even if the schema were
-- ever exposed. The bot is unaffected — it connects via SUPABASE_DB_URL as
-- the database owner, and owners bypass RLS.
alter table pickems.leagues         enable row level security;
alter table pickems.config          enable row level security;
alter table pickems.calendar        enable row level security;
alter table pickems.teams           enable row level security;
alter table pickems.manual_matchups enable row level security;
alter table pickems.players         enable row level security;
alter table pickems.player_leagues  enable row level security;
alter table pickems.weeks           enable row level security;
alter table pickems.polls           enable row level security;
alter table pickems.picks           enable row level security;
alter table pickems.carryover       enable row level security;
alter table pickems.lease           enable row level security;
alter table pickems.runs            enable row level security;

-- Standings = carryover + graded picks. Per §18.4, graded picks only count
-- where week > carryover.through_week, so a lab-scored week can never be
-- double-counted against a future spreadsheet import.
create view pickems.v_standings as
with graded as (
  select p.league_key, p.season, p.discord_user_id,
         count(*) filter (where p.is_correct)     as correct,
         count(*) filter (where not p.is_correct) as incorrect
  from pickems.picks p
  left join pickems.carryover c
    on  c.league_key = p.league_key
    and c.season = p.season
    and c.discord_user_id = p.discord_user_id
  where p.is_correct is not null                   -- void polls and unscored weeks don't count
    and p.week > coalesce(c.through_week, 0)
  group by 1, 2, 3
),
totals as (
  select league_key, season, discord_user_id,
         coalesce(g.correct, 0)   + coalesce(c.correct, 0)   as correct,
         coalesce(g.incorrect, 0) + coalesce(c.incorrect, 0) as incorrect
  from graded g
  full join pickems.carryover c using (league_key, season, discord_user_id)
),
last_scored_week as (
  select league_key, season, max(week) as week
  from pickems.weeks
  where scored_at is not null
  group by 1, 2
),
last_counts as (
  select p.league_key, p.season, p.discord_user_id,
         count(*) filter (where p.is_correct)         as last_week_correct,
         count(*) filter (where p.is_correct is not null) as last_week_total
  from pickems.picks p
  join last_scored_week lw
    on lw.league_key = p.league_key and lw.season = p.season and lw.week = p.week
  group by 1, 2, 3
)
select t.league_key, t.season, t.discord_user_id,
       pl.display_name,
       t.correct, t.incorrect,
       round(t.correct::numeric / nullif(t.correct + t.incorrect, 0), 3) as pct,
       coalesce(lc.last_week_correct, 0) as last_week_correct,
       coalesce(lc.last_week_total, 0)   as last_week_total,
       -- rank() = competition ranking: ties share a rank and the next rank is
       -- skipped (1, 2, 2, 4), exactly the §6 requirement
       rank() over (partition by t.league_key, t.season order by t.correct desc) as rank
from totals t
join pickems.players pl on pl.discord_user_id = t.discord_user_id
left join last_counts lc
  on  lc.league_key = t.league_key
  and lc.season = t.season
  and lc.discord_user_id = t.discord_user_id;
