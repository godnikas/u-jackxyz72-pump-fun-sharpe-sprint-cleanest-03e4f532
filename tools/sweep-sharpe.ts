// Grid sweep ranked by hourly-Sharpe proxy (tools/eval.ts logic), not raw PnL.
//
//   node tools/sweep-sharpe.ts <kit dir> '<base params json>' '<grid json>' [top N]
//
// Each combo is scored on 2 failed-tx draws for speed; confirm the winners with
// tools/eval.ts (4 draws) and the kit's grade-local before keeping them.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const [kit, baseJson, gridJson, topArg] = process.argv.slice(2);
if (kit === undefined || gridJson === undefined) {
  console.error("usage: node tools/sweep-sharpe.ts <kit dir> '<base json>' '<grid json>' [top]");
  process.exit(2);
}
const base = { ...DEFAULT_PARAMS, ...(JSON.parse(baseJson ?? '{}') as Partial<Params>) };
const grid = JSON.parse(gridJson) as Record<string, unknown[]>;
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const keys = Object.keys(grid);
const combos: Record<string, unknown>[] = [{}];
for (const k of keys) {
  const next: Record<string, unknown>[] = [];
  for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
  combos.splice(0, combos.length, ...next);
}

function sharpe(equityHourly: { hour: number; equity: bigint }[]): number {
  const rets: number[] = [];
  for (let i = 1; i < equityHourly.length; i++) {
    const a = Number(equityHourly[i - 1]!.equity);
    const b = Number(equityHourly[i]!.equity);
    if (a > 0) rets.push(b / a - 1);
  }
  if (rets.length < 3) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  return sd === 0 ? 0 : mean / sd;
}

const FAIL_KEYS = [11n, 33n];
const rows: { c: Record<string, unknown>; sharpe: number; net: number; worst: number; fills: number; coins: number; trips: number; wins: number; dd: number }[] = [];
for (const c of combos) {
  let sumS = 0;
  let sumN = 0;
  let worst = Infinity;
  let fills = Infinity;
  let coins = Infinity;
  let dd = 0;
  let trips = 0;
  let wins = 0;
  for (const failKey of FAIL_KEYS) {
    const r = simulate(ds, hello, createStrategy({ ...base, ...c } as Params), { failKey });
    sumS += sharpe(r.equityHourly);
    const net = Number(r.netPnl) / 1e9;
    sumN += net;
    worst = Math.min(worst, net);
    fills = Math.min(fills, r.fills);
    coins = Math.min(coins, r.mints);
    dd = Math.max(dd, r.maxDrawdown);
    trips = r.trips.length;
    wins = r.trips.filter((t) => t.pnl > 0n).length;
  }
  rows.push({ c, sharpe: sumS / FAIL_KEYS.length, net: sumN / FAIL_KEYS.length, worst, fills, coins, trips, wins, dd });
}
rows.sort((a, b) => b.sharpe - a.sharpe || b.net - a.net);
for (const r of rows.slice(0, Number(topArg ?? 25))) {
  console.log(
    `sharpe ${r.sharpe.toFixed(3)} net ${r.net.toFixed(3)} worst ${r.worst.toFixed(3)} fills ${r.fills} coins ${r.coins} trips ${r.trips} wins ${r.wins} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.c)}`,
  );
}
