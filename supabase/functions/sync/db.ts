// Bookkeeping for the `sync` function: the ops.runs / ops.run_steps log and
// the pg_net hand-off that chains one step to the next.
//
// Two database clients live in this function, on purpose:
//   - postgres.js (here) for the function's own ops.* bookkeeping and the
//     hand-off. SUPABASE_DB_URL is a built-in secret pointing at the
//     transaction pooler, hence `prepare: false` (same as pickems/db.ts).
//   - supabase-js (index.ts) for the syncs themselves, because the shared
//     sync modules are written against it so they can also run under Node.

import postgres from 'npm:postgres@3.4.5';

export const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
});

export type StepStatus = 'ok' | 'warning' | 'error';

export type StepOutcome = {
  status: StepStatus;
  rows: number;
  errors: string[];
  warnings: string[];
};

export async function startRun(job: string, trigger: string, scope: string): Promise<number> {
  const [row] = await sql`
    insert into ops.runs (job, trigger, scope)
    values (${job}, ${trigger}, ${scope})
    returning id`;
  return Number(row.id);
}

export async function startStep(runId: number, stepNo: number, step: string): Promise<void> {
  await sql`
    insert into ops.run_steps (run_id, step_no, step)
    values (${runId}, ${stepNo}, ${step})
    on conflict (run_id, step_no) do update
      set started_at = now(), finished_at = null, status = 'running', rows = null, detail = null`;
}

export async function finishStep(runId: number, stepNo: number, outcome: StepOutcome): Promise<void> {
  const detail = { errors: outcome.errors, warnings: outcome.warnings };
  await sql`
    update ops.run_steps
       set finished_at = now(),
           status = ${outcome.status},
           rows = ${outcome.rows},
           detail = ${sql.json(detail)}
     where run_id = ${runId} and step_no = ${stepNo}`;
}

/** Close the run with the worst status any of its steps reached. */
export async function finishRun(runId: number): Promise<void> {
  await sql`
    update ops.runs
       set finished_at = now(),
           status = (
             select case
                      when bool_or(status in ('error', 'running')) then 'error'
                      when bool_or(status = 'warning') then 'warning'
                      else 'ok'
                    end
               from ops.run_steps
              where run_id = ${runId})
     where id = ${runId}`;
}

/**
 * Queue the next step as a fresh invocation of this function.
 *
 * net.http_post only enqueues the request — pg_net's background worker
 * sends it after this transaction commits — so this returns immediately
 * and the current invocation can finish. Each step therefore gets its own
 * CPU/wall-clock budget instead of the chain nesting inside one request.
 * URL and secret come from Vault, exactly as the cron job reads them.
 */
export async function handOff(job: string, runId: number, stepNo: number): Promise<void> {
  const body = { job, run_id: runId, step: stepNo };
  await sql`
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ops_cron_secret')
      ),
      body := ${sql.json(body)}::jsonb,
      timeout_milliseconds := 150000
    )`;
}
