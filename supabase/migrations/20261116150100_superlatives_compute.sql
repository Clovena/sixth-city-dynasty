-- Superlatives race: the computation (SUPERLATIVES.md §3–§4, §6).
--
-- Pure: one call = one season at one as_of_week, returned as rows in the
-- shape of scdfl.superlative_leaders (§5). It writes nothing — the
-- `superlatives` sync step (supabase/functions/_shared/sync/superlatives.ts)
-- writes the rows and freezes the Week 14 snapshot. Try it:
--   select award_code, rank, franchise_abbr, headline from scdfl.compute_superlative_leaders(2025, 14);
--
-- Built from temp tables that drop at commit, so call it once per
-- transaction (a second call in the same transaction trips over the
-- first call's tables). The §6 knobs are the k_* declarations below;
-- p_top (default 5) and p_pick_horizon (default 1 season) are exposed as
-- parameters so the §7 backtest can look at a top eight under either horizon.

create or replace function scdfl.compute_superlative_leaders(p_season int, p_as_of_week int, p_top int default 5, p_pick_horizon int default 1)
returns table (
  award_code text, rank int, player_id text, sleeper_id text, transaction_id text,
  franchise_abbr text, score numeric, headline text, detail_lines text[], flags text[], payload jsonb
)
language plpgsql
set search_path = scdfl, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_as_of int := least(greatest(coalesce(p_as_of_week, 0), 0), 14);
  v_sleeper_season int;           -- what players.years_exp is relative to (§2.8)
  v_current boolean;              -- p_season is the season in progress → rosters/injury_status apply
  v_waiver_start bigint;          -- epoch ms
  v_have_adp boolean;
  v_have_lines boolean;
  v_playoff_teams int;
  v_rookie_bust_pool int;

  -- §6 knobs
  k_include_kickers       boolean := false;
  k_qualified_start_rate  numeric := 0.5;
  k_mvp_start_rate_min    numeric := 0.75;
  k_mvp_team_win_pct_min  numeric := 0.5;
  k_established_rank      int     := 14;
  k_min_games_season      int     := 6;
  k_breakout_ratio        numeric := 0.65;
  k_comeback_down_ratio   numeric := 0.6;
  k_waiver_min_games      int     := 3;
  k_bust_k                numeric := 5;     -- bust_rank_smoothing
  k_rookie_bust_max_round int     := 2;
  k_rookie_bust_min_pool  int     := 8;
  k_rookie_bust_fallback  int     := 20;
  k_trade_balance_gate    numeric := 0.5;
  k_geriatric_qb          int     := 13;
  k_geriatric_skill       int     := 9;
  k_geriatric_idp         int     := 11;
  k_geriatric_near_margin int     := 1;
  k_geriatric_near_penalty numeric := 0.25;
  k_roty_min_starts       int     := 2;
  k_vroty_min_pick        int     := 15;
  k_undrafted_pick        int     := 57;
  k_injury_min_spell      int     := 2;
  k_pick_horizon          int     := coalesce(p_pick_horizon, 1);  -- seasons; the tuning log's recommendation
  k_capital_weight        numeric := 1.0;
  k_reversal_days         int     := 14;
  k_include_ros           boolean := true;
  k_lopsided_min_value    numeric := 100;
  k_moty_w_win            numeric := 1;
  k_moty_w_line           numeric := 1;
  k_moty_w_pf             numeric := 0.5;
  k_mif_w_dwin            numeric := 1;
  k_mif_w_dppg            numeric := 1;
  k_mif_w_win             numeric := 0.5;
begin
  select max(year) into v_sleeper_season from scdfl.seasons;
  v_sleeper_season := greatest(v_sleeper_season, p_season);
  v_current := (p_season = v_sleeper_season);
  select coalesce(max(playoff_teams), 7) into v_playoff_teams from scdfl.seasons where year = p_season;

  create temp table t_out (
    award_code text, rank int, player_id text, sleeper_id text, transaction_id text,
    franchise_abbr text, score numeric, headline text, detail_lines text[], flags text[], payload jsonb
  ) on commit drop;

  if v_as_of = 0 then
    return;
  end if;

  -- =========================================================================
  -- Franchise identities for this season and the one before
  -- =========================================================================
  create temp table t_fr on commit drop as
  select f.id as roster_id, f.abbr, f.name, f.conf, f.owner, scdfl.sl_abbr(f.id, 9999) as active_abbr
  from scdfl.franchises f
  where f."from" <= p_season and (f."to" is null or f."to" >= p_season);

  -- =========================================================================
  -- Players: bucket, experience relative to this season, crosswalk
  -- =========================================================================
  create temp table t_pl on commit drop as
  select p.player_id, scdfl.pos_bucket(p.position) as pos, p.position as raw_pos,
         p.years_exp - (v_sleeper_season - p_season) as season_exp,
         p.team, p.injury_status, p.first_name, p.last_name,
         trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as full_name,
         pi.gsis_id
  from scdfl.players p
  left join scdfl.player_ids pi on pi.sleeper_id = p.player_id;
  create index on t_pl (player_id);
  create index on t_pl (gsis_id);
  analyze t_pl;

  -- One pass over nfl_stats. The instance is I/O-bound (a few MB/s), and five
  -- separate joins against the base table cost more than everything else
  -- combined; every later join reads this indexed copy instead.
  create temp table t_ns on commit drop as
  select ns.gsis_id, ns.season, ns.week,
         ns.pass_yds, ns.pass_tds, ns.rush_att, ns.rush_yds, ns.rush_tds, ns.receptions, ns.rec_yds, ns.rec_tds,
         ns.solo_tkl, ns.asst_tkl, ns.tfl, ns.qb_hit, ns.pass_defended, ns.sack, ns.interception, ns.fg_made, ns.fg_att
  from scdfl.nfl_stats ns
  where ns.season_type = 'REG' and ns.season <= p_season and (ns.season < p_season or ns.week <= v_as_of);
  create index on t_ns (gsis_id, season, week);
  analyze t_ns;

  -- =========================================================================
  -- B7. NFL team-weeks (byes, missed games). nfl_schedule first; if it has
  -- nothing for this season, infer from the stat feed (≥15 stat rows = played).
  -- =========================================================================
  create temp table t_team_weeks on commit drop as
  select team, week from (
    select home_team as team, week from scdfl.nfl_schedule where season = p_season and game_type = 'REG'
    union
    select away_team, week from scdfl.nfl_schedule where season = p_season and game_type = 'REG'
  ) s where week <= v_as_of;

  if not exists (select 1 from t_team_weeks) then
    insert into t_team_weeks
    select pl.team, ns.week
    from t_pl pl
    join t_ns ns on ns.gsis_id = pl.gsis_id and ns.season = p_season
    where pl.team is not null
    group by pl.team, ns.week
    having count(*) >= 15;
  end if;

  create temp table t_bye on commit drop as
  select t.team, v_as_of - count(tw.week) as bye_weeks
  from (select distinct team from t_team_weeks) t
  left join t_team_weeks tw on tw.team = t.team
  group by t.team;

  -- =========================================================================
  -- Starts (§2.5): rows of v_player_starts through as_of_week. "Played" =
  -- has an nfl_stats REG row that week, or scored (rookies with no gsis_id).
  -- =========================================================================
  create temp table t_starts on commit drop as
  select v.week, v.roster_id, v.player_id, v.points::numeric as points,
         (ns.gsis_id is not null or v.points <> 0) as played
  from scdfl.v_player_starts v
  left join t_pl pl on pl.player_id = v.player_id
  left join t_ns ns on ns.gsis_id = pl.gsis_id and ns.season = v.year and ns.week = v.week
  where v.year = p_season and v.week <= v_as_of;
  create index on t_starts (player_id);
  create index on t_starts (roster_id, player_id);
  analyze t_starts;

  -- Stat lines over started weeks (same window as the fpts figure).
  create temp table t_stat on commit drop as
  select s.player_id,
         sum(ns.pass_yds) as pass_yds, sum(ns.pass_tds) as pass_tds,
         sum(ns.rush_att) as rush_att, sum(ns.rush_yds) as rush_yds, sum(ns.rush_tds) as rush_tds,
         sum(ns.receptions) as receptions, sum(ns.rec_yds) as rec_yds, sum(ns.rec_tds) as rec_tds,
         sum(coalesce(ns.solo_tkl, 0) + coalesce(ns.asst_tkl, 0)) as tkl, sum(ns.tfl) as tfl, sum(ns.sack) as sack,
         sum(ns.qb_hit) as qb_hit, sum(ns.pass_defended) as pbu, sum(ns.interception) as interception,
         sum(ns.fg_made) as fg_made, sum(ns.fg_att) as fg_att,
         count(*) as nfl_games
  from (select distinct player_id, week from t_starts) s
  join t_pl pl on pl.player_id = s.player_id
  join t_ns ns on ns.gsis_id = pl.gsis_id and ns.season = p_season and ns.week = s.week
  group by s.player_id;

  -- =========================================================================
  -- B1. One row per started player
  -- =========================================================================
  create temp table t_player on commit drop as
  with agg as (
    select player_id, count(*) as starts, count(*) filter (where played) as games, sum(points) as fpts
    from t_starts group by player_id
  ), fr as (
    select player_id, roster_id, count(*) as n, min(week) as first_week, max(week) as last_week
    from t_starts group by player_id, roster_id
  ), primary_fr as (
    select distinct on (player_id) player_id, roster_id from fr order by player_id, n desc, last_week desc
  ), recent_fr as (
    select distinct on (player_id) player_id, roster_id from fr order by player_id, last_week desc
  ), multi as (
    select fr.player_id, string_agg(f.abbr, '/' order by fr.first_week) as abbrs, count(*) as cnt
    from fr join t_fr f on f.roster_id = fr.roster_id where fr.n >= 2 group by fr.player_id
  ), rostered as (
    select r.player_id, r.sleeper_id as roster_id from scdfl.rosters r where v_current
  )
  select a.player_id, pl.pos, pl.season_exp, a.starts, a.games, a.fpts,
         a.fpts / nullif(a.games, 0) as ppg,
         a.starts::numeric / greatest(v_as_of - coalesce(b.bye_weeks, 0), 1) as start_rate,
         pf.roster_id as primary_roster_id,
         coalesce(ro.roster_id, rf.roster_id) as display_roster_id,
         case when m.cnt >= 2 then m.abbrs else fd.abbr end as display_abbr,
         fd.active_abbr as display_active_abbr
  from agg a
  join t_pl pl on pl.player_id = a.player_id
  left join t_bye b on b.team = pl.team
  left join primary_fr pf on pf.player_id = a.player_id
  left join recent_fr rf on rf.player_id = a.player_id
  left join rostered ro on ro.player_id = a.player_id
  left join multi m on m.player_id = a.player_id
  left join t_fr fd on fd.roster_id = coalesce(ro.roster_id, rf.roster_id);
  create index on t_player (player_id);
  analyze t_player;

  -- =========================================================================
  -- B2. Starters per position, replacement level, positional z-scores
  -- =========================================================================
  create temp table t_npos on commit drop as
  select pl.pos,
         round(count(*)::numeric / v_as_of)::int as n_pos,
         sum(s.points) / nullif(count(*) filter (where s.played), 0) as avg_pts_per_played_start
  from t_starts s join t_pl pl on pl.player_id = s.player_id
  where pl.pos is not null
  group by pl.pos;

  create temp table t_repl on commit drop as
  with pool as (
    select p.pos, p.ppg, row_number() over (partition by p.pos order by p.ppg desc) as rn
    from t_player p
    where p.pos is not null and p.games >= greatest(3, ceil(v_as_of / 3.0))
  )
  select n.pos, n.n_pos,
         coalesce((select ppg from pool where pool.pos = n.pos and pool.rn = n.n_pos),
                  0.75 * n.avg_pts_per_played_start) as repl_ppg,
         (select count(*) from pool where pool.pos = n.pos) as pool_n
  from t_npos n;

  create temp table t_posz on commit drop as
  select pos, avg(ppg) as mean_ppg, stddev_samp(ppg) as sd_ppg, count(*) as qual_n
  from t_player
  where pos is not null and games > 0 and starts >= greatest(3, k_qualified_start_rate * v_as_of)
  group by pos;

  alter table t_player add column vorp numeric, add column ppg_z numeric, add column qualified boolean;
  update t_player p set
    vorp = p.fpts - p.games * r.repl_ppg,
    ppg_z = (p.ppg - z.mean_ppg) / nullif(z.sd_ppg, 0),
    qualified = (p.games > 0 and p.starts >= greatest(3, k_qualified_start_rate * v_as_of))
  from t_repl r left join t_posz z on z.pos = r.pos
  where r.pos = p.pos;

  -- =========================================================================
  -- B3. Baselines: all NFL games per season before this one (windows table)
  -- =========================================================================
  -- The windows table has no index; copy the seasons we need and analyze
  -- so the join to nfl_stats is planned on real numbers.
  create temp table t_windows on commit drop as
  select w.player_id, w.season::int as season, w.week::int as week, w.points::numeric as points
  from sandbox.player_windows_thru_2025 w
  where w.season < p_season;
  create index on t_windows (player_id);
  analyze t_windows;

  create temp table t_base on commit drop as
  select w.player_id, w.season,
         count(*) filter (where ns.gsis_id is not null or (pl.gsis_id is null and w.points <> 0)) as games_s,
         sum(w.points) as pts_s
  from t_windows w
  join t_pl pl on pl.player_id = w.player_id
  left join t_ns ns on ns.gsis_id = pl.gsis_id and ns.season = w.season and ns.week = w.week
  group by w.player_id, w.season;
  create index on t_base (player_id, season);
  analyze t_base;

  create temp table t_estab on commit drop as
  select pos, season, ppg_s as estab_ppg from (
    select pl.pos, b.season, b.pts_s / b.games_s as ppg_s,
           row_number() over (partition by pl.pos, b.season order by b.pts_s / b.games_s desc) as rn
    from t_base b join t_pl pl on pl.player_id = b.player_id
    where b.games_s >= k_min_games_season and pl.pos is not null
  ) x where rn = k_established_rank;

  create temp table t_career on commit drop as
  select b.player_id,
         sum(b.games_s) as career_games, sum(b.pts_s) as career_pts,
         sum(b.pts_s) / nullif(sum(b.games_s), 0) as career_ppg,
         bool_or(b.games_s >= k_min_games_season and b.pts_s / nullif(b.games_s, 0) >= e.estab_ppg) as ever_established,
         bool_or(b.season < p_season - 1 and b.games_s >= k_min_games_season and b.pts_s / nullif(b.games_s, 0) >= e.estab_ppg) as established_pre_down,
         max(b.pts_s / nullif(b.games_s, 0)) filter (where b.season < p_season - 1 and b.games_s >= k_min_games_season and b.pts_s / nullif(b.games_s, 0) >= e.estab_ppg) as peak_ppg,
         max(b.games_s) filter (where b.season = p_season - 1) as games_down,
         max(b.pts_s) filter (where b.season = p_season - 1) as pts_down
  from t_base b
  join t_pl pl on pl.player_id = b.player_id
  left join t_estab e on e.pos = pl.pos and e.season = b.season
  group by b.player_id;

  -- =========================================================================
  -- B4. Preseason expectations (Sleeper ADP; 2026 only)
  -- =========================================================================
  create temp table t_adp on commit drop as
  select pr.player_id::text as player_id, pr.adp_idp::numeric as adp_idp, pr.pts_ppr::numeric as proj_pts, pl.pos,
         row_number() over (partition by pl.pos order by pr.adp_idp) as adp_pos_rank
  from sandbox.player_projections_2026 pr
  join t_pl pl on pl.player_id = pr.player_id::text
  where pr.season = p_season and pr.adp_idp < 999 and pl.pos is not null;
  create index on t_adp (player_id);
  analyze t_adp;
  v_have_adp := exists (select 1 from t_adp);

  -- =========================================================================
  -- B5. Franchise seasons (this season to date, last season in full)
  -- =========================================================================
  create temp table t_fs on commit drop as
  with g as (
    select m.year, m.week, m.roster_id_a as roster_id, m.score_a as pf, m.score_b as pa
    from scdfl.matchups m where m.game_type = 0 and m.year in (p_season, p_season - 1)
      and ((m.year = p_season and m.week <= v_as_of) or (m.year < p_season and m.week <= 14))
    union all
    select m.year, m.week, m.roster_id_b, m.score_b, m.score_a
    from scdfl.matchups m where m.game_type = 0 and m.year in (p_season, p_season - 1)
      and ((m.year = p_season and m.week <= v_as_of) or (m.year < p_season and m.week <= 14))
  ), agg as (
    select year, roster_id, count(*) as games,
           count(*) filter (where pf > pa) as wins, count(*) filter (where pf < pa) as losses, count(*) filter (where pf = pa) as ties,
           sum(pf) as pf, sum(pa) as pa
    from g group by year, roster_id
  )
  select a.*,
         (a.wins + 0.5 * a.ties) / nullif(a.games, 0) as win_pct,
         a.pf / nullif(a.games, 0) as pf_pg,
         rank() over (partition by a.year order by a.pf desc) as pf_rank,
         rank() over (partition by a.year order by a.pa asc) as pa_rank,
         row_number() over (partition by a.year order by (a.wins + 0.5 * a.ties) / nullif(a.games, 0) desc, a.pf desc) as standing
  from agg a;

  v_have_lines := exists (select 1 from scdfl.projections pj where pj.year = p_season and pj.win_ou is not null);

  -- =========================================================================
  -- B6. What a rookie pick is worth, in started points
  -- =========================================================================
  create temp table t_pickval on commit drop as
  with picks as (
    select dr.round, dr.player_id, d.year
    from scdfl.draft_results dr join scdfl.drafts d on d.draft_id = dr.draft_id
    where d.type = 'rookie' and d.year <= p_season - k_pick_horizon
  ), pts as (
    select p.round, p.player_id, p.year, coalesce(sum(v.points), 0)::numeric as pts
    from picks p
    left join scdfl.v_player_starts v on v.player_id = p.player_id and v.week <= 14
      and v.year between p.year and p.year + k_pick_horizon - 1
    group by p.round, p.player_id, p.year
  )
  select round, avg(pts) as pick_value, count(*) as sample from pts group by round;

  -- =========================================================================
  -- Awards 4.1 / 4.6 / 4.5 / 4.2 / 4.4 / 4.7 — straight off B1–B3
  -- =========================================================================

  -- 4.1 MVP
  insert into t_out
  select 'mvp', row_number() over (order by p.vorp desc, p.fpts / nullif(fs.pf, 0) desc, p.ppg desc),
         p.player_id, null, null, p.display_abbr, round(p.vorp, 3),
         format('%s games, %s fpts (%s ppg)', p.games, scdfl.sl_fmt(p.fpts), scdfl.sl_fmt(p.ppg)),
         array_remove(array[
           scdfl.sl_stat_line(p.pos, to_jsonb(st)),
           format('%s %s-%s%s, %s%% of club points', f.abbr, fs.wins, fs.losses, case when fs.ties > 0 then '-' || fs.ties else '' end,
                  scdfl.sl_fmt(100 * p.fpts / nullif(fs.pf, 0), 1))
         ], null),
         '{}'::text[],
         jsonb_build_object('starts', p.starts, 'games', p.games, 'fpts', round(p.fpts, 2), 'ppg', round(p.ppg, 2),
                            'vorp', round(p.vorp, 2), 'ppg_z', round(p.ppg_z, 3), 'start_rate', round(p.start_rate, 3),
                            'team_share', round(p.fpts / nullif(fs.pf, 0), 4), 'team_win_pct', round(fs.win_pct, 3), 'pos', p.pos)
  from t_player p
  join t_fs fs on fs.year = p_season and fs.roster_id = p.primary_roster_id
  join t_fr f on f.roster_id = p.primary_roster_id
  left join t_stat st on st.player_id = p.player_id
  where p.season_exp >= 1 and p.start_rate >= k_mvp_start_rate_min and fs.win_pct >= k_mvp_team_win_pct_min
    and (k_include_kickers or p.pos <> 'K') and p.pos is not null and p.games > 0;

  -- 4.6 Rookie of the Year
  insert into t_out
  select 'roty', row_number() over (order by p.vorp desc, p.ppg desc),
         p.player_id, null, null, p.display_abbr, round(p.vorp, 3),
         format('%s games, %s fpts (%s ppg)', p.games, scdfl.sl_fmt(p.fpts), scdfl.sl_fmt(p.ppg)),
         array_remove(array[scdfl.sl_stat_line(p.pos, to_jsonb(st))], null),
         '{}'::text[],
         jsonb_build_object('starts', p.starts, 'games', p.games, 'fpts', round(p.fpts, 2), 'ppg', round(p.ppg, 2),
                            'vorp', round(p.vorp, 2), 'start_rate', round(p.start_rate, 3), 'pos', p.pos)
  from t_player p
  left join t_stat st on st.player_id = p.player_id
  where p.season_exp = 0 and p.starts >= k_roty_min_starts and (k_include_kickers or p.pos <> 'K') and p.pos is not null and p.games > 0;

  -- 4.5 Old Man of the Year
  insert into t_out
  select 'geriatric', row_number() over (order by g.score desc, g.season_exp desc),
         g.player_id, null, null, g.display_abbr, round(g.score, 3),
         format('%s games, %s fpts (%s ppg)', g.games, scdfl.sl_fmt(g.fpts), scdfl.sl_fmt(g.ppg)),
         array_remove(array[format('%s NFL season', scdfl.sl_ordinal(g.season_exp + 1)), scdfl.sl_stat_line(g.pos, to_jsonb(st))], null),
         case when g.near then array['near_threshold'] else '{}'::text[] end,
         jsonb_build_object('games', g.games, 'fpts', round(g.fpts, 2), 'ppg', round(g.ppg, 2), 'ppg_z', round(g.ppg_z, 3),
                            'season_exp', g.season_exp, 'threshold', g.threshold, 'start_rate', round(g.start_rate, 3), 'pos', g.pos)
  from (
    select p.*, t.threshold, (p.season_exp < t.threshold) as near,
           p.ppg_z - case when p.season_exp < t.threshold then k_geriatric_near_penalty else 0 end as score
    from t_player p
    cross join lateral (select case p.pos when 'QB' then k_geriatric_qb when 'RB' then k_geriatric_skill when 'WR' then k_geriatric_skill
                                          when 'TE' then k_geriatric_skill else k_geriatric_idp end as threshold) t
    where p.pos is not null and p.pos <> 'K' and p.ppg_z is not null
      and p.season_exp >= t.threshold - k_geriatric_near_margin and p.start_rate >= k_qualified_start_rate
  ) g
  left join t_stat st on st.player_id = g.player_id;

  -- 4.2 Breakout
  insert into t_out
  select 'breakout', row_number() over (order by b.score desc, b.vorp desc),
         b.player_id, null, null, b.display_abbr, round(b.score, 3),
         format('%s games, %s fpts (%s ppg)', b.games, scdfl.sl_fmt(b.fpts), scdfl.sl_fmt(b.ppg)),
         array_remove(array[
           scdfl.sl_stat_line(b.pos, to_jsonb(st)),
           format('Prior to %s: %s games, %s ppg', p_season, coalesce(b.career_games, 0), scdfl.sl_fmt(coalesce(b.career_ppg, 0), 1))
         ], null),
         '{}'::text[],
         jsonb_build_object('games', b.games, 'fpts', round(b.fpts, 2), 'ppg', round(b.ppg, 2), 'vorp', round(b.vorp, 2),
                            'career_games', b.career_games, 'career_ppg', round(b.career_ppg, 2), 'improvement_z', round(b.score, 3), 'pos', b.pos)
  from (
    select p.*, c.career_games, c.career_ppg, (p.ppg - coalesce(c.career_ppg, 0)) / nullif(z.sd_ppg, 0) as score
    from t_player p
    left join t_career c on c.player_id = p.player_id
    join t_repl r on r.pos = p.pos
    join t_posz z on z.pos = p.pos
    where p.season_exp >= 1 and p.start_rate >= k_qualified_start_rate and p.ppg >= r.repl_ppg
      and (k_include_kickers or p.pos <> 'K')
      and not coalesce(c.ever_established, false)
      and coalesce(c.career_ppg, 0) <= k_breakout_ratio * p.ppg
  ) b
  left join t_stat st on st.player_id = b.player_id
  where b.score is not null;

  -- 4.4 Comeback
  insert into t_out
  select 'comeback', row_number() over (order by c.score desc, c.vorp desc),
         c.player_id, null, null, c.display_abbr, round(c.score, 3),
         format('%s games, %s fpts (%s ppg)', c.games, scdfl.sl_fmt(c.fpts), scdfl.sl_fmt(c.ppg)),
         array_remove(array[
           scdfl.sl_stat_line(c.pos, to_jsonb(st)),
           format('%s total season: %s games, %s ppg', p_season - 1, coalesce(c.games_down, 0),
                  scdfl.sl_fmt(coalesce(c.pts_down / nullif(c.games_down, 0), 0), 1))
         ], null),
         '{}'::text[],
         jsonb_build_object('games', c.games, 'fpts', round(c.fpts, 2), 'ppg', round(c.ppg, 2), 'vorp', round(c.vorp, 2),
                            'peak_ppg', round(c.peak_ppg, 2), 'down_games', c.games_down, 'down_ppw', round(c.ppw_down, 2),
                            'rebound_z', round(c.score, 3), 'pos', c.pos)
  from (
    select p.*, k.peak_ppg, k.games_down, k.pts_down, coalesce(k.pts_down, 0) / 17 as ppw_down,
           (p.ppg - coalesce(k.pts_down, 0) / 17) / nullif(z.sd_ppg, 0) as score
    from t_player p
    join t_career k on k.player_id = p.player_id
    join t_repl r on r.pos = p.pos
    join t_posz z on z.pos = p.pos
    where p.season_exp >= 2 and k.established_pre_down
      and coalesce(k.pts_down, 0) / 17 <= k_comeback_down_ratio * k.peak_ppg
      and p.start_rate >= k_qualified_start_rate and p.ppg >= r.repl_ppg
      and (k_include_kickers or p.pos <> 'K')
  ) c
  left join t_stat st on st.player_id = c.player_id
  where c.score is not null;

  -- 4.7 Value Rookie
  create temp table t_rookie_draft on commit drop as
  select dr.player_id, dr.round, dr.pick_no, dr.roster_id, dr.original_roster_id, ((dr.pick_no - 1) % 14) + 1 as slot
  from scdfl.draft_results dr join scdfl.drafts d on d.draft_id = dr.draft_id
  where d.type = 'rookie' and d.year = p_season;

  insert into t_out
  select 'vroty', row_number() over (order by v.score desc, v.fpts desc),
         v.player_id, null, null, v.display_abbr, round(v.score, 3),
         format('%s games, %s fpts (%s ppg)', v.games, scdfl.sl_fmt(v.fpts), scdfl.sl_fmt(v.ppg)),
         array_remove(array[
           case when v.undrafted then 'Undrafted' else format('Drafted %s.%s (%s ovr)', v.round, lpad(v.slot::text, 2, '0'), scdfl.sl_ordinal(v.pick_no)) end,
           scdfl.sl_stat_line(v.pos, to_jsonb(st))
         ], null),
         case when v.undrafted then array['undrafted'] else '{}'::text[] end,
         jsonb_build_object('games', v.games, 'fpts', round(v.fpts, 2), 'ppg', round(v.ppg, 2), 'vorp', round(v.vorp, 2),
                            'overall_pick', v.pick_no, 'round', v.round, 'weight', round(ln((1 + v.pick_no)::numeric), 3),
                            'vs_round_expectation', round(v.fpts - coalesce(pv.pick_value, 0), 2), 'pos', v.pos)
  from (
    select p.*, coalesce(d.pick_no, k_undrafted_pick) as pick_no, d.round, d.slot, (d.player_id is null) as undrafted,
           p.fpts * ln((1 + coalesce(d.pick_no, k_undrafted_pick))::numeric) as score
    from t_player p
    left join t_rookie_draft d on d.player_id = p.player_id
    where p.season_exp = 0 and p.starts >= k_roty_min_starts and (k_include_kickers or p.pos <> 'K') and p.pos is not null
      and coalesce(d.pick_no, k_undrafted_pick) >= k_vroty_min_pick
  ) v
  left join t_stat st on st.player_id = v.player_id
  left join t_pickval pv on pv.round = v.round;

  -- =========================================================================
  -- 4.3 Waiver Pickup. Window opens the day after the rookie draft, inferred
  -- as the last trade that moved a current-season pick (Jul 18 for 2026).
  -- =========================================================================
  select coalesce(max(created), 0) + 86400000 into v_waiver_start
  from scdfl.transactions
  where year = p_season and type = 'trade' and status = 'complete' and asset = 'pick' and pick_season = p_season;
  if v_waiver_start <= 86400000 then
    v_waiver_start := extract(epoch from make_timestamptz(p_season, 7, 19, 0, 0, 0, 'America/New_York'))::bigint * 1000;
  end if;
  -- Truncate to the start of that day, ET
  v_waiver_start := extract(epoch from date_trunc('day', to_timestamp(v_waiver_start / 1000.0) at time zone 'America/New_York') at time zone 'America/New_York')::bigint * 1000;

  create temp table t_claim on commit drop as
  select distinct on (t.player_id) t.player_id, t.roster_id, t.week as claim_week, t.created, coalesce(t.waiver_bid, 0) as bid,
         (select count(distinct x.roster_id) from scdfl.transactions x
           where x.year = p_season and x.type = 'waiver' and x.action = 'add' and x.status = 'failed'
             and x.player_id = t.player_id and x.week = t.week and x.roster_id <> t.roster_id) as other_bids
  from scdfl.transactions t
  where t.year = p_season and t.type = 'waiver' and t.action = 'add' and t.status = 'complete' and t.created >= v_waiver_start
  order by t.player_id, t.created;

  insert into t_out
  select 'waiver', row_number() over (order by w.vorp_since desc, w.fpts_since desc),
         w.player_id, null, null, w.display_abbr, round(w.vorp_since, 3),
         format('%s games, %s fpts (%s ppg)', w.games_since, scdfl.sl_fmt(w.fpts_since), scdfl.sl_fmt(w.fpts_since / nullif(w.games_since, 0))),
         array_remove(array[
           format('$%s FAAB, %s other %s · claimed Week %s by %s', w.bid, w.other_bids, case when w.other_bids = 1 then 'bid' else 'bids' end, w.claim_week, cf.abbr),
           scdfl.sl_stat_line(w.pos, to_jsonb(st))
         ], null),
         '{}'::text[],
         jsonb_build_object('games_since', w.games_since, 'fpts_since', round(w.fpts_since, 2), 'vorp_since', round(w.vorp_since, 2),
                            'claim_week', w.claim_week, 'claimed_by', cf.abbr, 'bid', w.bid, 'other_bids', w.other_bids,
                            'claimed_on', to_char(to_timestamp(w.created / 1000.0) at time zone 'America/New_York', 'YYYY-MM-DD'), 'pos', w.pos)
  from (
    select c.*, p.pos, p.display_abbr, s.games_since, s.fpts_since, s.fpts_since - s.games_since * r.repl_ppg as vorp_since
    from t_claim c
    join t_player p on p.player_id = c.player_id
    join t_repl r on r.pos = p.pos
    cross join lateral (
      select count(*) filter (where played) as games_since, coalesce(sum(points), 0) as fpts_since
      from t_starts st where st.player_id = c.player_id and st.week >= c.claim_week
    ) s
    where (k_include_kickers or p.pos <> 'K') and s.games_since >= k_waiver_min_games
  ) w
  join t_fr cf on cf.roster_id = w.roster_id
  left join t_stat st on st.player_id = w.player_id;

  -- =========================================================================
  -- 4.10 Tough Break. Missed games = team played, no stat row. Spells of
  -- consecutive misses; the costliest per player; overrides on top.
  -- =========================================================================
  create temp table t_inj_cand on commit drop as
  select pl.player_id, pl.team, pl.gsis_id
  from t_pl pl
  where pl.gsis_id is not null and pl.team is not null and pl.pos is not null and pl.pos <> 'K'
    -- a semi-join, not three OR'd EXISTS: those ran as per-row subplans over 20k players
    and pl.player_id in (
      select s.player_id from t_starts s
      union select a.player_id from t_adp a
      union select r.player_id from scdfl.rosters r where v_current);

  create temp table t_inj_weeks on commit drop as
  select c.player_id, tw.week, (ns.gsis_id is not null) as played
  from t_inj_cand c
  join t_team_weeks tw on tw.team = c.team
  left join t_ns ns on ns.gsis_id = c.gsis_id and ns.season = p_season and ns.week = tw.week;
  create index on t_inj_weeks (player_id);

  create temp table t_spell on commit drop as
  with seq as (
    select player_id, week, played,
           row_number() over (partition by player_id order by week) as rn,
           row_number() over (partition by player_id, played order by week) as rp
    from t_inj_weeks
  ), grp as (
    select player_id, min(week) as injury_week, max(week) as last_missed, count(*)::int as missed
    from seq where not played group by player_id, rn - rp
  ), ranked as (
    select g.*, row_number() over (partition by player_id order by missed desc, injury_week) as k from grp g
  )
  select r.player_id, r.injury_week, r.last_missed, r.missed,
         (select min(w.week) from t_inj_weeks w where w.player_id = r.player_id and w.week > r.last_missed and w.played) as return_week,
         false as overridden
  from ranked r
  where r.k = 1 and r.missed >= k_injury_min_spell
    -- an override row of any kind replaces (or removes) the detected spell
    and not exists (select 1 from scdfl.injury_overrides o where o.year = p_season and o.player_id = r.player_id);
  alter table t_spell add primary key (player_id);

  insert into t_spell (player_id, injury_week, last_missed, missed, return_week, overridden)
  select o.player_id, o.injury_week, coalesce(o.return_week - 1, v_as_of),
         coalesce(nullif((select count(*) from t_inj_weeks w where w.player_id = o.player_id
                            and w.week between o.injury_week and coalesce(o.return_week - 1, v_as_of)), 0)::int,
                  greatest(coalesce(o.return_week - 1, v_as_of) - o.injury_week + 1, 0)),
         o.return_week, true
  from scdfl.injury_overrides o
  where o.year = p_season and o.action in ('include', 'adjust') and o.injury_week is not null and o.injury_week <= v_as_of;

  create temp table t_injury on commit drop as
  select sp.*, pl.pos, pl.injury_status, pl.team,
         coalesce(pre.pre_games, 0) as pre_games, coalesce(pre.pre_fpts, 0) as pre_fpts,
         coalesce(case when pre.pre_games >= 2 then pre.pre_fpts / pre.pre_games end,
                  case when b.games_s > 0 then b.pts_s / b.games_s end,
                  ad.proj_pts / 17) as pre_ppg,
         case when pre.pre_games >= 2 then 'starts' when b.games_s > 0 then 'last_season' when ad.proj_pts is not null then 'projection' end as pre_src,
         case when b.games_s >= k_min_games_season then b.pts_s / b.games_s end as prev_ppg,
         (sp.return_week is null and (sp.last_missed >= coalesce((select max(week) from t_inj_weeks w where w.player_id = sp.player_id), sp.last_missed)
                                      or (v_current and coalesce(pl.injury_status, '') in ('IR', 'PUP', 'Out')))) as ongoing,
         ad.adp_pos_rank, ad.adp_idp, o.note,
         (exists (select 1 from t_starts s where s.player_id = sp.player_id and s.week < sp.injury_week)
          or (v_current and exists (select 1 from scdfl.rosters r where r.player_id = sp.player_id))) as on_roster,
         coalesce(
           (select x.roster_id from (
              select t.roster_id, t.year, t.week, t.created from scdfl.transactions t
               where t.player_id = sp.player_id and t.status = 'complete' and t.action = 'add' and t.asset = 'player'
                 and t.type in ('waiver', 'free_agent', 'trade', 'commissioner')
                 and (t.year < p_season or (t.year = p_season and t.week <= sp.injury_week))
              union all
              select dr.roster_id, d.year, 0, 0 from scdfl.draft_results dr join scdfl.drafts d on d.draft_id = dr.draft_id
               where dr.player_id = sp.player_id and d.year <= p_season
            ) x order by x.year desc, x.week desc, x.created desc limit 1),
           (select s.roster_id from t_starts s where s.player_id = sp.player_id and s.week < sp.injury_week order by s.week desc limit 1),
           (select r.sleeper_id from scdfl.rosters r where v_current and r.player_id = sp.player_id limit 1)
         ) as credit_roster_id
  from t_spell sp
  join t_pl pl on pl.player_id = sp.player_id
  -- His SCDFL starts this season, before and after the spell: last year's
  -- ballot cards priced the injury on the season's starts (Burrow: 4 games,
  -- 15.1 ppg), and a pre-spell-only sample can be two bad weeks.
  left join lateral (
    select count(*) filter (where played) as pre_games, sum(points) filter (where played) as pre_fpts
    from t_starts s where s.player_id = sp.player_id
  ) pre on true
  left join t_base b on b.player_id = sp.player_id and b.season = p_season - 1
  left join t_adp ad on ad.player_id = sp.player_id
  left join scdfl.injury_overrides o on o.year = p_season and o.player_id = sp.player_id
  where pl.pos is not null and not (v_current and coalesce(pl.injury_status, '') = 'Sus');

  insert into t_out
  select 'injury', row_number() over (order by i.lost_pts desc, i.adp_idp asc nulls last),
         i.player_id, null, null, f.abbr, round(i.lost_pts, 3),
         case when i.pre_games >= 2 then format('%s games, %s fpts (%s ppg)', i.pre_games, scdfl.sl_fmt(i.pre_fpts), scdfl.sl_fmt(i.pre_ppg))
              when i.pre_src = 'last_season' then format('No starts this season (%s: %s ppg)', p_season - 1, scdfl.sl_fmt(i.pre_ppg, 1))
              else format('No starts this season (projected %s ppg)', scdfl.sl_fmt(i.pre_ppg, 1)) end,
         array_remove(array[
           format('Injured in Week %s', i.injury_week),
           format('Missed %s game%s%s', i.missed, case when i.missed = 1 then '' else 's' end, case when i.ongoing then ' and counting' else '' end),
           format('Estimated −%s fpts', scdfl.sl_fmt(i.lost_pts)),
           i.note
         ], null),
         array_remove(array[case when i.ongoing then 'ongoing' end, case when i.overridden then 'override' end], null),
         jsonb_build_object('injury_week', i.injury_week, 'return_week', i.return_week, 'missed', i.missed, 'pre_games', i.pre_games,
                            'pre_fpts', round(i.pre_fpts, 2), 'pre_ppg', round(i.pre_ppg, 2), 'pre_src', i.pre_src,
                            'lost_pts', round(i.lost_pts, 2), 'adp_pos_rank', i.adp_pos_rank, 'adp_idp', i.adp_idp, 'pos', i.pos)
  from (
    select j.*, j.missed * j.pre_ppg as lost_pts
    from t_injury j
    left join t_repl r on r.pos = j.pos
    left join t_npos n on n.pos = j.pos
    where j.pre_ppg is not null and j.on_roster
      -- big name: drafted as a starter, or producing like one before the spell.
      -- Without an ADP table (the backtest), an established previous season stands in.
      and (j.adp_pos_rank <= n.n_pos or (j.pre_games >= 2 and j.pre_ppg >= r.repl_ppg)
           or (not v_have_adp and j.prev_ppg >= r.repl_ppg))
  ) i
  left join t_fr f on f.roster_id = i.credit_roster_id;

  -- =========================================================================
  -- 4.8 / 4.9 Busts: positional finish (total started fpts) vs ADP rank
  -- =========================================================================
  create temp table t_finish on commit drop as
  with pos_players as (
    select pl.player_id, pl.pos, pl.season_exp, coalesce(tp.fpts, 0) as fpts, coalesce(tp.games, 0) as games, tp.ppg, coalesce(tp.starts, 0) as starts
    from t_pl pl left join t_player tp on tp.player_id = pl.player_id
    where pl.pos is not null and (tp.player_id is not null or pl.player_id in (select a.player_id from t_adp a))
  ), started as (
    select pos, count(*) as n_started from pos_players where starts > 0 group by pos
  ), ranked as (
    select p.*,
           rank() over (partition by p.pos order by case when p.starts > 0 then p.fpts end desc nulls last) as rk,
           row_number() over (partition by p.pos order by case when p.starts > 0 then p.fpts end desc nulls last, p.player_id) as rn,
           rank() over (partition by p.pos order by case when p.games > 0 then p.ppg end desc nulls last) as rk_ppg
    from pos_players p
  )
  select r.player_id, r.pos, r.season_exp, r.fpts, r.games, r.ppg, r.starts,
         case when r.starts > 0 then r.rk else s.n_started + 1 end as finish_rank,
         r.rn as finish_rn,
         case when r.games > 0 then r.rk_ppg end as finish_rank_ppg
  from ranked r join started s on s.pos = r.pos;
  create index on t_finish (player_id);
  create index on t_finish (pos, finish_rn);
  analyze t_finish;

  -- NFL games played this season, one pass (a per-row subquery here cost ~15 s).
  create temp table t_nfl_games on commit drop as
  select pl.player_id, count(*) as nfl_games
  from t_ns ns
  join t_pl pl on pl.gsis_id = ns.gsis_id
  where ns.season = p_season
  group by pl.player_id;

  create temp table t_bust on commit drop as
  select f.*, a.adp_idp, a.adp_pos_rank, n.n_pos,
         ln((f.finish_rank + k_bust_k) / (a.adp_pos_rank + k_bust_k)) as score,
         (select x.fpts from t_finish x where x.pos = f.pos and x.finish_rn = a.adp_pos_rank) - f.fpts as pts_shortfall,
         exists (select 1 from t_spell sp where sp.player_id = f.player_id) as injury_driven,
         coalesce(ng.nfl_games, 0) as nfl_games,
         coalesce(tp.display_abbr,
                  (select fr.abbr from scdfl.rosters r join t_fr fr on fr.roster_id = r.sleeper_id where v_current and r.player_id = f.player_id limit 1)) as display_abbr
  from t_finish f
  join t_adp a on a.player_id = f.player_id
  join t_npos n on n.pos = f.pos
  left join t_player tp on tp.player_id = f.player_id
  left join t_nfl_games ng on ng.player_id = f.player_id
  where f.pos <> 'K';

  insert into t_out
  select 'jamielee', row_number() over (order by b.score desc, b.pts_shortfall desc nulls last),
         b.player_id, null, null, b.display_abbr, round(b.score, 4),
         format('%s%s preseason', b.pos, b.adp_pos_rank),
         array_remove(array[
           format('%s fpts, %s%s finish', scdfl.sl_fmt(b.fpts), b.pos, b.finish_rank),
           format('%s NFL games, %s SCDFL starts', b.nfl_games, b.starts),
           case when b.pts_shortfall is not null then format('%s fpts short of his ADP slot', scdfl.sl_fmt(b.pts_shortfall)) end
         ], null),
         array_remove(array[case when b.injury_driven then 'injury_driven' end], null),
         jsonb_build_object('adp_idp', b.adp_idp, 'adp_pos_rank', b.adp_pos_rank, 'finish_rank', b.finish_rank, 'finish_rank_ppg', b.finish_rank_ppg,
                            'fpts', round(b.fpts, 2), 'games', b.games, 'starts', b.starts, 'nfl_games', b.nfl_games,
                            'pts_shortfall', round(b.pts_shortfall, 2), 'pos', b.pos)
  from t_bust b
  where b.season_exp >= 1 and b.adp_pos_rank <= b.n_pos;

  -- Rookie bust: round 1–2 of the SCDFL draft, ADP as a starter (relaxed to the
  -- top 20 rookies by overall ADP when fewer than 8 qualify).
  select count(*) into v_rookie_bust_pool
  from t_bust b join t_rookie_draft d on d.player_id = b.player_id
  where b.season_exp = 0 and b.adp_pos_rank <= b.n_pos and d.round <= k_rookie_bust_max_round;

  insert into t_out
  select 'sweeney', row_number() over (order by b.score desc, b.pts_shortfall desc nulls last),
         b.player_id, null, null, b.display_abbr, round(b.score, 4),
         case when b.starts = 0 then 'No SCDFL starts yet'
              else format('%s games, %s fpts (%s ppg)', b.games, scdfl.sl_fmt(b.fpts), scdfl.sl_fmt(b.ppg)) end,
         array_remove(array[
           format('%s%s preseason, %s%s finish', b.pos, b.adp_pos_rank, b.pos, b.finish_rank),
           format('Drafted %s.%s (%s ovr)', d.round, lpad(d.slot::text, 2, '0'), scdfl.sl_ordinal(d.pick_no))
         ], null),
         array_remove(array[case when b.injury_driven then 'injury_driven' end, case when b.starts = 0 then 'no_starts' end], null),
         jsonb_build_object('adp_idp', b.adp_idp, 'adp_pos_rank', b.adp_pos_rank, 'finish_rank', b.finish_rank, 'finish_rank_ppg', b.finish_rank_ppg,
                            'fpts', round(b.fpts, 2), 'games', b.games, 'starts', b.starts, 'overall_pick', d.pick_no, 'round', d.round, 'pos', b.pos)
  from t_bust b
  join t_rookie_draft d on d.player_id = b.player_id
  where b.season_exp = 0 and d.round <= k_rookie_bust_max_round
    and (v_rookie_bust_pool >= k_rookie_bust_min_pool and b.adp_pos_rank <= b.n_pos
         or v_rookie_bust_pool < k_rookie_bust_min_pool
            and b.player_id in (select x.player_id from t_bust x where x.season_exp = 0 order by x.adp_idp limit k_rookie_bust_fallback));

  -- =========================================================================
  -- 4.11 Manager of the Year / 4.12 Most Improved Franchise
  -- =========================================================================
  create temp table t_fz on commit drop as
  select fs.roster_id, f.abbr, f.active_abbr, f.name, f.conf, fs.games, fs.wins, fs.losses, fs.ties, fs.win_pct, fs.pf, fs.pa, fs.pf_pg, fs.pf_rank, fs.pa_rank, fs.standing,
         (fs.standing <= v_playoff_teams) as playoff_spot,
         pj.win_ou::numeric * fs.games / 14.0 as exp_wins_line,
         fs.wins + 0.5 * fs.ties - pj.win_ou::numeric * fs.games / 14.0 as wins_over_line,
         (select count(distinct t.transaction_id) from scdfl.transactions t
           where t.year = p_season and t.status = 'complete' and t.roster_id = fs.roster_id and t.type in ('waiver', 'free_agent', 'trade')) as transactions,
         ps.wins as prev_wins, ps.losses as prev_losses, ps.ties as prev_ties, ps.win_pct as prev_win_pct, ps.pf_pg as prev_pf_pg,
         pr.playoff as prev_playoff, pr.finish as prev_finish, pr.seed as prev_seed,
         (select count(*) from scdfl.results r where r.sleeper_id = fs.roster_id::text and r.year < p_season and r.playoff) as prior_playoffs
  from t_fs fs
  join t_fr f on f.roster_id = fs.roster_id
  left join scdfl.projections pj on pj.year = p_season and pj.sleeper_id = fs.roster_id
  left join t_fs ps on ps.year = p_season - 1 and ps.roster_id = fs.roster_id
  left join scdfl.results pr on pr.year = p_season - 1 and pr.sleeper_id = fs.roster_id::text
  where fs.year = p_season;

  alter table t_fz add column moty numeric, add column mif numeric, add column d_win numeric, add column d_ppg numeric;
  with z as (
    select roster_id,
           (win_pct - avg(win_pct) over ()) / nullif(stddev_samp(win_pct) over (), 0) as z_win,
           (wins_over_line - avg(wins_over_line) over ()) / nullif(stddev_samp(wins_over_line) over (), 0) as z_line,
           (pf_pg - avg(pf_pg) over ()) / nullif(stddev_samp(pf_pg) over (), 0) as z_pf,
           win_pct - prev_win_pct as d_win, pf_pg - prev_pf_pg as d_ppg,
           (win_pct - prev_win_pct - avg(win_pct - prev_win_pct) over ()) / nullif(stddev_samp(win_pct - prev_win_pct) over (), 0) as z_dwin,
           (pf_pg - prev_pf_pg - avg(pf_pg - prev_pf_pg) over ()) / nullif(stddev_samp(pf_pg - prev_pf_pg) over (), 0) as z_dppg
    from t_fz
  )
  update t_fz f set
    moty = k_moty_w_win * z.z_win + case when v_have_lines then k_moty_w_line * coalesce(z.z_line, 0) else 0 end + k_moty_w_pf * z.z_pf,
    mif = k_mif_w_dwin * z.z_dwin + k_mif_w_dppg * z.z_dppg + k_mif_w_win * z.z_win,
    d_win = z.d_win, d_ppg = z.d_ppg
  from z where z.roster_id = f.roster_id;

  insert into t_out
  select 'moty', row_number() over (order by f.moty desc, f.win_pct desc, f.pf desc),
         null, f.roster_id::text, null, f.abbr, round(f.moty, 3),
         format('%s-%s%s, %s', f.wins, f.losses, case when f.ties > 0 then '-' || f.ties else '' end,
                case when f.playoff_spot then scdfl.sl_ordinal(f.standing) || ' seed' else 'outside the field' end),
         array_remove(array[
           format('%s in Points For, %s in Points Against', scdfl.sl_ordinal(f.pf_rank::int), scdfl.sl_ordinal(f.pa_rank::int)),
           case when f.wins_over_line is not null then format('%s%s wins vs. preseason line', case when f.wins_over_line >= 0 then '+' else '−' end, scdfl.sl_fmt(abs(f.wins_over_line), 1)) end,
           format('%s transactions', f.transactions)
         ], null),
         array_remove(array[case when not f.playoff_spot then 'outside_field' end], null),
         jsonb_build_object('wins', f.wins, 'losses', f.losses, 'ties', f.ties, 'win_pct', round(f.win_pct, 3), 'pf', round(f.pf, 2), 'pa', round(f.pa, 2),
                            'pf_pg', round(f.pf_pg, 2), 'pf_rank', f.pf_rank, 'pa_rank', f.pa_rank, 'standing', f.standing,
                            'exp_wins_line', round(f.exp_wins_line, 2), 'wins_over_line', round(f.wins_over_line, 2), 'transactions', f.transactions)
  from t_fz f
  where f.moty is not null and (f.win_pct >= 0.5 or f.playoff_spot);

  insert into t_out
  select 'mif', row_number() over (order by f.mif desc, f.d_win desc, f.d_ppg desc),
         null, f.roster_id::text, null, f.abbr, round(f.mif, 3),
         format('%s-%s%s, %s', f.wins, f.losses, case when f.ties > 0 then '-' || f.ties else '' end,
                case when f.playoff_spot then format('%s playoff appearance, %s seed', scdfl.sl_ordinal(f.prior_playoffs::int + 1), scdfl.sl_ordinal(f.standing))
                     else format('%s in the standings', scdfl.sl_ordinal(f.standing)) end),
         array_remove(array[
           format('%s: %s-%s%s, %s', p_season - 1, f.prev_wins, f.prev_losses, case when f.prev_ties > 0 then '-' || f.prev_ties else '' end,
                  case when f.prev_playoff then coalesce(f.prev_finish, 'playoffs') else 'no playoffs' end),
           format('%s%s point differential vs LY', case when f.d_ppg >= 0 then '+' else '−' end, scdfl.sl_fmt(abs(f.d_ppg * f.games))),
           format('%s%s win%% vs LY', case when f.d_win >= 0 then '+' else '−' end, scdfl.sl_fmt(abs(f.d_win * 100), 1))
         ], null),
         '{}'::text[],
         jsonb_build_object('wins', f.wins, 'losses', f.losses, 'win_pct', round(f.win_pct, 3), 'pf_pg', round(f.pf_pg, 2),
                            'prev_wins', f.prev_wins, 'prev_losses', f.prev_losses, 'prev_win_pct', round(f.prev_win_pct, 3), 'prev_pf_pg', round(f.prev_pf_pg, 2),
                            'd_win', round(f.d_win, 3), 'd_ppg', round(f.d_ppg, 2), 'standing', f.standing, 'prev_finish', f.prev_finish)
  from t_fz f
  where f.mif is not null and (coalesce(f.prev_playoff, false) = false or f.prev_finish = 'First Round');

  -- =========================================================================
  -- 4.13 / 4.14 Trades: tenure crediting + rest-of-season + draft capital
  -- =========================================================================
  create temp table t_trade on commit drop as
  select t.transaction_id, min(t.week) as week, min(t.created) as created, count(distinct t.roster_id) as n_sides
  from scdfl.transactions t
  where t.year = p_season and t.type = 'trade' and t.status = 'complete'
  group by t.transaction_id;

  create temp table t_leg on commit drop as
  select t.transaction_id, t.roster_id, t.action, t.asset, t.player_id, t.pick_season, t.pick_round, t.pick_original_roster_id,
         coalesce(t.player_id, format('%s-%s-%s', t.pick_season, t.pick_round, t.pick_original_roster_id)) as asset_key
  from scdfl.transactions t
  where t.year = p_season and t.type = 'trade' and t.status = 'complete';

  create temp table t_trade_excl (transaction_id text primary key, reason text) on commit drop;

  insert into t_trade_excl
  select x.transaction_id, 'listed' from scdfl.trade_exclusions x where x.transaction_id in (select transaction_id from t_trade)
  on conflict do nothing;

  -- Commissioner undo: a received player moved straight back within a day.
  insert into t_trade_excl
  select distinct l.transaction_id, 'commissioner undo'
  from t_leg l
  join t_trade t on t.transaction_id = l.transaction_id
  join scdfl.transactions c on c.type = 'commissioner' and c.status = 'complete' and c.action = 'drop'
    and c.roster_id = l.roster_id and c.player_id = l.player_id
    and c.created between t.created and t.created + 86400000
  where l.action = 'add' and l.asset = 'player'
  on conflict do nothing;

  -- Reversal: the mirror-image trade between the same rosters inside the window.
  with sig as (
    select transaction_id,
           array_agg(format('%s:%s:%s', roster_id, action, asset_key) order by format('%s:%s:%s', roster_id, action, asset_key)) as s,
           array_agg(format('%s:%s:%s', roster_id, case action when 'add' then 'drop' else 'add' end, asset_key)
                     order by format('%s:%s:%s', roster_id, case action when 'add' then 'drop' else 'add' end, asset_key)) as s_rev
    from t_leg group by transaction_id
  )
  insert into t_trade_excl
  select x.transaction_id, 'reversal'
  from sig a join t_trade ta on ta.transaction_id = a.transaction_id
  join sig b on b.s = a.s_rev
  join t_trade tb on tb.transaction_id = b.transaction_id
    and tb.created > ta.created and tb.created <= ta.created + k_reversal_days::bigint * 86400000
  cross join lateral (values (a.transaction_id), (b.transaction_id)) x(transaction_id)
  on conflict do nothing;

  create temp table t_asset on commit drop as
  select l.transaction_id, l.roster_id, l.asset_key, t.week as trade_week, t.created,
         l.asset, l.pick_season, l.pick_round, l.pick_original_roster_id,
         case when l.asset = 'player' then l.player_id
              when l.pick_season = p_season and dr.roster_id = l.roster_id then dr.player_id end as eff_player_id,
         case when l.asset = 'player' then 'player'
              when l.pick_season = p_season and dr.roster_id = l.roster_id then 'drafted'
              when l.pick_season = p_season and dr.player_id is not null then 'flipped'
              else 'capital' end as kind,
         dr.pick_no
  from t_leg l
  join t_trade t on t.transaction_id = l.transaction_id
  left join t_rookie_draft dr on l.asset = 'pick' and l.pick_season = p_season
    and dr.round = l.pick_round and dr.original_roster_id = l.pick_original_roster_id
  where l.action = 'add' and l.transaction_id not in (select transaction_id from t_trade_excl);

  create temp table t_asset_val on commit drop as
  select a.*,
         coalesce(r.realized, 0) as realized,
         coalesce(r.starts_since, 0) as starts_since,
         case when k_include_ros and a.kind in ('player', 'drafted') and tp.ppg is not null
                   and not (v_current and not exists (select 1 from scdfl.rosters ro where ro.sleeper_id = a.roster_id and ro.player_id = a.eff_player_id))
                   and not (v_current and coalesce(pl.injury_status, '') in ('IR', 'PUP', 'Sus'))
              then tp.ppg * least(1, case when v_as_of - a.trade_week + 1 <= 0 then 1
                                          else coalesce(r.starts_since, 0)::numeric / (v_as_of - a.trade_week + 1) end) * (14 - v_as_of)
              else 0 end as ros,
         case when a.kind in ('capital', 'flipped') then coalesce(pv.pick_value, 0) else 0 end as capital,
         case when a.kind in ('player', 'drafted') then coalesce(pl.full_name, a.eff_player_id) ||
                   case when a.kind = 'drafted' then format(' (%s %s.%s)', p_season, a.pick_round, lpad((((a.pick_no - 1) % 14) + 1)::text, 2, '0')) else '' end
              when a.kind = 'flipped' then format('%s %s (%s), flipped before the draft', a.pick_season, scdfl.sl_ordinal(a.pick_round), scdfl.sl_abbr(a.pick_original_roster_id, a.pick_season))
              else format('%s %s (%s)', a.pick_season, scdfl.sl_ordinal(a.pick_round), scdfl.sl_abbr(a.pick_original_roster_id, a.pick_season)) end as label,
         exists (select 1 from scdfl.transactions d where d.year = p_season and d.status = 'complete' and d.action = 'drop'
                   and d.type in ('waiver', 'free_agent') and d.roster_id = a.roster_id and d.player_id = a.eff_player_id
                   and d.created between a.created and a.created + 86400000) as quick_drop
  from t_asset a
  left join lateral (
    select sum(points) as realized, count(*) as starts_since
    from t_starts s where s.roster_id = a.roster_id and s.player_id = a.eff_player_id and s.week >= a.trade_week
  ) r on true
  left join t_player tp on tp.player_id = a.eff_player_id
  left join t_pl pl on pl.player_id = a.eff_player_id
  left join t_pickval pv on pv.round = a.pick_round;

  -- What a side gave = the same assets, valued where they landed. For a
  -- two-team trade that is exactly the other side's value; for three teams
  -- it is the only way to see who paid for what.
  create temp table t_given on commit drop as
  select l.transaction_id, l.roster_id,
         sum(v.realized + v.ros + k_capital_weight * v.capital) as given
  from t_leg l
  join t_asset_val v on v.transaction_id = l.transaction_id and v.asset_key = l.asset_key
  where l.action = 'drop'
  group by l.transaction_id, l.roster_id;

  create temp table t_side on commit drop as
  select p.transaction_id, p.roster_id,
         coalesce(sum(v.realized), 0) as realized, coalesce(sum(v.ros), 0) as ros, coalesce(sum(v.capital), 0) as capital,
         coalesce(sum(v.realized), 0) + coalesce(sum(v.ros), 0) + k_capital_weight * coalesce(sum(v.capital), 0) as value,
         coalesce(max(g.given), 0) as given,
         coalesce(jsonb_agg(jsonb_build_object('label', v.label, 'kind', v.kind, 'player_id', v.eff_player_id,
                                               'realized', round(v.realized, 2), 'ros', round(v.ros, 2), 'capital', round(v.capital, 2))
                            order by v.realized + v.ros + v.capital desc) filter (where v.label is not null), '[]'::jsonb) as received,
         bool_or(v.quick_drop) as quick_drop
  from (select distinct transaction_id, roster_id from t_leg where transaction_id not in (select transaction_id from t_trade_excl)) p
  left join t_asset_val v on v.transaction_id = p.transaction_id and v.roster_id = p.roster_id
  left join t_given g on g.transaction_id = p.transaction_id and g.roster_id = p.roster_id
  group by p.transaction_id, p.roster_id;

  -- balance: the most lopsided side's received/given ratio (= vmin/vmax for
  -- two teams); net: received − given, so the winner is the biggest net gain.
  create temp table t_trade_score on commit drop as
  select t.transaction_id, t.week, t.created, t.n_sides,
         min(s.value) as vmin, max(s.value) as vmax, sum(s.value) as vsum,
         min(least(s.value, s.given) / nullif(greatest(s.value, s.given), 0)) as balance,
         max(s.value - s.given) as net_max,
         jsonb_agg(jsonb_build_object('roster_id', s.roster_id, 'abbr', f.abbr, 'active_abbr', f.active_abbr, 'name', f.name,
                                      'realized', round(s.realized, 2), 'ros', round(s.ros, 2), 'capital', round(s.capital, 2),
                                      'value', round(s.value, 2), 'given', round(s.given, 2), 'net', round(s.value - s.given, 2),
                                      'received', s.received) order by s.value - s.given desc) as sides,
         string_agg(f.abbr, ' / ' order by s.value - s.given desc) as abbrs,
         (array_agg(f.abbr order by s.value - s.given desc))[1] as top_abbr,
         (array_agg(s.value order by s.value - s.given desc))[1] as top_value,
         (array_agg(s.given order by s.value - s.given desc))[1] as top_given,
         (array_agg(f.abbr order by s.value - s.given asc))[1] as bottom_abbr,
         bool_or(coalesce(s.quick_drop, false)) as quick_drop
  from t_trade t
  join t_side s on s.transaction_id = t.transaction_id
  join t_fr f on f.roster_id = s.roster_id
  group by t.transaction_id, t.week, t.created, t.n_sides;

  insert into t_out
  select 'goodtrade', row_number() over (order by s.vmin desc, s.vsum desc),
         null, null, s.transaction_id, s.abbrs, round(s.vmin, 3),
         format('Week %s · %s · %s-team trade', s.week, to_char(to_timestamp(s.created / 1000.0) at time zone 'America/New_York', 'Mon DD, YYYY'), s.n_sides),
         array[format('Every side cleared %s points; %s in all', scdfl.sl_fmt(s.vmin, 0), scdfl.sl_fmt(s.vsum, 0))],
         array_remove(array[case when s.quick_drop then 'quick_drop' end], null),
         jsonb_build_object('vmin', round(s.vmin, 2), 'vmax', round(s.vmax, 2), 'vsum', round(s.vsum, 2),
                            'balance', round(s.balance, 3), 'week', s.week,
                            'date', to_char(to_timestamp(s.created / 1000.0) at time zone 'America/New_York', 'YYYY-MM-DD'), 'sides', s.sides)
  from t_trade_score s
  where s.vmax > 0 and coalesce(s.balance, 1) >= k_trade_balance_gate;

  insert into t_out
  select 'badtrade', row_number() over (order by s.net_max desc, s.balance asc nulls last),
         null, null, s.transaction_id, s.abbrs, round(s.net_max, 3),
         format('Week %s · %s · %s-team trade', s.week, to_char(to_timestamp(s.created / 1000.0) at time zone 'America/New_York', 'Mon DD, YYYY'), s.n_sides),
         array[format('%s won it, %s received to %s given', s.top_abbr, scdfl.sl_fmt(s.top_value, 0), scdfl.sl_fmt(s.top_given, 0))],
         array_remove(array[case when s.quick_drop then 'quick_drop' end], null),
         jsonb_build_object('vmin', round(s.vmin, 2), 'vmax', round(s.vmax, 2), 'vsum', round(s.vsum, 2), 'net_max', round(s.net_max, 2),
                            'balance', round(s.balance, 3), 'winner', s.top_abbr, 'loser', s.bottom_abbr, 'week', s.week,
                            'date', to_char(to_timestamp(s.created / 1000.0) at time zone 'America/New_York', 'YYYY-MM-DD'), 'sides', s.sides)
  from t_trade_score s
  where s.vmax >= k_lopsided_min_value and coalesce(s.balance, 1) < k_trade_balance_gate;

  -- =========================================================================
  -- Top five per award, with the knobs that produced them
  -- =========================================================================
  return query
  select o.award_code, o.rank, o.player_id, o.sleeper_id, o.transaction_id, o.franchise_abbr, o.score, o.headline,
         coalesce(o.detail_lines, '{}'), coalesce(o.flags, '{}'),
         o.payload || jsonb_build_object('params', jsonb_build_object(
           'pick_horizon_seasons', k_pick_horizon, 'capital_weight', k_capital_weight, 'trade_balance_gate', k_trade_balance_gate,
           'bust_rank_smoothing', k_bust_k, 'waiver_window_start', to_char(to_timestamp(v_waiver_start / 1000.0) at time zone 'America/New_York', 'YYYY-MM-DD'),
           'have_adp', v_have_adp, 'have_lines', v_have_lines))
  from t_out o
  where o.rank <= coalesce(p_top, 5)
  order by o.award_code, o.rank;
end
$fn$;
