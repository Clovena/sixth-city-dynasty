/**
 * Superlatives race — the award catalogue and the pure helpers the page
 * renders with. No imports on purpose: `superlatives.test.ts` loads this
 * file under node:test, and nothing here may reach `./supabase`.
 *
 * The numbers themselves come from `scdfl.superlative_leaders`, written
 * nightly by `scdfl.refresh_superlative_leaders` (SUPERLATIVES.md). This file
 * only knows what the 14 awards are, how to group them, and how to say in
 * plain words what each board ranks on.
 */

export type AwardEntity = 'player' | 'franchise' | 'trade';
export type AwardGroup = 'player' | 'anti' | 'manager' | 'trade';

export type Award = {
  code: string;
  name: string;
  entity: AwardEntity;
  group: AwardGroup;
  /** The official one-line description from the ballot. */
  description: string;
  /** "How leaders are chosen", in plain language — one bullet per rule. */
  method: string[];
  /** What the `score` column measures, for the figure beside each entry. */
  scoreLabel: string;
};

/** Display order: MVP leads, then the rest of the player awards, the three
 *  ways a season goes wrong, the two franchise awards, the two trade awards. */
export const AWARDS: Award[] = [
  {
    code: 'mvp',
    scoreLabel: 'VORP',
    name: 'Most Valuable Player',
    entity: 'player',
    group: 'player',
    description: 'Veteran player who most meaningfully contributed to his fantasy team.',
    method: [
      'Veterans only, started in at least three of every four weeks, on a winning club.',
      'Ranked on points above a replacement-level starter at his position, accumulated over the games he played.',
      'Ties go to the larger share of his club\'s points, then points per game.',
    ],
  },
  {
    code: 'breakout',
    scoreLabel: 'z-score',
    name: 'Breakout Player of the Year',
    entity: 'player',
    group: 'player',
    description: 'Non-rookie player who most outperformed expectations relative to prior all-time career performance.',
    method: [
      'Veterans who were never an established starter: no prior season at or above the 14th-best player at the position.',
      'Started at least half the weeks and now scoring above replacement level, with a career average no better than two-thirds of this year\'s.',
      'Ranked on the improvement over his career average, scaled to the spread at his position.',
    ],
  },
  {
    code: 'waiver',
    scoreLabel: 'VORP since claim',
    name: 'Waiver Player of the Year',
    entity: 'player',
    group: 'player',
    description: 'Best-performing player who was acquired from waivers immediately before or during the season.',
    method: [
      'Claimed on waivers from the day after the rookie draft onward.',
      'Only starts from the week of the claim count, and he needs at least three games played since.',
      'Ranked on points above replacement since the claim.',
    ],
  },
  {
    code: 'comeback',
    scoreLabel: 'z-score',
    name: 'Comeback Player of the Year',
    entity: 'player',
    group: 'player',
    description: 'Veteran player who, after a disappointing previous season, most strongly rebounded this year.',
    method: [
      'Was an established starter before last season, then last season saw a measurable decline due to injury or poor performance.',
      'Started at least half the weeks this year and is scoring above replacement level.',
      'Ranked on the rebound from last season, scaled to the spread at his position.',
    ],
  },
  {
    code: 'geriatric',
    scoreLabel: 'z-score',
    name: 'Old Man of the Year',
    entity: 'player',
    group: 'player',
    description: 'Veteran player who most outperformed expectations relative to his age.',
    method: [
      'Players in season 9 or above, depending on position.',
      'Started at least half the weeks.',
      'Ranked on points per game relative to the other starters at his position.',
    ],
  },
  {
    code: 'roty',
    scoreLabel: 'VORP',
    name: 'Rookie of the Year',
    entity: 'player',
    group: 'player',
    description: 'Rookie player who most meaningfully contributed to his fantasy team.',
    method: [
      'Rookies with at least two starts. No start-rate or club-record threshold, since rookies often take over mid-season.',
      'Ranked on points above a replacement-level starter at his position; ties go to points per game.',
    ],
  },
  {
    code: 'vroty',
    scoreLabel: 'value',
    name: 'Value Rookie of the Year',
    entity: 'player',
    group: 'player',
    description: 'Rookie player who most outperformed expectations relative to his draft pedigree.',
    method: [
      'Rookies taken in round two or later of the SCDFL rookie draft, or never drafted at all, with at least two starts.',
      'Ranked on total started points weighted by how late he went: the later the pick, the heavier the weight.',
    ],
  },
  {
    code: 'jamielee',
    scoreLabel: 'bust index',
    name: 'Biggest Bust of the Year',
    entity: 'player',
    group: 'anti',
    description: 'Veteran player who most underperformed expectations.',
    method: [
      'Veterans drafted as a starter at their position by preseason ADP.',
      'Finish is his rank at the position by total started points, so missed time counts against him.',
      'Ranked on how far the finish fell below the ADP rank.',
    ],
  },
  {
    code: 'sweeney',
    scoreLabel: 'bust index',
    name: 'Biggest Rookie Bust of the Year',
    entity: 'player',
    group: 'anti',
    description: 'Rookie player who most underperformed expectations.',
    method: [
      'Rookies taken in the first two rounds of the SCDFL draft whose preseason ADP had them as a starter.',
      'Same measure as the veteran award: positional finish against positional ADP, among every player at the position.',
    ],
  },
  {
    code: 'injury',
    scoreLabel: 'pts lost',
    name: 'Worst Injury of the Year',
    entity: 'player',
    group: 'anti',
    description: 'Player who suffered an injury which most adversely affected his fantasy team.',
    method: [
      'He must have been on an SCDFL roster when the injury began, and be a real starter: drafted as one, or producing like one.',
      'Ranked on estimated points lost: games missed times his points per game, from his starts this season, or last season\'s average if he had too few.',
    ],
  },
  {
    code: 'moty',
    scoreLabel: 'z-score',
    name: 'Manager of the Year',
    entity: 'franchise',
    group: 'manager',
    description: 'Manager who had the most outstanding season.',
    method: [
      'Clubs at .500 or better, or currently holding a playoff spot.',
      'Ranked on a blend of win percentage, wins above the preseason line, and points per game (half weight), each measured against the rest of the league.',
    ],
  },
  {
    code: 'mif',
    scoreLabel: 'z-score',
    name: 'Most Improved Franchise',
    entity: 'franchise',
    group: 'manager',
    description: 'Franchise who showed the greatest improvement in their performance compared to previous seasons.',
    method: [
      'Clubs that missed last season\'s playoffs or lost in the first round.',
      'Ranked on the jump in win percentage and in points per game from last season, with a half-weight bonus for actually being good this year.',
    ],
  },
  {
    code: 'goodtrade',
    scoreLabel: 'weaker side',
    name: 'Most Impactful Trade',
    entity: 'trade',
    group: 'trade',
    description: 'Trade which most meaningfully impacted the teams involved as well as the league as a whole.',
    method: [
      'Every upheld trade this year.',
      'Each side is worth the points its new players have scored for it, a projection of what they will still score this season, and the value of any future picks. Only balanced trades qualify.',
    ],
  },
  {
    code: 'badtrade',
    scoreLabel: 'net gain',
    name: 'Most Lopsided Trade',
    entity: 'trade',
    group: 'trade',
    description: 'Trade which most positively impacted one team while most negatively impacting the other.',
    method: [
      'Same valuation as Most Impactful, but the unbalanced trades: one side received less than half of what the other did, and the bigger side cleared 100 points.',
      'Ranked on the winner\'s net gain, what it received minus what it gave up. A trade can be on this board or the other, never both.',
    ],
  },
];

