// HTTP entry point (spec §8.1). Deno.serve is how a Supabase Edge Function
// receives requests: this handler runs per invocation, with no process state
// between calls — all state lives in Postgres.
//
// Auth: the platform's JWT check is off (config.toml: verify_jwt = false)
// because our caller is pg_cron, not a logged-in user. Instead every request
// must present the x-cron-secret header matching the CRON_SECRET env var.
// Anything else gets a 401 and does nothing.

import { finishRun, startRun } from './db.ts';
import { announce, preview, postStandingsNow, rescore, runTick, skipWeek } from './tick.ts';

type Body = {
  action?: 'tick' | 'preview' | 'rescore' | 'post-standings' | 'skip' | 'announce';
  league?: string;
  week?: number;
  message?: string;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* empty body → default tick */ }
  const action = body.action ?? 'tick';

  // Every invocation leaves a pickems.runs row behind for debugging (§8.1).
  const runId = await startRun(action);
  try {
    let result: unknown;
    switch (action) {
      case 'tick':
        result = await runTick();
        break;
      case 'preview':
        result = await preview(requireLeague(body), requireWeek(body));
        break;
      case 'rescore':
        result = await rescore(requireLeague(body), requireWeek(body));
        break;
      case 'post-standings':
        result = await postStandingsNow(requireLeague(body));
        break;
      case 'skip':
        result = await skipWeek(requireLeague(body), requireWeek(body));
        break;
      case 'announce':
        result = await announce(requireLeague(body), body.message ?? '');
        break;
      default:
        throw new Error(`unknown action ${action}`);
    }
    await finishRun(runId, result, null);
    return Response.json({ ok: true, action, result });
  } catch (err) {
    const msg = String(err).slice(0, 500);
    await finishRun(runId, null, msg);
    return Response.json({ ok: false, action, error: msg }, { status: 500 });
  }
});

function requireLeague(body: Body): string {
  if (!body.league) throw new Error('missing "league" in body');
  return body.league;
}

function requireWeek(body: Body): number {
  if (typeof body.week !== 'number') throw new Error('missing "week" in body');
  return body.week;
}
