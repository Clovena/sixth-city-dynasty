-- -- -- FRANCHISES
-- Manually maintained

create table scdfl.franchises (
  id integer not null,
  sleeper_id text null,
  abbr text not null,
  name text not null,
  owner text not null,
  conf text not null,
  colors text[] not null default '{}'::text[],
  "from" integer not null,
  "to" integer null,
  constraint franchises_pkey primary key (id, "from"),
  constraint franchises_conf_check check ((conf = any (array['SCC'::text, 'HCC'::text])))
) TABLESPACE pg_default;

create unique INDEX IF not exists franchises_abbr_idx on scdfl.franchises using btree (abbr) TABLESPACE pg_default;


-- -- -- SEASON METADATA
-- Manually maintained

create table scdfl.seasons (
  year integer not null,
  league_id text not null,
  regular_season_weeks integer not null default 14,
  playoff_teams integer not null default 7,
  scc_champion text null,
  hcc_champion text null,
  charity text null,
  retreat_location text null,
  constraint seasons_new_pkey primary key (year)
) TABLESPACE pg_default;


-- -- -- PLAYER METADATA
-- API call; `npm run sync:players`

create table scdfl.players (
  player_id text not null,
  first_name text null,
  last_name text null,
  position text null,
  fantasy_positions text[] null,
  team text null,
  status text null,
  age integer null,
  years_exp integer null,
  number integer null,
  height text null,
  weight text null,
  college text null,
  birth_country text null,
  depth_chart_order integer null,
  depth_chart_position text null,
  injury_status text null,
  injury_start_date text null,
  practice_participation text null,
  hashtag text null,
  search_first_name text null,
  search_last_name text null,
  search_full_name text null,
  search_rank integer null,
  sport text null,
  sportradar_id text null,
  fantasy_data_id integer null,
  espn_id text null,
  stats_id text null,
  rotowire_id integer null,
  rotoworld_id integer null,
  yahoo_id integer null,
  constraint players_pkey primary key (player_id)
) TABLESPACE pg_default;


-- -- -- PLAYER IDS XREF
-- External csv; `npm run sync:pids`

create table scdfl.player_ids (
  sleeper_id text not null,
  espn_id text null,
  mfl_id text null,
  fantasypros_id text null,
  pff_id text null,
  pfr_id text null,
  ktc_id text null,
  rotowire_id integer null,
  yahoo_id integer null,
  gsis_id text null,
  constraint player_ids_pkey primary key (sleeper_id),
  constraint player_ids_sleeper_id_fkey foreign KEY (sleeper_id) references scdfl.players (player_id)
) TABLESPACE pg_default;

create index IF not exists player_ids_gsis_id_idx on scdfl.player_ids using btree (gsis_id) TABLESPACE pg_default;


-- -- -- PLAYER METADATA VIEW WITH XREF

create view scdfl.v_players as
select
  p.player_id,
  p.first_name,
  p.last_name,
  p."position",
  p.fantasy_positions,
  p.team,
  p.status,
  p.age,
  p.years_exp,
  p.number,
  p.height,
  p.weight,
  p.college,
  p.birth_country,
  p.depth_chart_order,
  p.depth_chart_position,
  p.injury_status,
  p.injury_start_date,
  p.practice_participation,
  p.hashtag,
  p.search_first_name,
  p.search_last_name,
  p.search_full_name,
  p.search_rank,
  p.sport,
  p.sportradar_id,
  p.fantasy_data_id,
  p.stats_id,
  p.rotoworld_id,
  COALESCE(pi.espn_id, p.espn_id) as espn_id,
  COALESCE(pi.rotowire_id, p.rotowire_id) as rotowire_id,
  COALESCE(pi.yahoo_id, p.yahoo_id) as yahoo_id,
  pi.mfl_id,
  pi.fantasypros_id,
  pi.pff_id,
  pi.pfr_id,
  pi.ktc_id
from
  scdfl.players p
  left join scdfl.player_ids pi on pi.sleeper_id = p.player_id;


-- -- -- CURRENT-STATE ROSTERS
-- API call; `npm run sync:rosters`

create table scdfl.rosters (
  player_id text not null,
  sleeper_id integer not null,
  constraint rosters_pkey primary key (player_id),
  constraint rosters_player_id_fkey foreign KEY (player_id) references scdfl.players (player_id)
) TABLESPACE pg_default;