export const AWARD_BY_CODE: Record<string, Award> = Object.fromEntries(AWARDS.map(a => [a.code, a]));

/** Section headings for the page, in display order. */
export const AWARD_GROUPS: { group: AwardGroup; title: string; standfirst: string }[] = [
  { group: 'player', title: 'Player Awards', standfirst: 'The seven honors a player can earn.' },
  { group: 'anti', title: 'Hard Luck', standfirst: 'The ways a season goes wrong.' },
  { group: 'manager', title: 'Franchise Awards', standfirst: 'For the managers behind the roster.' },
  { group: 'trade', title: 'Trade Awards', standfirst: 'Valued by pure fantasy output, or projections.' },
];

/** One row of `scdfl.superlative_leaders` (§5 of the spec). */
export type LeaderRow = {
  season: number;
  as_of_week: number;
  award_code: string;
  rank: number;
  player_id: string | null;
  sleeper_id: string | null;
  transaction_id: string | null;
  franchise_abbr: string | null;
  score: number | string | null;
  headline: string | null;
  detail_lines: string[];
  flags: string[];
  payload: Record<string, unknown>;
  generated_at: string;
};

/** One asset a side received in a trade, as the SQL writes it into `payload.sides[].received`. */
export type TradeAsset = {
  label: string;
  kind: 'player' | 'drafted' | 'flipped' | 'capital';
  player_id: string | null;
  realized: number;
  ros: number;
  capital: number;
};

export type TradeSide = {
  roster_id: number;
  abbr: string;
  active_abbr: string;
  name: string;
  realized: number;
  ros: number;
  capital: number;
  value: number;
  given: number;
  net: number;
  received: TradeAsset[];
};

/** Group rows by award, each list ordered by rank. Awards with no rows are absent. */
export function groupByAward(rows: LeaderRow[]): Map<string, LeaderRow[]> {
  const byCode = new Map<string, LeaderRow[]>();
  for (const row of rows) {
    const list = byCode.get(row.award_code) ?? [];
    list.push(row);
    byCode.set(row.award_code, list);
  }
  for (const list of byCode.values()) list.sort((a, b) => a.rank - b.rank);
  return byCode;
}

/** The sides of a trade row, winner first, or an empty list when the payload is malformed. */
export function tradeSides(row: LeaderRow): TradeSide[] {
  const sides = row.payload?.sides;
  return Array.isArray(sides) ? (sides as TradeSide[]) : [];
}

const FLAG_LABEL: Record<string, string> = {
  near_threshold: 'One year short',
  injury_driven: 'Injury',
  ongoing: 'Still out',
  override: 'Reviewed',
  undrafted: 'Undrafted',
  no_starts: 'Never started',
  outside_field: 'Outside the field',
  quick_drop: 'Dropped within a day',
  below_500: 'Under .500',
};

/** Short stamp text for a flag; unknown flags are shown as they are stored. */
export function flagLabel(flag: string): string {
  return FLAG_LABEL[flag] ?? flag.replace(/_/g, ' ');
}

/** "TOR/PEI" (a player shown under two clubs) → ["TOR", "PEI"]; trades use " / ". */
export function splitAbbrs(abbr: string | null | undefined): string[] {
  if (!abbr) return [];
  return abbr.split('/').map(s => s.trim()).filter(Boolean);
}

/** The "through Week N" line, or the frozen-ballot line once the regular season is done. */
export function asOfLine(asOfWeek: number, frozen: boolean): string {
  if (frozen) return 'Final: the ballot nominees';
  return asOfWeek >= 14 ? 'Through the regular season' : `Through Week ${asOfWeek}`;
}
