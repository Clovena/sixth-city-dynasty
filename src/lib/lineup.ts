import { ROSTER_SLOTS, ROSTER_SLOTS_TAGTEAM, ROSTER_SLOTS_ONEVSALL } from './roster-slots';

export interface LineupEntry {
  position: string;
  colorVar: string;
  isDefensive: boolean;
  playerId: string;
  points: number;
  /** False for isDefensive slots in seasons where they don't exist (2021) */
  visible: boolean;
}

/**
 * The raw starters array order changes across eras.
 * Each array maps display-order index → raw starters[] index.
 *
 * Display order (ROSTER_SLOTS):
 *   QB RB RB WR WR WR TE FLX FLX SFLX PK DL LB DB DFLX
 *
 * Era 2021 (10 starters):
 *   QB RB RB WR WR WR TE FLX FLX SFLX
 *
 * Era 2022–2025w5 (15 starters):
 *   QB RB RB WR WR WR TE FLX FLX SFLX DFLX PK DL LB DB
 *   Display slots 10–14 (PK DL LB DB DFLX) pull from raw indices [11,12,13,14,10]
 *
 * Era 2025w6+ (15 starters):
 *   QB RB RB WR WR WR TE FLX FLX SFLX PK DL LB DB DFLX
 *   Identical to display order — identity mapping.
 */
const ERA_RAW_INDEX = {
  era2021:         [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  era2022to2025w5: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 10],
  era2025w6plus:   [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
} as const;

type Era = keyof typeof ERA_RAW_INDEX;

function getEra(year: number, week: number): Era {
  if (year <= 2021) return 'era2021';
  if (year <= 2024) return 'era2022to2025w5';
  if (year === 2025 && week <= 5) return 'era2022to2025w5';
  return 'era2025w6plus';
}

/**
 * Maps a team's raw starters/starters_points arrays into the canonical
 * ROSTER_SLOTS display order, returning one LineupEntry per slot.
 */
export function mapStartersToSlots(
  starters: string[],
  startersPoints: number[],
  year: number,
  week: number,
): LineupEntry[] {
  const era = getEra(year, week);
  const rawIndexMap = ERA_RAW_INDEX[era];

  return ROSTER_SLOTS.map((slot, displayIdx) => {
    const rawIdx = rawIndexMap[displayIdx];
    const hasData = rawIdx !== undefined && rawIdx < starters.length;
    return {
      ...slot,
      playerId: hasData ? starters[rawIdx] : '',
      points: hasData ? (startersPoints[rawIdx] ?? 0) : 0,
      visible: hasData,
    };
  });
}

/**
 * Maps exhibition starters to their display slots.
 * Starters arrive in display order for exhibitions — identity mapping.
 */
export function mapExhibitionStartersToSlots(
  starters: string[],
  startersPoints: number[],
  exhibType: 'tagteam' | 'onevsall',
): LineupEntry[] {
  const slots = exhibType === 'tagteam' ? ROSTER_SLOTS_TAGTEAM : ROSTER_SLOTS_ONEVSALL;
  return slots.map((slot, i) => ({
    ...slot,
    playerId: starters[i] ?? '',
    points: startersPoints[i] ?? 0,
    visible: i < starters.length,
  }));
}
