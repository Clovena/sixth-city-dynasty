import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { computePlayoffPicture, type SeedingGame, type SeedingTeam } from "../src/lib/playoff-picture";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const YEAR = Number(process.argv[2]);
const THROUGH_WEEK = Number(process.argv[3]);

const { data: season } = await supabase
  .schema("scdfl").from("seasons").select("year, playoff_teams").eq("year", YEAR).single();
const BERTHS = season?.playoff_teams ?? 7;

const { data: franchises, error: fErr } = await supabase
  .schema("scdfl").from("franchises").select('sleeper_id, abbr, conf, "from", "to"')
  .lte("from", YEAR).or(`to.gte.${YEAR},to.is.null`);
if (fErr) throw new Error(fErr.message);
const identity = new Map<number, { abbr: string; conf: string }>(
  (franchises ?? []).map(f => [Number(f.sleeper_id), { abbr: f.abbr, conf: f.conf }]),
);

const { data: rows, error: mErr } = await supabase
  .schema("scdfl").from("matchups")
  .select("week, matchup_id, roster_id_a, roster_id_b, score_a, score_b")
  .eq("year", YEAR).eq("game_type", 0).lte("week", THROUGH_WEEK).limit(1000);
if (mErr) throw new Error(mErr.message);

const played = (rows ?? []).filter(
  m => m.matchup_id && (Number(m.score_a ?? 0) !== 0 || Number(m.score_b ?? 0) !== 0));

type Rec = { wins: number; losses: number; ties: number; pf: number };
const recs = new Map<number, Rec>();
const rec = (rid: number) => {
  let r = recs.get(rid);
  if (!r) { r = { wins: 0, losses: 0, ties: 0, pf: 0 }; recs.set(rid, r); }
  return r;
};
for (const m of played) {
  const a = Number(m.score_a ?? 0), b = Number(m.score_b ?? 0);
  const ra = rec(m.roster_id_a), rb = rec(m.roster_id_b);
  ra.pf += a; rb.pf += b;
  if (a > b) { ra.wins++; rb.losses++; } else if (b > a) { rb.wins++; ra.losses++; }
  else { ra.ties++; rb.ties++; }
}

const weeks = [...new Set(played.map(m => m.week))].sort((x, y) => x - y);
console.log(`${YEAR} through Week ${Math.max(...weeks)} — ${played.length} games, ${BERTHS} berths\n`);

const teams: SeedingTeam[] = [...recs].map(([rid, r]) => ({
  rosterId: rid, conf: identity.get(rid)!.conf, wins: r.wins,
  pointsFor: Math.round(r.pf * 100) / 100,
}));
const label = (rid: number) => {
  const r = recs.get(rid)!;
  return `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
};

for (const conf of ["SCC", "HCC"]) {
  console.log(conf);
  teams.filter(t => t.conf === conf)
    .sort((x, y) => y.wins - x.wins || y.pointsFor - x.pointsFor)
    .forEach(t => console.log(
      `  ${identity.get(t.rosterId)!.abbr.padEnd(4)} ${label(t.rosterId).padEnd(6)} ${t.pointsFor.toFixed(2).padStart(8)} PF`));
  console.log();
}

const games: SeedingGame[] = played.map(m => ({
  rosterIdA: m.roster_id_a, rosterIdB: m.roster_id_b,
  scoreA: Number(m.score_a ?? 0), scoreB: Number(m.score_b ?? 0),
}));
const picture = computePlayoffPicture(teams, games, BERTHS);

console.log(`PLAYOFF PICTURE (${BERTHS} berths)`);
for (const s of picture) {
  const t = teams.find(x => x.rosterId === s.rosterId)!;
  const id = identity.get(s.rosterId)!;
  console.log(`  ${String(s.seed).padStart(2)}. ${id.abbr.padEnd(4)} ${id.conf}  ${label(s.rosterId).padEnd(6)} ${t.pointsFor.toFixed(2).padStart(8)} PF${s.conferenceLeader ? "   <- conference leader" : ""}`);
}

const inField = new Set(picture.map(s => s.rosterId));
console.log("\nMISSING OUT");
teams.filter(t => !inField.has(t.rosterId))
  .sort((x, y) => y.wins - x.wins || y.pointsFor - x.pointsFor)
  .forEach(t => console.log(
    `      ${identity.get(t.rosterId)!.abbr.padEnd(4)} ${identity.get(t.rosterId)!.conf}  ${label(t.rosterId).padEnd(6)} ${t.pointsFor.toFixed(2).padStart(8)} PF`));
