import { supabase } from './supabase';
import { identityFor, type FranchiseRow, type SideIdentity } from './franchise-identity';
import { formatTimestamp, ordinal, playerName } from './format';

/**
 * Transaction-log layer for `/players/[id]`.
 *
 * `scdfl.transactions` stores one row per asset movement per team side, so a
 * player's career shows up as a scatter of add/drop rows that have to be
 * regrouped before they read as a history. The regrouping rule, verified
 * against all 5,993 rows in the table:
 *
 * - **Two rows** (one `add`, one `drop`) sharing a `transaction_id` for the
 *   same player = the player changed hands. Always true for `trade`, and true
 *   for the subset of `commissioner` rows that undo or force a swap.
 * - **One row** = a one-sided move. An `add` is an acquisition off waivers /
 *   free agency; a `drop` is a release back to the pool.
 *
 * A `waiver` row's *sibling* rows in the same transaction are a different
 * player (the corresponding roster cut), which is why events are grouped by
 * `(transaction_id, player_id)` and never by `transaction_id` alone.
 *
 * `status` is `'failed'` for losing waiver bids. Those are not history — the
 * player never moved — so they are kept out of the event list and surfaced
 * instead as `contestedBids` on the claim that beat them.
 */

export type TxType = 'trade' | 'waiver' | 'free_agent' | 'commissioner';

/** What happened to the player, derived from the add/drop rows — not a stored column. */
export type TxKind =
  /** Picked up off waivers or free agency. */
  | 'acquired'
  /** Cut back to the free agent pool. */
  | 'released'
  /** Changed hands directly between two franchises. */
  | 'moved';

export type TradeAsset =
  | { kind: 'player'; playerId: string; name: string; position: string | null; isSubject: boolean }
  | { kind: 'pick'; label: string };

/** One franchise's haul in a trade — mirrors the trade cards on `/hall-of-fame/superlatives`. */
export type TradeSide = { team: SideIdentity | null; received: TradeAsset[] };

/** A losing waiver bid on the same player in the same week as a successful claim. */
export type ContestedBid = { team: SideIdentity | null; bid: number | null };

export type PlayerTxEvent = {
  transactionId: string;
  year: number;
  week: number;
  type: TxType;
  kind: TxKind;
  /** Franchise that gave the player up — null for a waiver/FA pickup. */
  from: SideIdentity | null;
  /** Franchise that took the player on — null for a release. */
  to: SideIdentity | null;
  /** FAAB spend, waiver claims only. */
  waiverBid: number | null;
  created: number;
  date: string;
  /**
   * Everything else in the deal, one entry per participating franchise.
   * Populated for `moved` events only; three-team trades yield three sides.
   */
  sides: TradeSide[];
  /** Losing bids on this player the same week — waiver acquisitions only. */
  contestedBids: ContestedBid[];
};

type TxRow = {
  transaction_id: string;
  year: number;
  week: number;
  type: string;
  status: string;
  roster_id: number;
  action: string;
  asset: string;
  player_id: string | null;
  pick_season: number | null;
  pick_round: number | null;
  pick_original_roster_id: number | null;
  waiver_bid: number | null;
  created: number;
};

const TX_COLUMNS =
  'transaction_id, year, week, type, status, roster_id, action, asset, player_id, pick_season, pick_round, pick_original_roster_id, waiver_bid, created';

/**
 * Every transaction row touching one player, failed bids included.
 *
 * Issue this inside the page's existing `Promise.all` — it depends on nothing
 * but the player id, and `/players/[id]` renders per request, so a serial
 * await here is latency on every pageview.
 */
export async function fetchPlayerTransactionRows(playerId: string) {
  return supabase
    .schema('scdfl')
    .from('transactions')
    .select(TX_COLUMNS)
    .eq('player_id', playerId)
    .eq('asset', 'player')
    .order('created', { ascending: false })
    .limit(200);
}

/**
 * Regroups raw rows into a newest-first career log.
 *
 * Costs up to two further round trips, and only for players who have actually
 * been traded: one for the other assets in those trades, one for the names of
 * the players among them.
 */
