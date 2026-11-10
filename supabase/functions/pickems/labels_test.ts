import { assertEquals } from 'jsr:@std/assert@1';
import {
  type BracketGame,
  playoffPairingsForWeek,
  spotlightLabel,
  type SpotlightGame,
} from './labels.ts';

// ── Spotlight tags (2026 fixtures from scdfl, verified live Nov 9 2026) ─────

const spotlights: SpotlightGame[] = [
  { name: 'Atlantic Bowl', type: 'bowl-game', team_a: 'NFD', team_b: 'PEI' },
  { name: 'Atom Bowl', type: 'bowl-game', team_a: 'BKB', team_b: 'WPG' },
  { name: 'Stars vs Lasercats', type: 'rivalry', team_a: 'BKB', team_b: 'LOW' },
  { name: 'Railfans vs Hogs', type: 'rivalry', team_a: 'CHC', team_b: 'TOR' },
];

Deno.test('week 10: Atlantic Bowl tags NFD–PEI in either order', () => {
  assertEquals(spotlightLabel(spotlights, 10, 14, 'NFD', 'PEI'), 'Atlantic Bowl');
  assertEquals(spotlightLabel(spotlights, 10, 14, 'PEI', 'NFD'), 'Atlantic Bowl');
  assertEquals(spotlightLabel(spotlights, 10, 14, 'TOR', 'MIS'), null);
});

Deno.test('week 11: Atom Bowl tags BKB–WPG', () => {
  assertEquals(spotlightLabel(spotlights, 11, 14, 'BKB', 'WPG'), 'Atom Bowl');
});

Deno.test('rivalries fire only in week 14, with the Rivalry Week prefix', () => {
  assertEquals(
    spotlightLabel(spotlights, 14, 14, 'BKB', 'LOW'),
    'Rivalry Week · Stars vs Lasercats',
  );
  assertEquals(
    spotlightLabel(spotlights, 14, 14, 'TOR', 'CHC'),
    'Rivalry Week · Railfans vs Hogs',
  );
  // same pair outside week 14: no rivalry tag
  assertEquals(spotlightLabel(spotlights, 9, 14, 'BKB', 'LOW'), null);
});

// ── Playoff labels, against the real 2025 bracket fixture (§18.5) ───────────

const winners: BracketGame[] = JSON.parse(
  Deno.readTextFileSync(new URL('./fixtures/winners-bracket-2025.json', import.meta.url)),
);
const losers: BracketGame[] = JSON.parse(
  Deno.readTextFileSync(new URL('./fixtures/losers-bracket-2025.json', import.meta.url)),
);

const labelsFor = (week: number, includeConsolation = true) =>
  playoffPairingsForWeek(winners, losers, 15, week, includeConsolation, 2025)
    .map((p) => p.label);

Deno.test('2025 week 15 (round 1): three quarterfinals + three consolations', () => {
  assertEquals(labelsFor(15), [
    'Quarterfinal', 'Quarterfinal', 'Quarterfinal',
    'Consolation', 'Consolation', 'Consolation',
  ]);
});

Deno.test('2025 week 16 (round 2): loser-fed game is NOT a semifinal (§18.5)', () => {
  assertEquals(labelsFor(16), [
    'Semifinal', 'Semifinal', '5th-Place Semifinal',
    'Consolation', 'Consolation', 'Consolation',
  ]);
});

Deno.test('2025 week 17 (round 3): placement games, Dynasty Bowl V', () => {
  assertEquals(labelsFor(17), [
    'Dynasty Bowl V', 'Third-Place Game', '5th-Place Game',
    'Consolation Final', 'Consolation 3rd Place', 'Consolation 5th Place',
  ]);
});

Deno.test('include_consolation=false drops the losers bracket', () => {
  assertEquals(labelsFor(17, false), [
    'Dynasty Bowl V', 'Third-Place Game', '5th-Place Game',
  ]);
});

Deno.test('round→week mapping and both-teams-known filter', () => {
  // Before the bracket advances, round-2 games have null t1/t2 and must be
  // excluded (§18.6 handles the resulting empty list at POST time).
  const pending = winners.map((g) => g.r === 2 ? { ...g, t1: null } : g);
  const pairings = playoffPairingsForWeek(pending, [], 15, 16, false, 2025);
  assertEquals(pairings.length, 0);
  // Roster IDs come through as-is for a ready game.
  const wk15 = playoffPairingsForWeek(winners, losers, 15, 15, false, 2025);
  assertEquals(wk15[0].rosterIdA, 2);
  assertEquals(wk15[0].rosterIdB, 10);
});
