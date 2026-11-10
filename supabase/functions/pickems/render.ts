// Every message the bot sends is built here, as a pure function returning a
// Discord payload object (or a string). No I/O — this whole file is unit-
// testable without Discord.

import { etWallClock, pollDurationHours, unixSeconds } from './calendar.ts';

export type Team = {
  teamKey: string;
  displayName: string;
  shortName: string | null;
  emoji: string | null;
};

// ── Poll payload (spec §7.3, §10.2) ─────────────────────────────────────────

const QUESTION_MAX = 300; // Discord hard limits; polls can't be edited after
const ANSWER_MAX = 55; //   creation, so we validate before posting.

function questionText(week: number, label: string | null, a: string, b: string) {
  const tag = label ? ` · ${label}` : '';
  return `Week ${week}${tag} — ${a} vs ${b}`;
}

export function buildPollPayload(opts: {
  leagueKey: string;
  season: number;
  week: number;
  slot: number;
  label: string | null;
  teamA: Team;
  teamB: Team;
  lockAt: Date;
  now: Date;
}) {
  const { teamA, teamB } = opts;

  // Prefer full names; fall back to short names if a Discord limit would be
  // hit (spec §10.2). The two answers must stay consistent with each other.
  let aText = teamA.displayName;
  let bText = teamB.displayName;
  let question = questionText(opts.week, opts.label, aText, bText);
  if (
    question.length > QUESTION_MAX ||
    aText.length > ANSWER_MAX || bText.length > ANSWER_MAX
  ) {
    aText = teamA.shortName ?? teamA.displayName;
    bText = teamB.shortName ?? teamB.displayName;
    question = questionText(opts.week, opts.label, aText, bText);
  }

  // Poll answers may carry an emoji. Ours are plain Unicode characters, which
  // Discord takes as `{ "name": "🍍" }` (custom server emoji would use
  // `{ "id": ... }` instead — not used here, spec §18.13).
  const answer = (text: string, emoji: string | null) => ({
    poll_media: {
      text,
      ...(emoji ? { emoji: { name: emoji } } : {}),
    },
  });

  return {
    // A nonce is a client-chosen dedupe token: if the same nonce is re-sent
    // within a few minutes (say, a crashed tick retrying), Discord returns
    // the original message instead of creating a duplicate. Deterministic
    // per poll and ≤ 25 chars (spec §7.3).
    nonce: `${opts.leagueKey}-${opts.season}-${opts.week}-${opts.slot}`,
    enforce_nonce: true,
    poll: {
      question: { text: question },
      answers: [
        answer(aText, teamA.emoji),
        answer(bText, teamB.emoji),
      ],
      duration: pollDurationHours(opts.lockAt, opts.now),
      allow_multiselect: false,
      layout_type: 1,
    },
  };
}

// Posting order (spec §8.4): tagged games first — Dynasty Bowl, playoff
// rounds, Rivalry, Bowl — then the rest in slot order.
export function pollSortKey(label: string | null, slot: number): [number, number] {
  let group = 4;
  if (label) {
    if (label.startsWith('Dynasty Bowl')) group = 0;
    else if (label.startsWith('Rivalry Week')) group = 2;
    else if (
      /Quarterfinal|Semifinal|Place|Consolation|Round/.test(label)
    ) group = 1;
    else group = 3; // bowls and anything else tagged
  }
  return [group, slot];
}

export function sortPolls<T extends { label: string | null; slot: number }>(
  polls: T[],
): T[] {
  return [...polls].sort((x, y) => {
    const [gx, sx] = pollSortKey(x.label, x.slot);
    const [gy, sy] = pollSortKey(y.label, y.slot);
    return gx - gy || sx - sy;
  });
}

// ── Header (spec §8.4) ──────────────────────────────────────────────────────

export function buildHeader(opts: {
  leagueShort: string;
  week: number;
  lockAt: Date;
  standingsPendingWeek: number | null; // previous week, if its scoring is blocked
}): string {
  // `<t:UNIX:F>` is a Discord timestamp: viewers see it in their own local
  // timezone, so the ET string and the tag never disagree for anyone.
  const lines = [
    `🏈 **${opts.leagueShort} Week ${opts.week} Pick'ems**. Picks lock ` +
    `**${etWallClock(opts.lockAt)}** (<t:${unixSeconds(opts.lockAt)}:F>).`,
  ];
  if (opts.standingsPendingWeek !== null) {
    lines.push(`Week ${opts.standingsPendingWeek} standings pending.`);
  }
  return lines.join('\n');
}

// ── Standings (spec §10.1) ──────────────────────────────────────────────────

