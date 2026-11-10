// First Deno-testing note: `deno test` discovers files ending in _test.ts and
// runs every Deno.test() block. The assert helpers come from Deno's standard
// library on jsr.io (Deno's package registry) — fetched once, then cached.
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import {
  EMPTY_WEEK,
  etWallClock,
  isCollectDue,
  isLockDue,
  isPostDue,
  isRemindDue,
  isScoreDue,
  pollDurationHours,
  shouldSkip,
  unixSeconds,
} from './calendar.ts';

// Week 10 of 2026, exactly as seeded (verified against the live DB):
// post Tue Nov 10 09:00 EST = 14:00 UTC, etc.
const wk10 = {
  season: 2026,
  week: 10,
  post_at: new Date('2026-11-10T14:00:00Z'),
  remind_at: new Date('2026-11-13T01:00:00Z'), // Thu 8 PM EST
  lock_at: new Date('2026-11-15T18:00:00Z'), // Sun 1 PM EST
  score_at: new Date('2026-11-17T13:30:00Z'), // Tue 8:30 AM EST
};

Deno.test('ET wall clock: EST week renders correctly', () => {
  assertEquals(etWallClock(wk10.lock_at), 'Sunday 1:00 PM ET');
  assertEquals(etWallClock(wk10.remind_at), 'Thursday 8:00 PM ET');
});

Deno.test('ET wall clock: EDT instant renders correctly (DST handled)', () => {
  // Week 1 Sunday 1 PM would have been EDT: 17:00 UTC, not 18:00.
  assertEquals(etWallClock(new Date('2026-09-13T17:00:00Z')), 'Sunday 1:00 PM ET');
});

Deno.test('poll duration: ceil to whole hours, clamped to 1..768', () => {
  const now = new Date('2026-11-10T14:00:00Z'); // Tue 9 AM post time
  assertEquals(pollDurationHours(wk10.lock_at, now), 124); // spec §7.3 example
  assertEquals(pollDurationHours(new Date(now.getTime() + 90_000), now), 1);
  assertEquals(pollDurationHours(new Date('2027-06-01T00:00:00Z'), now), 768);
});

Deno.test('unix seconds for <t:...> tags', () => {
  assertEquals(unixSeconds(wk10.lock_at), 1794765600);
});

Deno.test('POST: due between post_at and lock_at, and only once', () => {
  const at = (s: string) => new Date(s);
  assertFalse(isPostDue(EMPTY_WEEK, wk10, at('2026-11-10T13:59:00Z')));
  assert(isPostDue(EMPTY_WEEK, wk10, at('2026-11-10T14:00:00Z')));
  // catch-up: still posts late, right up to lock
  assert(isPostDue(EMPTY_WEEK, wk10, at('2026-11-14T00:00:00Z')));
  assertFalse(isPostDue(EMPTY_WEEK, wk10, at('2026-11-15T18:00:00Z')));
  assertFalse(isPostDue({ ...EMPTY_WEEK, posted_at: at('2026-11-10T14:00:05Z') }, wk10, at('2026-11-10T15:00:00Z')));
  assertFalse(isPostDue({ ...EMPTY_WEEK, skipped: true }, wk10, at('2026-11-11T00:00:00Z')));
});

Deno.test('skip rule: never-posted week dies at lock', () => {
  assertFalse(shouldSkip(EMPTY_WEEK, wk10, new Date('2026-11-15T17:59:00Z')));
  assert(shouldSkip(EMPTY_WEEK, wk10, new Date('2026-11-15T18:00:00Z')));
  assertFalse(shouldSkip({ ...EMPTY_WEEK, posted_at: new Date() }, wk10, new Date('2026-11-16T00:00:00Z')));
});

Deno.test('REMIND: needs a post, stops at lock', () => {
  const posted = { ...EMPTY_WEEK, posted_at: new Date('2026-11-10T14:00:05Z') };
  assertFalse(isRemindDue(EMPTY_WEEK, wk10, new Date('2026-11-13T01:00:00Z')));
  assert(isRemindDue(posted, wk10, new Date('2026-11-13T01:00:00Z')));
  assertFalse(isRemindDue(posted, wk10, new Date('2026-11-15T18:00:00Z')));
  assertFalse(isRemindDue({ ...posted, reminded_at: new Date() }, wk10, new Date('2026-11-13T02:00:00Z')));
});

Deno.test('LOCK → COLLECT (+10 min) → SCORE chain', () => {
  const posted = { ...EMPTY_WEEK, posted_at: new Date('2026-11-10T14:00:05Z') };
  assert(isLockDue(posted, wk10, new Date('2026-11-15T18:00:00Z')));
  const locked = { ...posted, locked_at: new Date('2026-11-15T18:00:10Z') };
  assertFalse(isCollectDue(locked, wk10, new Date('2026-11-15T18:05:00Z')));
  assert(isCollectDue(locked, wk10, new Date('2026-11-15T18:10:00Z')));
  const collected = { ...locked, collected_at: new Date('2026-11-15T18:12:00Z') };
  assertFalse(isScoreDue(collected, wk10, new Date('2026-11-16T13:30:00Z'))); // Monday: too early
  assert(isScoreDue(collected, wk10, new Date('2026-11-17T13:30:00Z')));
  assertFalse(isScoreDue({ ...collected, scored_at: new Date() }, wk10, new Date('2026-11-17T14:00:00Z')));
});
