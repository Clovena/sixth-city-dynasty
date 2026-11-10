import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import {
  buildHeader,
  buildPollPayload,
  buildRecap,
  buildReminder,
  buildStandings,
  sortPolls,
  type Team,
} from './render.ts';
import { toRoman } from './util.ts';

const BKB: Team = { teamKey: '2', displayName: 'Bikini Bottom Stars', shortName: 'Stars', emoji: '🍍' };
const WPG: Team = { teamKey: '5', displayName: 'Winnipeg Wranglers', shortName: 'Wranglers', emoji: '🏇' };

const lockAt = new Date('2026-11-22T18:00:00Z'); // Week 11 lock, Sun 1 PM EST
const now = new Date('2026-11-17T14:00:00Z'); // Week 11 post, Tue 9 AM EST

Deno.test('poll payload matches §7.3: question, emoji answers, nonce, duration', () => {
  const p = buildPollPayload({
    leagueKey: 'dfl', season: 2026, week: 11, slot: 1,
    label: 'Atom Bowl', teamA: BKB, teamB: WPG, lockAt, now,
  });
  assertEquals(p.poll.question.text, 'Week 11 · Atom Bowl — Bikini Bottom Stars vs Winnipeg Wranglers');
  assertEquals(p.poll.answers[0].poll_media, { text: 'Bikini Bottom Stars', emoji: { name: '🍍' } });
  assertEquals(p.poll.answers[1].poll_media, { text: 'Winnipeg Wranglers', emoji: { name: '🏇' } });
  assertEquals(p.nonce, 'dfl-2026-11-1');
  assert(p.nonce.length <= 25, 'nonce must fit Discord’s 25-char limit');
  assertEquals(p.enforce_nonce, true);
  assertEquals(p.poll.duration, 124);
  assertEquals(p.poll.allow_multiselect, false);
});

Deno.test('poll payload: no label, no emoji', () => {
  const noEmoji: Team = { ...WPG, emoji: null };
  const p = buildPollPayload({
    leagueKey: 'dfl', season: 2026, week: 11, slot: 4,
    label: null, teamA: BKB, teamB: noEmoji, lockAt, now,
  });
  assertEquals(p.poll.question.text, 'Week 11 — Bikini Bottom Stars vs Winnipeg Wranglers');
  assertEquals(p.poll.answers[1].poll_media, { text: 'Winnipeg Wranglers' });
});

Deno.test('poll payload: falls back to short names when limits are exceeded', () => {
  const longA: Team = { teamKey: '9', displayName: 'A'.repeat(60), shortName: 'Shorty', emoji: null };
  const p = buildPollPayload({
    leagueKey: 'dfl', season: 2026, week: 11, slot: 2,
    label: null, teamA: longA, teamB: WPG, lockAt, now,
  });
  // one over-long answer flips BOTH answers to short names
  assertEquals(p.poll.answers[0].poll_media, { text: 'Shorty' });
  assertEquals(p.poll.answers[1].poll_media, { text: 'Wranglers', emoji: { name: '🏇' } });
  assert(p.poll.question.text.length <= 300);
});

Deno.test('posting order: Dynasty Bowl, playoff, rivalry, bowl, untagged (§8.4)', () => {
  const polls = [
    { slot: 1, label: null },
    { slot: 2, label: 'Atom Bowl' },
    { slot: 3, label: 'Rivalry Week · Stars vs Lasercats' },
    { slot: 4, label: 'Semifinal' },
    { slot: 5, label: 'Dynasty Bowl VI' },
    { slot: 6, label: 'Consolation' },
  ];
  assertEquals(sortPolls(polls).map((p) => p.slot), [5, 4, 6, 3, 2, 1]);
});

Deno.test('header: week, ET lock time, <t:F> tag; pending line only when blocked', () => {
  const h = buildHeader({ leagueShort: 'DFL', week: 11, lockAt, standingsPendingWeek: null });
  assertEquals(
    h,
    '🏈 **DFL Week 11 Pick\'ems**. Picks lock **Sunday 1:00 PM ET** (<t:1795370400:F>).',
  );
  const blocked = buildHeader({ leagueShort: 'DFL', week: 11, lockAt, standingsPendingWeek: 10 });
  assertMatch(blocked, /\nWeek 10 standings pending\.$/);
});

