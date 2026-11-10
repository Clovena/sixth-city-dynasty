-- Scheduled data jobs (functions/sync). The `ops` schema holds the run log
-- for any job the `sync` Edge Function executes — not just the nightly
-- sync:recent — so future jobs reuse these tables rather than adding their own.
--
-- Not exposed through the Data API: only the function (postgres.js via
-- SUPABASE_DB_URL) and the SQL editor touch it. RLS is on with no policies,
-- matching the pickems schema, so a later exposure can't leak it by accident.

create schema if not exists ops;

create table ops.runs (
  id          bigint generated always as identity primary key,
  job         text        not null,                 -- key in functions/sync/jobs.ts
  trigger     text        not null check (trigger in ('cron', 'manual')),
  scope       text        not null,                 -- the job's scope token, e.g. 'latest'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text        not null default 'running'
              check (status in ('running', 'ok', 'warning', 'error'))
);

-- One row per step. A step that never finishes (the function was killed for
-- exceeding its CPU / wall-clock cap) stays 'running' with no finished_at,
-- and its run stays 'running' too: the chain stops there.
create table ops.run_steps (
  run_id      bigint      not null references ops.runs (id) on delete cascade,
  step_no     int         not null,
  step        text        not null,                 -- 'results', 'matchups', …, 'deploy'
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text        not null default 'running'
              check (status in ('running', 'ok', 'warning', 'error')),
  rows        int,
  detail      jsonb,                                -- {errors: [...], warnings: [...]}
  primary key (run_id, step_no)
);

create index runs_job_started_idx on ops.runs (job, started_at desc);

alter table ops.runs      enable row level security;
alter table ops.run_steps enable row level security;

-- Debugging view: the latest run of each job, its steps flattened.
create view ops.latest_runs with (security_invoker = true) as
select r.id as run_id, r.job, r.trigger, r.status as run_status,
       r.started_at, r.finished_at,
       s.step_no, s.step, s.status as step_status, s.rows,
       s.finished_at - s.started_at as duration, s.detail
  from ops.runs r
  left join ops.run_steps s on s.run_id = r.id
 where r.id in (select max(id) from ops.runs group by job)
 order by r.job, s.step_no;
