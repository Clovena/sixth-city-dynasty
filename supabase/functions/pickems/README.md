# Sixth City Pick'ems Bot

Weekly pick'ems for the DFL as one Supabase Edge Function, called every
5 minutes by `pg_cron`. Full spec: [docs/pickems-bot-spec.md](../../../docs/pickems-bot-spec.md).

Weekly rhythm (all times ET, driven by `pickems.calendar`):

| When | Step | What happens |
|---|---|---|
| Tue 8:30 AM | SCORE | Grade last week from Sleeper, post recap + standings |
| Tue 9:00 AM | POST | Post header + one poll per matchup |
| Thu 8:00 PM | REMIND | @mention only players missing picks |
| Sun 1:00 PM | LOCK | Expire every poll |
| Sun 1:10 PM | COLLECT | Read finalized votes into `pickems.picks` |

## Operations

Everything below needs `CRON_SECRET` (set once via
`npx supabase secrets set CRON_SECRET=...`; also stored in Vault as
`pickems_cron_secret` and in the git-ignored `.env`). The bot token is a
password: it lives only in Supabase secrets, never in git or chat.

### Call an admin action

From a shell (reads the secret from `.env` without echoing it):

```bash
curl -s -X POST "https://biukjccnbuhoxrhmwyhu.supabase.co/functions/v1/pickems" \
  -H "x-cron-secret: $(sed -n 's/^CRON_SECRET=//p' .env)" \
  -H "Content-Type: application/json" \
  -d '{"action":"preview","league":"dfl","week":15}'
```

Or from the SQL editor:

```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
         || '/functions/v1/pickems',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pickems_cron_secret')
  ),
  body := '{"action":"preview","league":"dfl","week":15}'::jsonb
);
-- response arrives async; read it with:
select status_code, content from net._http_response order by created desc limit 1;
```

Actions (spec §8.3):

| Body | Effect |
|---|---|
| `{"action":"tick"}` | Normal run (what cron sends) |
| `{"action":"preview","league":"dfl","week":15}` | Build every message, return JSON, post nothing. Run before each first-of-its-kind week |
| `{"action":"rescore","league":"dfl","week":11}` | Re-fetch results, re-grade, repost standings |
| `{"action":"post-standings","league":"dfl"}` | Repost current standings |
| `{"action":"skip","league":"dfl","week":12}` | Mark a week skipped (never posts) |

### Routine knobs

- **Pause the bot:** `select cron.unschedule('pickems-tick');` — resume by
  re-running the `cron.schedule` block from the spec §9.
- **Dry run:** `update pickems.config set value = 'true' where key = 'dry_run';`
  routes every Discord write to #bot-admin. **Don't flip it mid-week**: polls
  already posted would be looked up in the wrong channel by later steps.
- **Go-live:** `update pickems.leagues set channel_id = '<real channel id>'
  where key = 'dfl';` — same mid-week caveat.
- **Fix a player's name:** `update pickems.players set display_name = 'Ryan'
  where discord_user_id = '...';` (names Zac sets are never overwritten).
- **Playoff fallback:** if Sleeper's bracket misbehaves, insert rows into
  `pickems.manual_matchups` (league `dfl`, season, week, slot, the two
  roster ids as text, label) — they take precedence over the bracket.

### Debugging

- `select * from pickems.runs order by id desc limit 20;` — one row per invocation.
- `select * from pickems.weeks;` — per-week step progress, `last_error`, alerts.
- `select status_code, content, created from net._http_response order by created desc limit 20;`
  — cron's view of the HTTP calls (kept ~6 hours).
- Edge Function logs: Dashboard → Edge Functions → pickems → Logs.

### Deploy & test

```bash
npx supabase functions deploy pickems --yes   # from the repo root
cd supabase/functions/pickems && deno test --allow-read   # 32 unit tests, no network
```

Schema/seed SQL lives in `supabase/migrations/2026110*_pickems_*.sql`.
Note the repo-wide migration-ledger divergence (spec §19.1): `db push`
fails for pre-existing reasons; apply new migrations via MCP/dashboard.
