// Run: npx tsx --test src/lib/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clinchStatus, type SeedingTeam } from './playoff-picture';

/** 14 teams, 7 per conference; roster ids 1–7 in A, 8–14 in B. */
function league(wins: number[]): SeedingTeam[] {
  return wins.map((w, i) => ({ rosterId: i + 1, conf: i < 7 ? 'A' : 'B', wins: w, pointsFor: 0 }));
}
const remainingAll = (n: number) => new Map(Array.from({ length: 14 }, (_, i) => [i + 1, n]));

test('nothing is settled with plenty of season left', () => {
  const marks = clinchStatus(league([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), remainingAll(5), 7);
  assert.ok([...marks.values()].every(m => m === null));
});

test('a conference is clinched only when no rival can reach the leader', () => {
  const wins = [10, 7, 6, 6, 5, 5, 4, 9, 8, 6, 6, 5, 5, 4];
  assert.equal(clinchStatus(league(wins), remainingAll(2), 7).get(1), 'conference');
  // With three left, the 7-win rival can reach 10 — a tie, which never counts as clinched.
  assert.notEqual(clinchStatus(league(wins), remainingAll(3), 7).get(1), 'conference');
});

test('a berth is clinched once at most playoffTeams − 2 others can reach it', () => {
  // Team 8 (B, 11 wins) is behind team 9 (B, 12). With one game left, others
  // who can reach 11: teams 1, 2, 9 → 3 ≤ 5.
  const wins = [12, 10, 7, 6, 5, 4, 3, 11, 12, 7, 6, 5, 4, 3];
  assert.equal(clinchStatus(league(wins), remainingAll(1), 7).get(8), 'berth');
});

test('elimination needs both a conference rival and a full field out of reach', () => {
  const wins = [10, 10, 10, 10, 10, 10, 10, 10, 2, 2, 2, 2, 2, 2];
  const marks = clinchStatus(league(wins), remainingAll(1), 7);
  // Team 9 tops out at 3: rival team 8 is out of reach, and so are eight teams overall.
  assert.equal(marks.get(9), 'eliminated');
  // Nobody in A is eliminated: they all have 10.
  assert.ok([1, 2, 3, 4, 5, 6, 7].every(id => marks.get(id) !== 'eliminated'));
});

test('a team that can still win its conference is never eliminated', () => {
  // Conference B is all 2-win teams; A is full of 10s. Team 9 can still lead B.
  const wins = [10, 10, 10, 10, 10, 10, 10, 2, 2, 2, 2, 2, 2, 2];
  const marks = clinchStatus(league(wins), remainingAll(1), 7);
  assert.ok([8, 9, 10, 11, 12, 13, 14].every(id => marks.get(id) !== 'eliminated'));
});

test('unpicked games are the only source of headroom', () => {
  const wins = [9, 8, 8, 8, 8, 8, 8, 3, 3, 3, 3, 3, 3, 3];
  const remaining = new Map([...remainingAll(0)]);
  // Season over: team 1 outright leads conference A.
  assert.equal(clinchStatus(league(wins), remaining, 7).get(1), 'conference');
});
