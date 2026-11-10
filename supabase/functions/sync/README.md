# Scheduled data jobs (`sync`)

Keeps `scdfl.*` fresh without anyone running `npm run sync:recent` by hand.
One Supabase Edge Function, called by `pg_cron`, running jobs defined in
[`jobs.ts`](jobs.ts). Today there is one job:

| Job | Steps | When |
|---|---|---|
| `recent` | `results → matchups → rosters → transactions → drafts → exhibitions → stats → deploy` | Daily, midnight ET |

`recent` is `npm run sync:recent` followed by a Netlify rebuild (`deploy`),
since almost every page is pre-rendered and only shows new data after a build.

## How it works

```
pg_cron 'ops-sync-recent' (04:00 + 05:00 UTC)
   │ net.http_post {"job":"recent","trigger":"cron"}     ← URL + secret from Vault
   ▼
sync (step 0: results) ── logs ops.run_steps ── net.http_post {"run_id":N,"step":1}
   ▼
sync (step 1: matchups) ── … ── sync (step 7: deploy) ── closes ops.runs
```

- **One step per invocation.** The Free plan caps each request at 2 s CPU and
  150 s wall clock. Chaining through `pg_net` (which only *queues* the
  request) gives every step its own budget.
- **Failures don't stop the chain.** The steps write independent tables; a
  failed step is recorded and the next one still runs. The run's status is
  the worst status of its steps.
- **Midnight ET across DST.** pg_cron runs in UTC, so the job fires at both
  04:00 and 05:00 UTC and the function skips whichever isn't midnight in New
  York.
- **The sync code is shared with the npm scripts.** It lives in
  [`../_shared/sync/`](../_shared/sync/) and is runtime-agnostic;
  `scripts/lib/sync-*.ts` are thin Node wrappers around the same modules.

## One-time setup

1. **Migrations** (apply via MCP / SQL editor — `db push` is broken for
   pre-existing reasons, see `docs/pickems-bot-spec.md` §19.1):
   `supabase/migrations/20261110180000_ops_schema.sql`,
   `supabase/migrations/20261110180100_replace_rosters.sql`.
2. **New-style API keys.** Settings → API Keys → *Publishable and secret API
   keys*. If there's a "Create new API keys" button, press it. The function
   reads the `default` secret key from the built-in `SUPABASE_SECRET_KEYS`.
3. **Netlify build hook.** Netlify → Site configuration → Build & deploy →
   Build hooks → Add (name "Supabase nightly sync", branch `main`).
4. **Secrets** (the hook URL is itself a credential — anyone holding it can
   trigger builds):
   ```bash
   npx supabase secrets set OPS_CRON_SECRET="$(openssl rand -hex 32)"   # note the value for step 5
   npx supabase secrets set NETLIFY_BUILD_HOOK="https://api.netlify.com/build_hooks/…"
   ```
5. **Vault + deploy + schedule** (SQL editor; `project_url` already exists
   from pickems):
   ```sql
   select vault.create_secret('<same OPS_CRON_SECRET value>', 'ops_cron_secret');
   ```
   ```bash
   npx supabase functions deploy sync --yes
   ```
   Trigger one run by hand (below) and check it, then:
   ```sql
   select cron.schedule('ops-sync-recent', '0 4,5 * * *', $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
              || '/functions/v1/sync',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ops_cron_secret')
       ),
       body := '{"job":"recent","trigger":"cron"}'::jsonb,
       timeout_milliseconds := 150000
     );
   $$);
   ```

## Operations

**Run a job now** (a manual run skips the midnight check):

```bash
curl -s -X POST "https://biukjccnbuhoxrhmwyhu.supabase.co/functions/v1/sync" \
  -H "x-cron-secret: $(sed -n 's/^OPS_CRON_SECRET=//p' .env)" \
  -H "Content-Type: application/json" \
  -d '{"job":"recent"}'
```

The response covers step 0 only; the rest of the chain runs in the
background. Follow it in `ops.latest_runs`.

**Re-run one step of an existing run:** `-d '{"job":"recent","run_id":12,"step":6}'`.
That step's row is overwritten, then the chain continues from there.

**Pause / resume:** `select cron.unschedule('ops-sync-recent');` — resume by
re-running the `cron.schedule` block above.

**Add a job:** add an entry to `JOBS` in `jobs.ts`, deploy, and schedule it
with the block above (new job name, new body). Steps are the keys of `SYNCS`
in `_shared/sync/mod.ts`, plus `deploy`.

## Debugging

```sql
select * from ops.latest_runs;                                  -- last run of each job, per step
select * from ops.runs order by id desc limit 20;
select * from ops.run_steps where run_id = 12 order by step_no;
select status_code, content, created from net._http_response order by created desc limit 20;  -- ~6 h
```

- **A step stuck at `running`** with no `finished_at` means the invocation was
  killed, usually for exceeding the CPU or wall-clock cap. The chain stops
  there and the run stays `running`. Check Dashboard → Edge Functions → sync →
  Logs. If `stats` is the culprit as nflverse's CSV grows, split it by week
  batch into several steps.
- **`rosters` warning listing player ids**: Sleeper has players that
  `scdfl.players` doesn't yet. They're left off `rosters` until
  `npm run sync:player-meta` runs, which isn't scheduled yet.
- **`deploy` warning "NETLIFY_BUILD_HOOK is not set"**: the data refreshed
  but the site didn't rebuild.
