// The state machine (spec §8.2). Every 5 minutes a tick asks, for each
// active league and each calendar week whose post time has arrived: which
// steps are due and unmet? Steps always run in the order SCORE → POST →
// REMIND → LOCK → COLLECT, and each records its completion timestamp, so a
// crashed or doubled run simply resumes where things stopped.

import {
  acquireLease,
  ensureWeek,
  getActiveLeagues,
  getCalendar,
  getConfig,
  getLeague,
  getStandings,
  getTeams,
  getWeek,
  type League,
  markStep,
  releaseLease,
  sql,
  type TeamRow,
  upsertPlayers,
} from './db.ts';
import {
  expirePoll,
  getAnswerVoters,
  getMessage,
  postMessage,
  voterDisplayName,
} from './discord.ts';
import { pairingsFor, resultsFor } from './sources.ts';
import { gradeMatchup, missingPickers } from './grading.ts';
import {
  buildHeader,
  buildPollPayload,
  buildRecap,
  buildReminder,
  buildStandings,
  type RecapLine,
  sortPolls,
  type StandingsRow,
  type Team,
} from './render.ts';
import {
  type CalendarRow,
  isCollectDue,
  isLockDue,
  isPostDue,
  isRemindDue,
  isScoreDue,
  shouldSkip,
  type WeekRow,
} from './calendar.ts';

type Summary = Record<string, unknown>[];

const asTeam = (t: TeamRow | undefined, key: string): Team => ({
  teamKey: key,
  displayName: t?.display_name ?? `Roster ${key}`,
  shortName: t?.short_name ?? null,
  emoji: t?.emoji ?? null,
});

// dry_run = 'true' sends EVERY Discord write to the admin channel instead of
// the league channel (spec §8.3) — the content is identical.
function targetChannel(league: { channel_id: string }, config: Record<string, string>) {
  return config.dry_run === 'true' ? config.admin_channel_id : league.channel_id;
}

// One admin alert per (league, week) between successes: alert_sent_at guards
// it, and every successful step clears it (see db.markStep).
async function alertOnce(
  league: { key: string; season: number; short_name: string },
  week: number,
  config: Record<string, string>,
  text: string,
) {
  const w = await getWeek(league.key, league.season, week);
  if (w?.alert_sent_at) return;
  await postMessage(config.admin_channel_id, {
    content: `⚠️ ${league.short_name} Week ${week}: ${text}`,
  });
  await sql`
    update pickems.weeks set alert_sent_at = now(), last_error = ${text}
    where league_key = ${league.key} and season = ${league.season} and week = ${week}`;
}

function toWeekRow(w: unknown): WeekRow {
  return w as WeekRow;
}

function toCalRow(c: unknown): CalendarRow {
  return c as unknown as CalendarRow;
}

async function standingsRows(leagueKey: string, season: number): Promise<StandingsRow[]> {
  const rows = await getStandings(leagueKey, season);
  return rows.map((r) => ({
    rank: Number(r.rank),
    displayName: r.display_name,
    correct: Number(r.correct),
    incorrect: Number(r.incorrect),
    pct: r.pct === null ? null : Number(r.pct),
    lastWeekCorrect: Number(r.last_week_correct),
    lastWeekTotal: Number(r.last_week_total),
  }));
}

// ── POST (Tue 9:00) ─────────────────────────────────────────────────────────