export async function buildPlayerTransactionLog(
  rows: TxRow[] | null,
  playerId: string,
  franchises: FranchiseRow[],
): Promise<PlayerTxEvent[]> {
  const complete = (rows ?? []).filter(r => r.status === 'complete');
  if (complete.length === 0) return [];

  // ── Group by transaction: one row is one-sided, two rows is a handover ────
  const byTransaction = new Map<string, TxRow[]>();
  for (const row of complete) {
    const group = byTransaction.get(row.transaction_id);
    if (group) group.push(row);
    else byTransaction.set(row.transaction_id, [row]);
  }

  const events: PlayerTxEvent[] = [];
  for (const group of byTransaction.values()) {
    const addRow = group.find(r => r.action === 'add') ?? null;
    const dropRow = group.find(r => r.action === 'drop') ?? null;
    const anchor = addRow ?? dropRow;
    if (!anchor) continue;

    const kind: TxKind = addRow && dropRow ? 'moved' : addRow ? 'acquired' : 'released';

    events.push({
      transactionId: anchor.transaction_id,
      year: anchor.year,
      week: anchor.week,
      type: anchor.type as TxType,
      kind,
      from: dropRow ? identityFor(franchises, dropRow.roster_id, dropRow.year) : null,
      to: addRow ? identityFor(franchises, addRow.roster_id, addRow.year) : null,
      waiverBid: addRow?.waiver_bid ?? null,
      created: Number(anchor.created),
      date: formatTimestamp(anchor.created),
      sides: [],
      contestedBids: [],
    });
  }

  // Chronological — a career reads forward, oldest move first.
  events.sort((a, b) => a.created - b.created);

  attachContestedBids(events, rows ?? [], franchises);
  await attachTradeSides(events, playerId, franchises);

  return events;
}

/**
 * Losing waiver bids are separate transactions, so they can only be tied to the
 * winning claim by coincidence of player and week — which is exactly what they
 * are. Matched on `(year, week)` against `failed` add rows for the same player.
 */
function attachContestedBids(
  events: PlayerTxEvent[],
  rows: TxRow[],
  franchises: FranchiseRow[],
): void {
  const failedBids = rows.filter(
    r => r.status === 'failed' && r.action === 'add' && r.type === 'waiver',
  );
  if (failedBids.length === 0) return;

  for (const event of events) {
    if (event.kind !== 'acquired' || event.type !== 'waiver') continue;
    event.contestedBids = failedBids
      .filter(r => r.year === event.year && r.week === event.week)
      .map(r => ({ team: identityFor(franchises, r.roster_id, r.year), bid: r.waiver_bid }))
      .sort((a, b) => (b.bid ?? 0) - (a.bid ?? 0));
  }
}

/** Fills in the rest of each trade package: who received what, per franchise. */
async function attachTradeSides(
  events: PlayerTxEvent[],
  playerId: string,
  franchises: FranchiseRow[],
): Promise<void> {
  const tradeIds = events.filter(e => e.kind === 'moved').map(e => e.transactionId);
  if (tradeIds.length === 0) return;

  const { data: legRows } = await supabase
    .schema('scdfl')
    .from('transactions')
    .select(TX_COLUMNS)
    .in('transaction_id', tradeIds)
    .eq('status', 'complete')
    .limit(500);

  const legs = (legRows ?? []) as TxRow[];
  if (legs.length === 0) return;

  // One name lookup covers every player across every trade — the subject
  // included, since he is one of the assets in his own trade package.
  const tradedPlayerIds = [
    ...new Set(
      legs.filter(l => l.asset === 'player' && l.player_id).map(l => l.player_id as string),
    ),
  ];

  const { data: nameRows } = tradedPlayerIds.length
    ? await supabase
        .schema('scdfl')
        .from('v_players')
        .select('player_id, first_name, last_name, position')
        .in('player_id', tradedPlayerIds)
    : { data: [] };

  const namesById = new Map(
    (nameRows ?? []).map(p => [
      p.player_id as string,
      { name: playerName(p.first_name, p.last_name, p.player_id as string), position: p.position as string | null },
    ]),
  );

  function toAsset(leg: TxRow, year: number): TradeAsset {
    if (leg.asset === 'pick') {
      const original =
        leg.pick_original_roster_id === null
          ? null
          : identityFor(franchises, leg.pick_original_roster_id, leg.pick_season ?? year);
      const via = original ? ` (${original.abbr})` : '';
      return { kind: 'pick', label: `${leg.pick_season} ${ordinal(leg.pick_round ?? 0)}${via}` };
    }
    const id = leg.player_id as string;
    const known = namesById.get(id);
    return {
      kind: 'player',
      playerId: id,
      name: known?.name ?? id,
      position: known?.position ?? null,
      isSubject: id === playerId,
    };
  }

  for (const event of events) {
    if (event.kind !== 'moved') continue;

    const eventLegs = legs.filter(l => l.transaction_id === event.transactionId);
    const rosterIds = [...new Set(eventLegs.map(l => l.roster_id))].sort((a, b) => a - b);

    event.sides = rosterIds.map(rosterId => ({
      team: identityFor(franchises, rosterId, event.year),
      received: eventLegs
        .filter(l => l.roster_id === rosterId && l.action === 'add')
        .map(l => toAsset(l, event.year)),
    }));
  }
}

/** The acquisition that put an undrafted player in the league — the oldest completed pickup. */
export function firstAcquisition(events: PlayerTxEvent[]): PlayerTxEvent | null {
  return (
    events.find(
      e => e.kind === 'acquired' && (e.type === 'waiver' || e.type === 'free_agent'),
    ) ?? null
  );
}
