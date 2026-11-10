// Time helpers + "which step is due" logic. Pure: no database, no network.
//
// The scheduling ground rule (spec §4.1): every timestamp in pickems.calendar
// was converted from Eastern wall-clock time to UTC once, at seed time, by
// Postgres. So this module never does timezone *arithmetic* — it only
// compares instants, and formats an instant back to ET for display.

export type CalendarRow = {
  season: number;
  week: number;
  post_at: Date;
  remind_at: Date;
  lock_at: Date;
  score_at: Date;
};

export type WeekRow = {
  posted_at: Date | null;
  reminded_at: Date | null;
  locked_at: Date | null;
  collected_at: Date | null;
  scored_at: Date | null;
  standings_posted_at: Date | null;
  skipped: boolean;
};

// A brand-new pickems.weeks row, before any step has run.
export const EMPTY_WEEK: WeekRow = {
  posted_at: null,
  reminded_at: null,
  locked_at: null,
  collected_at: null,
  scored_at: null,
  standings_posted_at: null,
  skipped: false,
};

const HOUR_MS = 3_600_000;

// Discord poll duration is whole hours, 1..768 (32 days). We aim past the
// lock so Discord's own auto-close acts as a backstop if the bot is down;
// the LOCK step still expires the poll at the exact lock time (spec §7.3).
export function pollDurationHours(lockAt: Date, now: Date): number {
  const hours = Math.ceil((lockAt.getTime() - now.getTime()) / HOUR_MS);
  return Math.min(768, Math.max(1, hours));
}

// Discord renders `<t:1763229600:F>` as a full date-time in each viewer's
// own timezone — the value is plain Unix seconds (UTC).
export function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// "Sunday 1:00 PM ET" for an instant — display only. Intl applies the
// America/New_York rules, so EST vs EDT is handled by the runtime.
export function etWallClock(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ET`;
}

// ── Step predicates (spec §4.2) ──────────────────────────────────────────────
// Each step checks its own completion timestamp, so re-running a tick is
// always safe ("every step must be safe to run twice").

// Catch-up rule: post late if lock hasn't passed; never post after lock.
export function isPostDue(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !week.posted_at && !week.skipped &&
    now >= cal.post_at && now < cal.lock_at;
}

// If lock passed and the week was never posted, it's dead — mark and move on.
export function shouldSkip(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !week.posted_at && !week.skipped && now >= cal.lock_at;
}

export function isRemindDue(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !!week.posted_at && !week.reminded_at &&
    now >= cal.remind_at && now < cal.lock_at;
}

export function isLockDue(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !!week.posted_at && !week.locked_at && now >= cal.lock_at;
}

// COLLECT waits 10 minutes past lock so Discord has finalized poll results
// (vote counts are only exact once `is_finalized` is true, spec §7.3).
export function isCollectDue(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !!week.locked_at && !week.collected_at &&
    now.getTime() >= cal.lock_at.getTime() + 10 * 60_000;
}

export function isScoreDue(week: WeekRow, cal: CalendarRow, now: Date): boolean {
  return !!week.collected_at && !week.scored_at && now >= cal.score_at;
}