async function stepPost(
  league: League,
  cal: CalendarRow,
  config: Record<string, string>,
  summary: Summary,
) {
  const { key, season } = league;
  const week = cal.week;
  const pairings = await pairingsFor(league, week);
  if (pairings.length === 0) {
    await alertOnce(league, week, config, 'no pairings available at post time; retrying every tick until lock');
    summary.push({ step: 'post', week, result: 'no-pairings' });
    return;
  }

  // Idempotency (spec §8.2): the polls rows exist BEFORE anything is posted,
  // message_id null. Only null-message_id rows get posted, and each
  // message_id is saved immediately, so a crash mid-week resumes with the
  // remaining polls. The Discord nonce covers the instant between "posted"
  // and "saved".
  for (const p of pairings) {
    await sql`
      insert into pickems.polls (league_key, season, week, slot, team_a_key, team_b_key, label)
      values (${key}, ${season}, ${week}, ${p.slot}, ${p.teamAKey}, ${p.teamBKey}, ${p.label})
      on conflict do nothing`;
  }

  const channel = targetChannel(league, config);
  const teams = await getTeams(key);

  // Header first (standings-pending line if last week is stuck), then polls.
  // The header has no DB dedupe column; a crash right after it can repost it
  // on the next tick — cosmetic, and rare enough to accept (polls, which
  // matter, are fully guarded).
  const pending = await sql`
    select 1 from pickems.weeks
    where league_key = ${key} and season = ${season} and week = ${week - 1}
      and not skipped and scored_at is null`;
  const anyPosted = await sql`
    select 1 from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is not null limit 1`;
  if (anyPosted.length === 0) {
    await postMessage(channel, {
      content: buildHeader({
        leagueShort: league.short_name,
        week,
        lockAt: cal.lock_at,
        standingsPendingWeek: pending.length > 0 ? week - 1 : null,
      }),
    });
  }

  const unposted = (await sql`
    select slot, team_a_key, team_b_key, label
    from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is null
    order by slot`) as unknown as {
      slot: number;
      team_a_key: string;
      team_b_key: string;
      label: string | null;
    }[];

  for (const poll of sortPolls(unposted)) {
    const payload = buildPollPayload({
      leagueKey: key,
      season,
      week,
      slot: poll.slot,
      label: poll.label,
      teamA: asTeam(teams.get(poll.team_a_key), poll.team_a_key),
      teamB: asTeam(teams.get(poll.team_b_key), poll.team_b_key),
      lockAt: cal.lock_at,
      now: new Date(),
    });
    const msg = await postMessage(channel, payload) as {
      id: string;
      poll?: { answers?: { answer_id: number }[] };
    };
    // answer_ids come from Discord's response, in the order we sent the
    // answers — never assume they are 1/2 (spec §7.3).
    const answers = msg.poll?.answers ?? [];
    await sql`
      update pickems.polls
      set message_id = ${msg.id},
          answer_a_id = ${answers[0]?.answer_id ?? null},
          answer_b_id = ${answers[1]?.answer_id ?? null}
      where league_key = ${key} and season = ${season} and week = ${week} and slot = ${poll.slot}`;
    // ~1 s between posts keeps us far from rate limits (spec §7.4)
    await new Promise((r) => setTimeout(r, 1000));
  }

  await markStep(key, season, week, 'posted_at');
  summary.push({ step: 'post', week, polls: unposted.length });
}

// ── REMIND (Thu 8 PM) ───────────────────────────────────────────────────────

async function stepRemind(
  league: League,
  cal: CalendarRow,
  config: Record<string, string>,
  summary: Summary,
) {
  const { key, season } = league;
  const week = cal.week;
  const polls = await sql`
    select slot, message_id, answer_a_id, answer_b_id
    from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is not null`;

  // Live voter lists (approximate until finalization — fine for a nudge,
  // spec §10.3). Voting from the poll's own channel, so the poll's channel
  // is wherever we posted it.
  const channel = targetChannel(league, config);
  const counts = new Map<string, number>();
  const seen = new Map<string, string>(); // id → display name
  for (const p of polls) {
    for (const answerId of [p.answer_a_id, p.answer_b_id]) {
      if (answerId === null) continue;
      const voters = await getAnswerVoters(channel, p.message_id, answerId);
      for (const u of voters) {
        counts.set(u.id, (counts.get(u.id) ?? 0) + 1);
        seen.set(u.id, voterDisplayName(u));
      }
    }
  }

  // §18.2: anyone seen voting becomes a tracked player with remind = true.
  await upsertPlayers(
    key,
    [...seen].map(([id, displayName]) => ({ id, displayName })),
  );

  const eligible = await sql`
    select discord_user_id, remind from pickems.player_leagues
    where league_key = ${key}`;
  const missing = missingPickers(
    eligible.map((e) => ({ userId: e.discord_user_id, remind: e.remind })),
    polls.length,
    counts,
  );

  if (missing.length > 0) {
    await postMessage(channel, buildReminder({ week, lockAt: cal.lock_at, missing }));
  }
  // Nobody missing → post nothing (open question #5 default).
  await markStep(key, season, week, 'reminded_at');
  summary.push({ step: 'remind', week, mentioned: missing.length });
}

// ── LOCK (Sun 1 PM) ─────────────────────────────────────────────────────────

async function stepLock(
  league: League,
  cal: CalendarRow,
  config: Record<string, string>,
  summary: Summary,
) {
  const { key, season } = league;
  const week = cal.week;
  const polls = await sql`
    select message_id from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is not null`;
  const channel = targetChannel(league, config);
  for (const p of polls) {
    await expirePoll(channel, p.message_id); // "already ended" counts as done
  }
  await markStep(key, season, week, 'locked_at');
  summary.push({ step: 'lock', week, polls: polls.length });
}

