// Job definitions for the `sync` Edge Function.
//
// A job is an ordered list of steps plus the season scope its syncs run
// under. Each step runs in its OWN function invocation (see index.ts), so
// the Free-plan per-request caps — 2 s CPU, 150 s wall clock — apply per
// step, not to the whole chain.
//
// To add a job: add an entry here, deploy, and cron.schedule a call that
// posts {"job":"<name>","trigger":"cron"} (README.md has the template).
// To add a step kind: add it to SYNCS in _shared/sync/mod.ts (a data sync)
// or to EXTRA_STEPS in index.ts (anything else, like `deploy`).

import type { SyncName } from '../_shared/sync/mod.ts';

export type StepName = SyncName | 'deploy';

export type Job = {
  /** Scope token for every sync step: 'latest', 'all', or a year. */
  scope: string;
  steps: StepName[];
};

export const JOBS: Record<string, Job> = {
  // `npm run sync:recent`, then a Netlify rebuild so the pre-rendered
  // pages pick the new data up. Step order matches the npm `sync` chain:
  // matchups reads seeds from results.
  recent: {
    scope: 'latest',
    steps: ['results', 'matchups', 'rosters', 'transactions', 'drafts', 'exhibitions', 'stats', 'deploy'],
  },
};
