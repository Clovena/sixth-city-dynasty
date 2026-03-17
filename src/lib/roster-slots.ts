export interface RosterSlot {
  position: string;
  /** Matches the CSS variable suffix: --color-{colorVar}, --color-{colorVar}-surface, --color-{colorVar}-glow */
  colorVar: string;
  /** True for DL, LB, DB, DFLX — absent in 2021 season; hide these slots when not applicable */
  isDefensive: boolean;
}

/**
 * Canonical starter order across all seasons.
 * The final four slots (isDefensive: true) do not exist in the 2021 season
 * and should be hidden when rendering that year's data.
 */
export const ROSTER_SLOTS: RosterSlot[] = [
  { position: 'QB',   colorVar: 'red',    isDefensive: false },
  { position: 'RB',   colorVar: 'green',  isDefensive: false },
  { position: 'RB',   colorVar: 'green',  isDefensive: false },
  { position: 'WR',   colorVar: 'scc',    isDefensive: false },
  { position: 'WR',   colorVar: 'scc',    isDefensive: false },
  { position: 'WR',   colorVar: 'scc',    isDefensive: false },
  { position: 'TE',   colorVar: 'gold',   isDefensive: false },
  { position: 'FLX',  colorVar: 'white',  isDefensive: false },
  { position: 'FLX',  colorVar: 'white',  isDefensive: false },
  { position: 'SFLX', colorVar: 'white',  isDefensive: false },
  { position: 'PK',   colorVar: 'grey',   isDefensive: false },
  { position: 'DL',   colorVar: 'hcc',    isDefensive: true  },
  { position: 'LB',   colorVar: 'purple', isDefensive: true  },
  { position: 'DB',   colorVar: 'pink',   isDefensive: true  },
  { position: 'DFLX', colorVar: 'white',  isDefensive: true  },
];