// ── COLLECT (lock + 10 min) ─────────────────────────────────────────────────

async function stepCollect(
  league: League,
  cal: CalendarRow,
  weekRow: WeekRow,
  config: Record<string, string>,
  summary: Summary,
) {
  const { key, season } = league;
  const week = cal.week;
  const polls = await sql`
    select slot, message_id, team_a_key, team_b_key, answer_a_id, answer_b_id
    from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is not null`;
  const channel = targetChannel(league, config);

  // Exact counts need poll.results.is_finalized (spec §7.3). Retry on later
  // ticks; after 2 h, proceed anyway and note it (spec §4.2).
  const lockedForMs = Date.now() - (weekRow.locked_at?.getTime() ?? Date.now());
  let allFinal = true;
  for (const p of polls) {
    const msg = await getMessage(channel, p.message_id) as {
      poll?: { results?: { is_finalized?: boolean } };
    };
    if (!msg.poll?.results?.is_finalized) allFinal = false;
  }
  if (!allFinal && lockedForMs < 2 * 3_600_000) {
    summary.push({ step: 'collect', week, result: 'waiting-finalization' });
    return;
  }

  for (const p of polls) {
    const sides: [number | null, string][] = [
      [p.answer_a_id, p.team_a_key],
      [p.answer_b_id, p.team_b_key],
    ];
    for (const [answerId, teamKey] of sides) {
      if (answerId === null) continue;
      const voters = await getAnswerVoters(channel, p.message_id, answerId);
      await upsertPlayers(
        key,
        voters.map((u) => ({ id: u.id, displayName: voterDisplayName(u) })),
      );
      for (const u of voters) {
        await sql`
          insert into pickems.picks (league_key, season, week, slot, discord_user_id, pick_key)
          values (${key}, ${season}, ${week}, ${p.slot}, ${u.id}, ${teamKey})
          on conflict (league_key, season, week, slot, discord_user_id)
          do update set pick_key = excluded.pick_key`;
      }
    }
  }
  await markStep(key, season, week, 'collected_at');
  summary.push({ step: 'collect', week, finalized: allFinal });
}

// ── SCORE (next Tue 8:30) ───────────────────────────────────────────────────