-- -- -- DRAFT CONFIGS
-- Manually maintained

create table scdfl.drafts (
  draft_id text not null,
  year integer not null,
  type text not null,
  constraint drafts_pkey primary key (draft_id),
  constraint drafts_year_fkey foreign KEY (year) references scdfl.seasons (year),
  constraint drafts_type_check check (
    (
      type = any (
        array['startup'::text, 'rookie'::text, 'idp'::text]
      )
    )
  )
) TABLESPACE pg_default;


-- -- -- DRAFT RESULTS
-- -- API call; `npm run sync:drafts`

create table scdfl.draft_results (
  draft_id text not null,
  pick_no integer not null,
  round integer not null,
  draft_slot integer not null,
  roster_id integer not null,
  original_roster_id integer not null,
  player_id text not null,
  constraint draft_results_pkey primary key (draft_id, pick_no),
  constraint draft_results_draft_id_fkey foreign KEY (draft_id) references scdfl.drafts (draft_id),
  constraint draft_results_player_id_fkey foreign KEY (player_id) references scdfl.players (player_id)
) TABLESPACE pg_default;

create index IF not exists draft_results_player_id_idx on scdfl.draft_results using btree (player_id) TABLESPACE pg_default;

create index IF not exists draft_results_roster_id_idx on scdfl.draft_results using btree (roster_id) TABLESPACE pg_default;

create index IF not exists draft_results_draft_slot_idx on scdfl.draft_results using btree (draft_id, draft_slot) TABLESPACE pg_default;


-- -- -- TRANSACTIONS
-- API call; `npm run sync:transactions`

