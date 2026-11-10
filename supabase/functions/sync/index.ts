// HTTP entry point for scheduled data jobs (see README.md).
//
// One invocation runs ONE step of a job, logs it to ops.run_steps, then
// hands the next step to pg_net (db.ts → handOff) and returns. A job run is
// therefore a chain of short invocations, each inside the Free-plan caps.
//
//   cron       {"job":"recent","trigger":"cron"}       → new run, step 0
//   by hand    {"job":"recent"}                         → new run, step 0
//   hand-off   {"job":"recent","run_id":12,"step":3}   → continue run 12
//
// Auth mirrors pickems: verify_jwt is off (config.toml) and every request
// must carry x-cron-secret matching OPS_CRON_SECRET.

import { createClient } from '@supabase/supabase-js';
import { resolveSeasonScope, SYNCS, type SyncResult } from '../_shared/sync/mod.ts';
import { finishRun, finishStep, handOff, startRun, startStep, type StepOutcome } from './db.ts';
import { type Job, JOBS, type StepName } from './jobs.ts';

type Body = {
  job?: string;
  trigger?: 'cron' | 'manual';
  run_id?: number;
  step?: number;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const secret = Deno.env.get('OPS_CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* empty body → rejected below */ }

  const jobName = body.job ?? '';
  const job = JOBS[jobName];
  if (!job) {
    return Response.json({ ok: false, error: `unknown job "${jobName}"` }, { status: 400 });
  }

  let runId: number;
  let stepNo: number;

  if (body.run_id === undefined) {
    const trigger = body.trigger ?? 'manual';
    // Cron fires at both 04:00 and 05:00 UTC; only the one that lands on
    // midnight in New York runs, which keeps the job at local midnight
    // through DST changes without editing the schedule twice a year.
    if (trigger === 'cron' && !isMidnightET(new Date())) {
      return Response.json({ ok: true, skipped: 'not midnight ET' });
    }
    runId = await startRun(jobName, trigger, job.scope);
    stepNo = 0;
  } else {
    runId = body.run_id;
    stepNo = body.step ?? 0;
  }

  const step = job.steps[stepNo];
  if (!step) {
    return Response.json({ ok: false, error: `job "${jobName}" has no step ${stepNo}` }, { status: 400 });
  }

  await startStep(runId, stepNo, step);
  const outcome = await runStep(step, job);
  await finishStep(runId, stepNo, outcome);

  // A failed step doesn't stop the chain: the syncs write independent
  // tables, and stale stats because transactions hit a Sleeper hiccup is
  // worse than a partial refresh. The run's status records the failure.
  if (stepNo + 1 < job.steps.length) {
    await handOff(jobName, runId, stepNo + 1);
  } else {
    await finishRun(runId);
  }

  return Response.json({ ok: outcome.status !== 'error', run_id: runId, step_no: stepNo, step, ...outcome });
});

async function runStep(step: StepName, job: Job): Promise<StepOutcome> {
  let result: SyncResult;
  try {
    if (step === 'deploy') {
      result = await triggerNetlifyBuild();
    } else {
      const supabase = adminClient();
      const scope = await resolveSeasonScope(supabase, job.scope);
      result = await SYNCS[step]({ supabase, scope });
    }
  } catch (err) {
    console.error(`step ${step} failed:`, err);
    result = { rows: 0, errors: [String(err).slice(0, 500)], warnings: [] };
  }

  const status = result.errors.length > 0 ? 'error' : result.warnings.length > 0 ? 'warning' : 'ok';
  return { status, ...result };
}

// supabase-js with the project's new-style secret key (sb_secret_…),
// injected by the platform as SUPABASE_SECRET_KEYS. Deliberately not the
// legacy SUPABASE_SERVICE_ROLE_KEY, which stops working at the end of 2026.
function adminClient() {
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  if (!keys.default) {
    throw new Error('SUPABASE_SECRET_KEYS has no "default" key — create one under Settings → API Keys');
  }
  return createClient(Deno.env.get('SUPABASE_URL')!, keys.default, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Rebuild the site so pre-rendered pages pick up the new data (only the
// on-demand /players and /games routes read Supabase per request).
async function triggerNetlifyBuild(): Promise<SyncResult> {
  const hook = Deno.env.get('NETLIFY_BUILD_HOOK');
  if (!hook) {
    return { rows: 0, errors: [], warnings: ['NETLIFY_BUILD_HOOK is not set — site was not rebuilt'] };
  }
  const url = `${hook}?trigger_title=${encodeURIComponent('Nightly data sync')}`;
  const res = await fetch(url, { method: 'POST', body: '{}' });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`Netlify build hook returned ${res.status}`);
  console.log('Netlify build triggered.');
  return { rows: 0, errors: [], warnings: [] };
}

function isMidnightET(now: Date): boolean {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number(hour) === 0;
}