async function stepScore(
  league: League,
  cal: CalendarRow,
  config: Record<string, string>,
  summary: Summary,
  opts: { isFinalWeek: boolean },
) {
  const { key, season } = league;
  const week = cal.week;
  const polls = (await sql`
    select slot, team_a_key, team_b_key, label
    from pickems.polls
    where league_key = ${key} and season = ${season} and week = ${week}
      and message_id is not null
    order by slot`) as unknown as {
      slot: number;
      team_a_key: string;
      team_b_key: string;
      label: string | null;
    }[];
  if (polls.length === 0) {
    await markStep(key, season, week, 'scored_at'); // nothing to grade
    summary.push({ step: 'score', week, result: 'no-polls' });
    return;
  }

  const points = await resultsFor(league, week);
  const grades = polls.map((p) => ({
    ...p,
    grade: gradeMatchup(p.team_a_key, p.team_b_key, points),
  }));

  if (grades.some((g) => g.grade.status === 'not_final')) {
    await alertOnce(league, week, config, 'results not final yet; retrying every 5 min');
    summary.push({ step: 'score', week, result: 'not-final' });
    return;
  }

  // Grade polls and picks. One transaction so a crash can't leave a
  // half-graded week behind ("safe to run twice" = upserts + atomic write).
  await sql.begin(async (tx) => {
    for (const g of grades) {
      const winnerKey = g.grade.status === 'won' ? g.grade.winnerKey : null;
      const isVoid = g.grade.status === 'void';
      await tx`
        update pickems.polls
        set winner_key = ${winnerKey}, is_void = ${isVoid}
        where league_key = ${key} and season = ${season} and week = ${week} and slot = ${g.slot}`;
      await tx`
        update pickems.picks
        set is_correct = case when ${isVoid} then null else (pick_key = ${winnerKey}) end
        where league_key = ${key} and season = ${season} and week = ${week} and slot = ${g.slot}`;
    }
    await tx`
      update pickems.weeks
      set scored_at = now(), alert_sent_at = null, last_error = null
      where league_key = ${key} and season = ${season} and week = ${week}`;
  });

  // Recap + standings, posted once (standings_posted_at guard, §18.3).
  const weekRow = await getWeek(key, season, week);
  if (!weekRow?.standings_posted_at) {
    const teams = await getTeams(key);
    const counts = await sql`
      select slot,
             count(*) filter (where is_correct) as picked_winner,
             count(*) filter (where is_correct is not null) as picked_total
      from pickems.picks
      where league_key = ${key} and season = ${season} and week = ${week}
      group by slot`;
    const countBySlot = new Map(counts.map((c) => [c.slot, c]));

    const lines: RecapLine[] = grades.map((g) => {
      const c = countBySlot.get(g.slot);
      const winner = g.grade.status === 'won' ? g.grade.winnerKey : null;
      const loserKey = winner === null ? null : (winner === g.team_a_key ? g.team_b_key : g.team_a_key);
      return {
        label: g.label ?? null,
        winner: winner ? asTeam(teams.get(winner), winner) : null,
        loser: loserKey ? asTeam(teams.get(loserKey), loserKey) : null,
        winnerPoints: winner ? points[winner] : points[g.team_a_key],
        loserPoints: loserKey ? points[loserKey] : points[g.team_b_key],
        pickedWinner: Number(c?.picked_winner ?? 0),
        pickedTotal: Number(c?.picked_total ?? 0),
      };
    });

    const channel = targetChannel(league, config);
    await postMessage(channel, {
      content: buildRecap({ leagueShort: league.short_name, week, lines }),
    });
    await postMessage(channel, {
      content: buildStandings({
        leagueShort: league.short_name,
        throughWeek: week,
        rows: await standingsRows(key, season),
        final: opts.isFinalWeek,
        season,
      }),
    });
    await markStep(key, season, week, 'standings_posted_at');

    // End of season (spec §4.2): final standings are out; go dormant.
    if (opts.isFinalWeek) {
      await sql`update pickems.leagues set active = false where key = ${key}`;
    }
  }
  summary.push({ step: 'score', week, graded: grades.length });
}

// ── The tick ────────────────────────────────────────────────────────────────

export async function runTick(): Promise<Summary> {
  const summary: Summary = [];
  if (!(await acquireLease())) {
    return [{ result: 'lease-busy' }]; // another tick is mid-flight
  }
  try {
    const config = await getConfig();
    const leagues = await getActiveLeagues();
    const now = new Date();

    for (const league of leagues) {
      const calendar = await getCalendar(league.season);
      const due = calendar.filter((c) => c.post_at <= now);
      const finalWeek = Math.max(...calendar.map((c) => c.week));

      // Ascending week order means an older week's SCORE always runs before
      // a newer week's POST, so Tuesday standings are fresh (spec §8.2).
      for (const calRow of due) {
        const cal = toCalRow(calRow);
        await ensureWeek(league.key, league.season, cal.week);
        const steps: [string, (w: WeekRow) => boolean, (w: WeekRow) => Promise<void>][] = [
          ['score', (w) => isScoreDue(w, cal, now), (_w) => stepScore(league, cal, config, summary, { isFinalWeek: cal.week === finalWeek })],
          ['skip', (w) => shouldSkip(w, cal, now), async (_w) => {
            await sql`
              update pickems.weeks set skipped = true
              where league_key = ${league.key} and season = ${league.season} and week = ${cal.week}`;
            summary.push({ step: 'skip', week: cal.week });
          }],
          ['post', (w) => isPostDue(w, cal, now), (_w) => stepPost(league, cal, config, summary)],
          ['remind', (w) => isRemindDue(w, cal, now), (_w) => stepRemind(league, cal, config, summary)],
          ['lock', (w) => isLockDue(w, cal, now), (_w) => stepLock(league, cal, config, summary)],
          ['collect', (w) => isCollectDue(w, cal, now), (w) => stepCollect(league, cal, w, config, summary)],
        ];
        for (const [name, isDue, run] of steps) {
          const w = toWeekRow(await getWeek(league.key, league.season, cal.week));
          if (!isDue(w)) continue;
          try {
            await run(w);
          } catch (err) {
            const text = `${name} failed: ${String(err).slice(0, 300)}`;
            await sql`
              update pickems.weeks set last_error = ${text}
              where league_key = ${league.key} and season = ${league.season} and week = ${cal.week}`;
            try {
              await alertOnce(league, cal.week, config, text);
            } catch { /* alerting must never kill the tick */ }
            summary.push({ step: name, week: cal.week, error: text });
          }
        }
      }
    }
    return summary;
  } finally {
    await releaseLease();
  }
}