Deno.test('standings: §10.1 layout, competition ranks, perfect week, best week', () => {
  const s = buildStandings({
    leagueShort: 'DFL',
    throughWeek: 11,
    rows: [
      { rank: 1, displayName: 'Ryan', correct: 58, incorrect: 19, pct: 0.753, lastWeekCorrect: 6, lastWeekTotal: 7 },
      { rank: 2, displayName: 'Jacob', correct: 55, incorrect: 22, pct: 0.714, lastWeekCorrect: 5, lastWeekTotal: 7 },
      { rank: 2, displayName: 'Josh', correct: 55, incorrect: 22, pct: 0.714, lastWeekCorrect: 7, lastWeekTotal: 7 },
      { rank: 4, displayName: 'Zac', correct: 51, incorrect: 26, pct: 0.662, lastWeekCorrect: 4, lastWeekTotal: 7 },
    ],
  });
  assertMatch(s, /DFL PICK'EMS · THROUGH WEEK 11/);
  assertMatch(s, / 1 {2}Ryan {2,}58–19 {3}\.753 {3}6–1/);
  assertMatch(s, / 2 {2}Josh {2,}55–22 {3}\.714 {3}7–0 {3}← perfect week/);
  assertMatch(s, /Best week: Josh \(7–0\)/);
  assert(s.startsWith('```'), 'standings table is a code block');
  assert(s.length < 2000, 'must fit a Discord message');
});

Deno.test('standings: empty and final variants', () => {
  assertMatch(
    buildStandings({ leagueShort: 'DFL', throughWeek: 10, rows: [] }),
    /No graded picks yet/,
  );
  const final = buildStandings({
    leagueShort: 'DFL', throughWeek: 17, season: 2026, final: true,
    rows: [{ rank: 1, displayName: 'Ryan', correct: 80, incorrect: 30, pct: 0.727, lastWeekCorrect: 3, lastWeekTotal: 3 }],
  });
  assertMatch(final, /🏆 Ryan — 2026 Pick'ems Champion/);
});

Deno.test('reminder: mentions limited to exactly the missing users (§7.5)', () => {
  const r = buildReminder({
    week: 11,
    lockAt,
    missing: [
      { userId: '865238388012875797', picked: 3, total: 7 },
      { userId: '692091794237947905', picked: 0, total: 7 },
    ],
  });
  assertMatch(r.content, /Week 11 picks lock Sunday 1:00 PM ET/);
  assertMatch(r.content, /<@865238388012875797> \(3 of 7\), <@692091794237947905> \(0 of 7\)/);
  assertEquals(r.allowed_mentions, {
    parse: [],
    users: ['865238388012875797', '692091794237947905'],
  });
});

Deno.test('recap: winner line and void line', () => {
  const recap = buildRecap({
    leagueShort: 'DFL',
    week: 10,
    lines: [
      {
        label: 'Atlantic Bowl', winner: BKB, loser: WPG,
        winnerPoints: 132.52, loserPoints: 120.1, pickedWinner: 5, pickedTotal: 7,
      },
      {
        label: null, winner: null, loser: null,
        winnerPoints: 100, loserPoints: 100, pickedWinner: 0, pickedTotal: 7,
      },
    ],
  });
  assertMatch(recap, /Atlantic Bowl: 🍍 \*\*Bikini Bottom Stars\*\* def\. Winnipeg Wranglers 132\.52–120\.10 · 5 of 7 picked the winner/);
  assertMatch(recap, /Tie 100\.00–100\.00 — poll void/);
});

Deno.test('toRoman: Dynasty Bowl numbering', () => {
  assertEquals(toRoman(2026 - 2020), 'VI');
  assertEquals(toRoman(2025 - 2020), 'V');
  assertEquals(toRoman(14), 'XIV');
});