create table scdfl.transactions (
  id serial not null,
  transaction_id text not null,
  year integer not null,
  week integer not null,
  type text not null,
  status text not null,
  roster_id integer not null,
  action text not null,
  asset text not null,
  player_id text null,
  pick_season integer null,
  pick_round integer null,
  pick_original_roster_id integer null,
  waiver_bid integer null,
  created bigint not null,
  constraint transactions_pkey primary key (id),
  constraint transactions_natural_key unique NULLS not distinct (
    transaction_id,
    roster_id,
    action,
    asset,
    player_id,
    pick_season,
    pick_round,
    pick_original_roster_id
  ),
  constraint transactions_year_fkey foreign KEY (year) references scdfl.seasons (year),
  constraint transactions_asset_check check (
    (asset = any (array['player'::text, 'pick'::text]))
  ),
  constraint transactions_action_check check ((action = any (array['add'::text, 'drop'::text]))),
  constraint transactions_status_check check (
    (
      status = any (array['complete'::text, 'failed'::text])
    )
  ),
  constraint transactions_type_check check (
    (
      type = any (
        array[
          'trade'::text,
          'waiver'::text,
          'free_agent'::text,
          'commissioner'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists transactions_transaction_id_idx on scdfl.transactions using btree (transaction_id) TABLESPACE pg_default;

create index IF not exists transactions_year_week_idx on scdfl.transactions using btree (year, week) TABLESPACE pg_default;

create index IF not exists transactions_player_id_idx on scdfl.transactions using btree (player_id) TABLESPACE pg_default;

create index IF not exists transactions_roster_id_idx on scdfl.transactions using btree (roster_id) TABLESPACE pg_default;


-- -- -- MATCHUPS
-- API call; `npm run sync:matchups`

create table scdfl.matchups (
  year integer not null,
  week integer not null,
  matchup_id integer not null,
  game_type smallint not null default 0,
  roster_id_a integer not null,
  roster_id_b integer not null,
  score_a numeric null,
  score_b numeric null,
  starters_a text[] null,
  starter_points_a numeric[] null,
  starters_b text[] null,
  starter_points_b numeric[] null,
  constraint matchups_pkey primary key (year, week, matchup_id),
  constraint matchups_year_fkey foreign KEY (year) references scdfl.seasons (year)
) TABLESPACE pg_default;


-- -- -- EXHIBITION CONFIGS
-- Manually maintained

create table scdfl.exhibitions (
  id serial not null,
  year integer not null,
  week integer not null,
  league_id text not null,
  exhib_type text not null,
  team_id_a integer not null,
  team_a_members text[] not null default '{}'::text[],
  team_a_slug text not null,
  team_a_display_name text not null,
  team_id_b integer not null,
  team_b_members text[] not null default '{}'::text[],
  team_b_slug text not null,
  team_b_display_name text not null,
  constraint exhibitions_pkey primary key (id),
  constraint exhibitions_league_id_year_week_key unique (league_id, year, week),
  constraint exhibitions_year_fkey foreign KEY (year) references scdfl.seasons (year)
) TABLESPACE pg_default;


-- -- -- EXHIBITION MATCHUPS
-- API call; `npm run sync:exhibitions`

create table scdfl.exhibition_matchups (
  exhibition_id integer not null,
  score_a numeric null,
  score_b numeric null,
  starters_a text[] null,
  starter_points_a numeric[] null,
  starters_b text[] null,
  starter_points_b numeric[] null,
  constraint exhibition_matchups_pkey primary key (exhibition_id),
  constraint exhibition_matchups_exhibition_id_fkey foreign KEY (exhibition_id) references scdfl.exhibitions (id)
) TABLESPACE pg_default;


-- -- -- SPOTLIGHT GAME METADATA
-- Manually maintained

create table scdfl.spotlight_games (
  slug text not null,
  name text not null,
  type text not null,
  team_a text not null,
  team_b text not null,
  constraint spotlight_games_pkey primary key (slug),
  constraint spotlight_games_type_check check (
    (
      type = any (array['bowl-game'::text, 'rivalry'::text])
    )
  )
) TABLESPACE pg_default;


-- -- -- SPOTLIGHT GAME YEARS OF OCCURRENCE
-- Manually maintained

create table scdfl.spotlight_game_years (
  slug text not null,
  year integer not null,
  constraint spotlight_game_years_pkey primary key (slug, year),
  constraint spotlight_game_years_slug_fkey foreign KEY (slug) references scdfl.spotlight_games (slug),
  constraint spotlight_game_years_year_fkey foreign KEY (year) references scdfl.seasons (year)
) TABLESPACE pg_default;


-- -- -- PLAYER STARTS

create view scdfl.v_player_starts as (
    select
  m.year, m.week,
  m.roster_id_a as roster_id,
  s.player_id,
  p.points
  from scdfl.matchups m
  cross join lateral unnest(m.starters_a) with ordinality as s(player_id, idx)
  cross join lateral unnest(m.starter_points_a) with ordinality as p(points, idx)
  where s.idx = p.idx

      union all

  select
  m.year, m.week,
  m.roster_id_b AS roster_id,
  s.player_id,
  p.points
  from scdfl.matchups m
  cross join lateral unnest(m.starters_b) with ordinality as s(player_id, idx)
  cross join lateral unnest(m.starter_points_b) with ordinality as p(points, idx)
  where s.idx = p.idx
);


-- -- -- PLAYER SEASON STATS

create view scdfl.v_player_season_stats as
select
  vps.player_id,
  vps.year,
  count(*)::integer as games_started,
  round(sum(vps.points), 1) as fpts,
  COALESCE(sum(ns.pass_att), 0::bigint)::integer as pass_att,
  COALESCE(sum(ns.pass_comp), 0::bigint)::integer as pass_comp,
  round(COALESCE(sum(ns.pass_yds), 0::numeric), 0)::integer as pass_yds,
  COALESCE(sum(ns.pass_tds), 0::bigint)::integer as pass_tds,
  COALESCE(sum(ns.rush_att), 0::bigint)::integer as rush_att,
  round(COALESCE(sum(ns.rush_yds), 0::numeric), 0)::integer as rush_yds,
  COALESCE(sum(ns.rush_tds), 0::bigint)::integer as rush_tds,
  COALESCE(sum(ns.receptions), 0::bigint)::integer as receptions,
  round(COALESCE(sum(ns.rec_yds), 0::numeric), 0)::integer as rec_yds,
  COALESCE(sum(ns.rec_tds), 0::bigint)::integer as rec_tds,
  COALESCE(sum(ns.fg_att), 0::bigint)::integer as fg_att,
  COALESCE(sum(ns.fg_made), 0::bigint)::integer as fg_made,
  COALESCE(sum(ns.fg_yds), 0::bigint)::integer as fg_yds,
  COALESCE(sum(ns.solo_tkl), 0::bigint)::integer as solo_tkl,
  COALESCE(sum(ns.asst_tkl), 0::bigint)::integer as asst_tkl,
  round(COALESCE(sum(ns.tfl), 0::numeric), 1) as tfl,
  COALESCE(sum(ns.qb_hit), 0::bigint)::integer as qb_hit,
  COALESCE(sum(ns.pass_defended), 0::bigint)::integer as pass_defended,
  round(COALESCE(sum(ns.sack), 0::numeric), 1) as sack,
  COALESCE(sum(ns.interception), 0::bigint)::integer as interception,
  COALESCE(sum(ns.forced_fumble), 0::bigint)::integer as forced_fumble,
  COALESCE(sum(ns.fumble_recovery), 0::bigint)::integer as fumble_recovery,
  COALESCE(sum(ns.idp_td), 0::bigint)::integer as idp_td
from
  scdfl.v_player_starts vps
  join scdfl.player_ids pids on pids.sleeper_id = vps.player_id
  join scdfl.nfl_stats ns on ns.gsis_id = pids.gsis_id
  and ns.season = vps.year
  and ns.week = vps.week
group by
  vps.player_id,
  vps.year;


-- -- -- NFL STATS
-- External csv; `npm run sync:stats`

create table scdfl.nfl_stats (
  gsis_id text not null,
  season integer not null,
  week integer not null,
  season_type text null,
  pass_att integer null,
  pass_comp integer null,
  pass_yds numeric null,
  pass_tds integer null,
  rush_att integer null,
  rush_yds numeric null,
  rush_tds integer null,
  targets integer null,
  receptions integer null,
  rec_yds numeric null,
  rec_tds integer null,
  fg_att integer null,
  fg_made integer null,
  fg_yds integer null,
  fumbles integer null,
  fum_lost integer null,
  solo_tkl integer null,
  asst_tkl integer null,
  tfl numeric null,
  qb_hit integer null,
  pass_defended integer null,
  sack numeric null,
  interception integer null,
  forced_fumble integer null,
  fumble_recovery integer null,
  safety integer null,
  idp_td integer null,
  constraint nfl_stats_pkey primary key (gsis_id, season, week)
) TABLESPACE pg_default;

create index IF not exists nfl_stats_season_week_idx on scdfl.nfl_stats using btree (season, week) TABLESPACE pg_default;

create index IF not exists nfl_stats_gsis_id_idx on scdfl.nfl_stats using btree (gsis_id) TABLESPACE pg_default;


-- -- -- SEASON-GRAIN FRANCHISE-GRAIN RESULTS
-- API call + manual; `npm run sync:results`

create table scdfl.results (
  sleeper_id text not null,
  year integer not null,
  wins integer not null default 0,
  losses integer not null default 0,
  ties integer not null default 0,
  points_for numeric not null default 0,
  points_against numeric not null default 0,
  playoff boolean null,
  seed integer null,
  finish text null,
  constraint results_pkey primary key (sleeper_id, year),
  constraint results_year_fkey foreign KEY (year) references scdfl.seasons (year)
) TABLESPACE pg_default;


-- -- -- ACCOLADES
-- Manually maintained

create table scdfl.accolades (
  year integer not null,
  award_code text not null,
  award_desc text not null,
  player_id text null,
  sleeper_id text null,
  transaction_id text null,
  vote_share numeric null,
  total_votes integer null,
  constraint accolades_pkey primary key (year, award_code),
  constraint accolades_player_id_fkey foreign KEY (player_id) references scdfl.players (player_id),
  constraint accolades_year_fkey foreign KEY (year) references scdfl.seasons (year),
  constraint accolades_check check (
    (
      (
        (
          ((player_id is not null))::integer + ((sleeper_id is not null))::integer
        ) + ((transaction_id is not null))::integer
      ) = 1
    )
  ),
  constraint accolades_total_votes_check check (
    (
      (total_votes is null)
      or (total_votes > 0)
    )
  ),
  constraint accolades_vote_share_check check (
    (
      (vote_share is null)
      or (
        (vote_share >= (0)::numeric)
        and (vote_share <= (1)::numeric)
      )
    )
  )
) TABLESPACE pg_default;