// ── Admin actions (spec §8.3) ───────────────────────────────────────────────

// Build every message for a week and return it WITHOUT posting — the
// look-before-you-leap tool for first-of-a-kind weeks.
export async function preview(leagueKey: string, week: number) {
  const league = await getLeague(leagueKey);
  if (!league) throw new Error(`unknown league ${leagueKey}`);
  const calendar = await getCalendar(league.season);
  const cal = calendar.find((c) => c.week === week);
  if (!cal) throw new Error(`no calendar row for week ${week}`);

  const teams = await getTeams(leagueKey);
  const pairings = await pairingsFor(league, week);
  const sorted = sortPolls(pairings.map((p) => ({ ...p, label: p.label ?? null })));
  const now = new Date();

  return {
    league: leagueKey,
    week,
    standings: buildStandings({
      leagueShort: league.short_name,
      throughWeek: week - 1,
      rows: await standingsRows(leagueKey, league.season),
    }),
    header: buildHeader({
      leagueShort: league.short_name,
      week,
      lockAt: cal.lock_at,
      standingsPendingWeek: null,
    }),
    polls: sorted.map((p) =>
      buildPollPayload({
        leagueKey,
        season: league.season,
        week,
        slot: p.slot,
        label: p.label,
        teamA: asTeam(teams.get(p.teamAKey), p.teamAKey),
        teamB: asTeam(teams.get(p.teamBKey), p.teamBKey),
        lockAt: cal.lock_at,
        now,
      })
    ),
  };
}

// Re-fetch results, re-grade, repost standings (stat corrections, §8.3).
export async function rescore(leagueKey: string, week: number): Promise<Summary> {
  const league = await getLeague(leagueKey);
  if (!league) throw new Error(`unknown league ${leagueKey}`);
  const summary: Summary = [];
  const config = await getConfig();
  const calendar = await getCalendar(league.season);
  const cal = calendar.find((c) => c.week === week);
  if (!cal) throw new Error(`no calendar row for week ${week}`);
  // Clear the scored/standings stamps so stepScore runs and posts afresh.
  await sql`
    update pickems.weeks
    set scored_at = null, standings_posted_at = null
    where league_key = ${leagueKey} and season = ${league.season} and week = ${week}`;
  const finalWeek = Math.max(...calendar.map((c) => c.week));
  await stepScore(league, toCalRow(cal), config, summary, {
    isFinalWeek: week === finalWeek,
  });
  return summary;
}

export async function postStandingsNow(leagueKey: string): Promise<Summary> {
  const league = await getLeague(leagueKey);
  if (!league) throw new Error(`unknown league ${leagueKey}`);
  const config = await getConfig();
  const latest = await sql`
    select max(week) as week from pickems.weeks
    where league_key = ${leagueKey} and season = ${league.season} and scored_at is not null`;
  await postMessage(targetChannel(league, config), {
    content: buildStandings({
      leagueShort: league.short_name,
      throughWeek: Number(latest[0]?.week ?? 0),
      rows: await standingsRows(leagueKey, league.season),
    }),
  });
  return [{ step: 'post-standings', throughWeek: latest[0]?.week ?? null }];
}

// One-off plain message to a league's channel, respecting dry_run. Exists so
// ad-hoc posts (extra cron jobs, smoke tests) still flow through the one
// funnel — single token home, dry_run switch, runs log — instead of calling
// Discord from SQL directly.
export async function announce(leagueKey: string, message: string): Promise<Summary> {
  if (!message.trim()) throw new Error('missing "message" in body');
  const league = await getLeague(leagueKey);
  if (!league) throw new Error(`unknown league ${leagueKey}`);
  const config = await getConfig();
  const msg = await postMessage(targetChannel(league, config), {
    content: message,
  }) as { id: string };
  return [{ step: 'announce', messageId: msg.id }];
}

export async function skipWeek(leagueKey: string, week: number): Promise<Summary> {
  const league = await getLeague(leagueKey);
  if (!league) throw new Error(`unknown league ${leagueKey}`);
  await ensureWeek(leagueKey, league.season, week);
  await sql`
    update pickems.weeks set skipped = true
    where league_key = ${leagueKey} and season = ${league.season} and week = ${week}`;
  return [{ step: 'skip', week }];
}
