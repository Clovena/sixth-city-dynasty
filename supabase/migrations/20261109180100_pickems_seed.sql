-- Pick'ems seed data (spec §4.1, §6 "Seeds", §18 amendments: DFL only,
-- sandbox channels, Unicode emoji, no carryover import).

-- DFL only for v1 (§18.1). channel_id is the private #bot-lab channel until
-- go-live, when Zac updates this row to the real channel.
insert into pickems.leagues
  (key, display_name, short_name, season, channel_id,
   matchup_source, results_source, regular_season_weeks, include_consolation, active)
values
  ('dfl', 'Sixth City Dynasty', 'DFL', 2026, '1569485776968745070',
   'scdfl', 'sleeper', 14, true, true);

-- dry_run 'true': every Discord write is diverted to the admin channel until
-- Zac flips this to 'false' (§8.3).
insert into pickems.config (key, value) values
  ('admin_channel_id', '1569486062512775189'),     -- #bot-admin
  ('dry_run', 'true');

-- Calendar, weeks 10–17 of 2026 (§4.1, seeded as written per §18.11 — the
-- lock is always Sunday 1:00 PM ET). "at time zone 'America/New_York'"
-- converts each ET wall-clock time to UTC once, here at seed time, so DST is
-- the database's problem exactly once and never the bot's.
insert into pickems.calendar (season, week, post_at, remind_at, lock_at, score_at)
select 2026, w,
  ((date '2026-09-13' + 7*(w-1) - 5) + time '09:00') at time zone 'America/New_York', -- Tue 9:00 AM
  ((date '2026-09-13' + 7*(w-1) - 3) + time '20:00') at time zone 'America/New_York', -- Thu 8:00 PM
  ((date '2026-09-13' + 7*(w-1))     + time '13:00') at time zone 'America/New_York', -- Sun 1:00 PM
  ((date '2026-09-13' + 7*(w-1) + 2) + time '08:30') at time zone 'America/New_York'  -- next Tue 8:30 AM
from generate_series(10, 17) w;

-- Teams from the live active franchises (one row per club where "to" is
-- null). short_name is the nickname = last word of the full name — verified
-- against all 14 current names on Nov 9, 2026 (e.g. 'Bikini Bottom Stars' →
-- 'Stars', 'Sarnia SeaSnakes' → 'SeaSnakes'). Emoji per §18.13, keyed by abbr.
insert into pickems.teams (league_key, team_key, display_name, short_name, emoji)
select 'dfl', f.sleeper_id, f.name,
       (regexp_match(f.name, '(\S+)$'))[1],
       e.emoji
from scdfl.franchises f
join (values
  ('BKB', '🍍'), ('CHC', '🚂'), ('GLD', '🦈'), ('IQT', '🐟'),
  ('LOW', '🐱'), ('MIS', '🦣'), ('NFD', '🫎'), ('NNY', '🤖'),
  ('PEI', '🛥️'), ('SAR', '🐍'), ('TBY', '🐴'), ('TOR', '🐗'),
  ('VAN', '🚓'), ('WPG', '🏇')
) e(abbr, emoji) on e.abbr = f.abbr
where f."to" is null;

-- Two sandbox participants, pre-seeded so Thursday reminders can mention
-- them even before their first vote (everyone else is auto-inserted on their
-- first collected pick, §18.2). Display names are placeholders; they're
-- refreshed from Discord's user data once the bot is live, or set by Zac.
insert into pickems.players (discord_user_id, display_name) values
  ('865238388012875797', 'player-5797'),
  ('692091794237947905', 'player-7905');

insert into pickems.player_leagues (discord_user_id, league_key, remind) values
  ('865238388012875797', 'dfl', true),
  ('692091794237947905', 'dfl', true);

-- The single lease row the tick mutex updates (see schema migration).
insert into pickems.lease (id) values (1);
