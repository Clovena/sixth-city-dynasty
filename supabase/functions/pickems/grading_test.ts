import { assertEquals } from 'jsr:@std/assert@1';
import { gradeMatchup, missingPickers } from './grading.ts';

Deno.test('grading: clear win', () => {
  assertEquals(
    gradeMatchup('2', '5', { '2': 132.52, '5': 120.1 }),
    { status: 'won', winnerKey: '2' },
  );
  assertEquals(
    gradeMatchup('2', '5', { '2': 99.9, '5': 120.1 }),
    { status: 'won', winnerKey: '5' },
  );
});

Deno.test('grading: exact tie is void', () => {
  assertEquals(gradeMatchup('2', '5', { '2': 100, '5': 100 }), { status: 'void' });
});

Deno.test('grading: 0–0 means not final, never a tie (§5.4 finality guard)', () => {
  assertEquals(gradeMatchup('2', '5', { '2': 0, '5': 0 }), { status: 'not_final' });
});

Deno.test('grading: missing team data means not final', () => {
  assertEquals(gradeMatchup('2', '5', { '2': 101.2 }), { status: 'not_final' });
  assertEquals(gradeMatchup('2', '5', {}), { status: 'not_final' });
});

Deno.test('reminders: full, partial, zero and opted-out pickers (§12)', () => {
  const eligible = [
    { userId: 'a', remind: true }, // all 7 picked → not reminded
    { userId: 'b', remind: true }, // 3 of 7 → reminded
    { userId: 'c', remind: true }, // 0 of 7 → reminded
    { userId: 'd', remind: false }, // opted out → never reminded
  ];
  const picks = new Map([['a', 7], ['b', 3], ['d', 0]]);
  assertEquals(missingPickers(eligible, 7, picks), [
    { userId: 'b', picked: 3, total: 7 },
    { userId: 'c', picked: 0, total: 7 },
  ]);
});

Deno.test('reminders: nobody missing → empty list (post nothing, §10.3)', () => {
  const eligible = [{ userId: 'a', remind: true }];
  assertEquals(missingPickers(eligible, 7, new Map([['a', 7]])), []);
});
