// Run: npx tsx --test src/lib/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBracket, type BracketTeam, type BracketGame } from './playoff-bracket';

const slug = (a: string, b: string, w: number) => `${w}-${[a, b].map(s => s.toLowerCase()).sort().join('-')}`;

const seven: BracketTeam[] = [1, 2, 3, 4, 5, 6, 7].map(seed => ({
  rosterId: seed * 10, seed, conf: seed % 2 ? 'SCC' : 'HCC', abbr: `T${seed}`,
}));

test('a projected seven-team bracket seats seeds and advances only the bye', () => {
  const b = buildBracket({ year: 2026, teams: seven, games: [], shape: 'overall7', projected: true, slug });
  assert.equal(b.leftTop.top?.seed, 1);
  assert.equal(b.leftTop.bye, true);
  assert.deepEqual([b.leftBottom.top?.seed, b.leftBottom.bottom?.seed], [4, 5]);
  assert.deepEqual([b.rightTop.top?.seed, b.rightTop.bottom?.seed], [2, 7]);
  assert.deepEqual([b.rightBottom.top?.seed, b.rightBottom.bottom?.seed], [3, 6]);
  assert.equal(b.leftSemi.top?.seed, 1);
  assert.equal(b.leftSemi.bottom, null);
  assert.equal(b.rightSemi.top, null);
  assert.equal(b.champion, null);
  // No games exist, so nothing links.
  assert.ok([b.leftBottom, b.rightTop, b.rightBottom, b.leftSemi].every(m => m.href === null));
  assert.equal(b.finalHref, null);
});

test('played games advance winners, link, and name the champion', () => {
  const g = (week: number, a: number, b: number, sa: number, sb: number): BracketGame =>
    ({ week, rosterIdA: a * 10, rosterIdB: b * 10, scoreA: sa, scoreB: sb });
  const games = [
    g(15, 4, 5, 90, 100), g(15, 2, 7, 120, 80), g(15, 6, 3, 110, 100),
    g(16, 1, 5, 130, 90), g(16, 2, 6, 95, 99),
    g(17, 6, 1, 101, 100),
  ];
  const b = buildBracket({ year: 2025, teams: seven, games, shape: 'overall7', projected: false, slug });
  assert.equal(b.leftSemi.bottom?.seed, 5);
  assert.deepEqual([b.rightSemi.top?.seed, b.rightSemi.bottom?.seed], [2, 6]);
  assert.equal(b.leftBottom.href, '/games/2025/15-t4-t5');
  assert.equal(b.leftSemi.href, '/games/2025/16-t1-t5');
  assert.equal(b.champion?.seed, 6);
  assert.equal(b.runnerUp?.seed, 1);
  assert.equal(b.finalHref, '/games/2025/17-t1-t6');
});

test('an unplayed 0–0 placeholder neither advances anyone nor crowns a champion', () => {
  const games: BracketGame[] = [
    { week: 15, rosterIdA: 40, rosterIdB: 50, scoreA: 0, scoreB: 0 },
    { week: 17, rosterIdA: 10, rosterIdB: 20, scoreA: 0, scoreB: 0 },
  ];
  const b = buildBracket({ year: 2027, teams: seven, games, shape: 'overall7', projected: false, slug });
  assert.equal(b.leftSemi.bottom, null);
  assert.equal(b.champion, null);
  // The game exists, so it links even before it is played.
  assert.equal(b.leftBottom.href, '/games/2027/15-t4-t5');
});

test('the conference shape plays 1v4 and 2v3 per side, SCC on the left', () => {
  const teams: BracketTeam[] = ['SCC', 'HCC'].flatMap((conf, c) =>
    [1, 2, 3, 4].map(seed => ({ rosterId: c * 100 + seed, seed, conf, abbr: `${conf}${seed}` })));
  const b = buildBracket({ year: 2021, teams, games: [], shape: 'conference8', projected: false, slug });
  assert.deepEqual([b.leftTop.top?.abbr, b.leftTop.bottom?.abbr], ['SCC1', 'SCC4']);
  assert.deepEqual([b.leftBottom.top?.abbr, b.leftBottom.bottom?.abbr], ['SCC2', 'SCC3']);
  assert.deepEqual([b.rightTop.top?.abbr, b.rightBottom.bottom?.abbr], ['HCC1', 'HCC3']);
  assert.equal(b.leftTop.bye, false);
});
