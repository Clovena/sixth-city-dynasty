// Run: npx tsx --test src/lib/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AWARDS,
  AWARD_BY_CODE,
  AWARD_GROUPS,
  asOfLine,
  flagLabel,
  groupByAward,
  splitAbbrs,
  tradeSides,
  type LeaderRow,
} from './superlatives-awards';

function row(partial: Partial<LeaderRow>): LeaderRow {
  return {
    season: 2026,
    as_of_week: 9,
    award_code: 'mvp',
    rank: 1,
    player_id: null,
    sleeper_id: null,
    transaction_id: null,
    franchise_abbr: null,
    score: null,
    headline: null,
    detail_lines: [],
    flags: [],
    payload: {},
    generated_at: '2026-11-16T05:00:00Z',
    ...partial,
  };
}

test('the catalogue is the fourteen ballot awards, each in exactly one section', () => {
  assert.equal(AWARDS.length, 14);
  assert.equal(new Set(AWARDS.map(a => a.code)).size, 14);
  const sections = new Set(AWARD_GROUPS.map(g => g.group));
  for (const a of AWARDS) assert.ok(sections.has(a.group), `${a.code} has a section`);
  assert.equal(AWARD_BY_CODE.mvp.entity, 'player');
  assert.equal(AWARD_BY_CODE.moty.entity, 'franchise');
  assert.equal(AWARD_BY_CODE.badtrade.entity, 'trade');
});

test('rows group by award and come back in rank order', () => {
  const grouped = groupByAward([
    row({ award_code: 'roty', rank: 2 }),
    row({ award_code: 'mvp', rank: 1 }),
    row({ award_code: 'roty', rank: 1 }),
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ['mvp', 'roty']);
  assert.deepEqual(grouped.get('roty')!.map(r => r.rank), [1, 2]);
  assert.equal(grouped.has('waiver'), false);
});

test('trade sides come from the payload and survive a malformed one', () => {
  const sides = [{ roster_id: 1, abbr: 'TOR', value: 10 }];
  assert.equal(tradeSides(row({ payload: { sides } })).length, 1);
  assert.deepEqual(tradeSides(row({ payload: {} })), []);
  assert.deepEqual(tradeSides(row({ payload: { sides: 'nope' } })), []);
});

test('abbreviations split on the slash the SQL uses for shared credit', () => {
  assert.deepEqual(splitAbbrs('TOR/PEI'), ['TOR', 'PEI']);
  assert.deepEqual(splitAbbrs('TBY / TOR'), ['TBY', 'TOR']);
  assert.deepEqual(splitAbbrs(null), []);
});

test('flags read as stamps, unknown ones fall back to their own words', () => {
  assert.equal(flagLabel('injury_driven'), 'Injury');
  assert.equal(flagLabel('some_new_flag'), 'some new flag');
});

test('the dateline says where the season is', () => {
  assert.equal(asOfLine(9, false), 'Through Week 9');
  assert.equal(asOfLine(14, false), 'Through the regular season');
  assert.equal(asOfLine(14, true), 'Final: the ballot nominees');
});