export type StandingsRow = {
  rank: number;
  displayName: string;
  correct: number;
  incorrect: number;
  pct: number | null;
  lastWeekCorrect: number;
  lastWeekTotal: number;
};

const fmtPct = (p: number | null) =>
  p === null ? '  — ' : p.toFixed(3).replace(/^0/, '');

export function buildStandings(opts: {
  leagueShort: string;
  throughWeek: number;
  rows: StandingsRow[];
  final?: boolean; // end of season (spec §4.2)
  season?: number;
}): string {
  const { rows } = opts;
  if (rows.length === 0) {
    return `No graded picks yet — standings start after Week ${opts.throughWeek} is scored.`;
  }
  const nameW = Math.max(6, ...rows.map((r) => r.displayName.length));
  const lines = [
    `${opts.leagueShort} PICK'EMS · THROUGH WEEK ${opts.throughWeek}`,
    ` #  ${'Player'.padEnd(nameW)}  ${'W–L'.padStart(5)}    Pct   Wk ${opts.throughWeek}`,
  ];
  for (const r of rows) {
    const wl = `${r.correct}–${r.incorrect}`;
    const wk = r.lastWeekTotal > 0 ? `${r.lastWeekCorrect}–${r.lastWeekTotal - r.lastWeekCorrect}` : '—';
    const perfect = r.lastWeekTotal > 0 && r.lastWeekCorrect === r.lastWeekTotal
      ? '   ← perfect week'
      : '';
    lines.push(
      `${String(r.rank).padStart(2)}  ${r.displayName.padEnd(nameW)}  ` +
      `${wl.padStart(5)}   ${fmtPct(r.pct)}   ${wk}${perfect}`,
    );
  }

  let out = '```\n' + lines.join('\n') + '\n```';

  // "Best week: Josh (7–0)" — top scorer(s) of the just-scored week.
  const best = Math.max(0, ...rows.map((r) => r.lastWeekCorrect));
  if (best > 0) {
    const names = rows
      .filter((r) => r.lastWeekCorrect === best)
      .map((r) => `${r.displayName} (${r.lastWeekCorrect}–${r.lastWeekTotal - r.lastWeekCorrect})`);
    out += `\nBest week: ${names.join(', ')}`;
  }
  if (opts.final) {
    const champs = rows.filter((r) => r.rank === 1).map((r) => r.displayName);
    const year = opts.season ? `${opts.season} ` : '';
    out += `\n🏆 ${champs.join(' & ')} — ${year}Pick'ems Champion${champs.length > 1 ? 's' : ''}`;
  }
  return out;
}

// ── Reminder (spec §10.3, §7.5) ─────────────────────────────────────────────

export function buildReminder(opts: {
  week: number;
  lockAt: Date;
  missing: { userId: string; picked: number; total: number }[];
}) {
  const who = opts.missing
    .map((m) => `<@${m.userId}> (${m.picked} of ${m.total})`)
    .join(', ');
  return {
    content:
      `⏰ **Week ${opts.week} picks lock ${etWallClock(opts.lockAt)}** ` +
      `(<t:${unixSeconds(opts.lockAt)}:R>). Still missing picks: ${who}`,
    // allowed_mentions is Discord's safety net: with parse [] and an explicit
    // user list, ONLY these users can be pinged — a stray "@everyone" in the
    // text would render as plain text, never a mass ping (spec §7.5).
    allowed_mentions: {
      parse: [],
      users: opts.missing.map((m) => m.userId),
    },
  };
}

// ── Results recap (spec §8.4) ───────────────────────────────────────────────

export type RecapLine = {
  label: string | null;
  winner: Team | null; // null → void (tie)
  loser: Team | null;
  winnerPoints: number;
  loserPoints: number;
  pickedWinner: number;
  pickedTotal: number;
};

export function buildRecap(opts: { leagueShort: string; week: number; lines: RecapLine[] }): string {
  const out = [`**${opts.leagueShort} Week ${opts.week} results**`];
  for (const l of opts.lines) {
    const tag = l.label ? `${l.label}: ` : '';
    if (!l.winner || !l.loser) {
      out.push(`• ${tag}Tie ${l.winnerPoints.toFixed(2)}–${l.loserPoints.toFixed(2)} — poll void`);
      continue;
    }
    const w = l.winner.emoji ? `${l.winner.emoji} ` : '';
    out.push(
      `• ${tag}${w}**${l.winner.displayName}** def. ${l.loser.displayName} ` +
      `${l.winnerPoints.toFixed(2)}–${l.loserPoints.toFixed(2)} · ` +
      `${l.pickedWinner} of ${l.pickedTotal} picked the winner`,
    );
  }
  return out.join('\n');
}
