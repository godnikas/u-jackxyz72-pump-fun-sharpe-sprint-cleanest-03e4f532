// Evaluate strategy.ts on the kit's dev window with an hourly-Sharpe proxy.
//
//   node tools/eval.ts <kit dir> ['{...params}']
//
// Runs the local engine port over several failed-tx draws and prints the mean hourly
// Sharpe (mark-to-market equity sampled at hour boundaries), mean net PnL, the worst
// draw, fills, coins, win rate, drawdown and top-coin concentration — the numbers that
// matter for a ranking by hourly Sharpe, not just raw PnL.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/eval.ts <kit dir> [params json]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };

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

const FAIL_KEYS = [11n, 22n, 33n, 44n];
let sumSharpe = 0;
let sumNet = 0;
let worstNet = Infinity;
let worstSharpe = Infinity;
let fills = Infinity;
let coins = Infinity;
let dd = 0;
let trips = 0;
let wins = 0;
let topShare = 0;
for (const failKey of FAIL_KEYS) {
  const r = simulate(ds, hello, createStrategy(params), { failKey });
  const s = sharpe(r.equityHourly);
  const net = Number(r.netPnl) / 1e9;
  sumSharpe += s;
  sumNet += net;
  worstNet = Math.min(worstNet, net);
  worstSharpe = Math.min(worstSharpe, s);
  fills = Math.min(fills, r.fills);
  coins = Math.min(coins, r.mints);
  dd = Math.max(dd, r.maxDrawdown);
  trips = r.trips.length;
  wins = r.trips.filter((t) => t.pnl > 0n).length;
  const gains = [...r.perMint.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : 1));
  const tot = gains.reduce((a, b) => a + b, 0n);
  topShare = Math.max(topShare, tot > 0n ? Number(gains.slice(0, 3).reduce((a, b) => a + b, 0n)) / Number(tot) : 0);
}
console.log(
  `sharpe ${String((sumSharpe / FAIL_KEYS.length).toFixed(3))} (worst ${worstSharpe.toFixed(3)})  net ${(sumNet / FAIL_KEYS.length).toFixed(3)} SOL (worst ${worstNet.toFixed(3)})  fills ${fills}  coins ${coins}  trips ${trips}  wins ${wins}  dd ${dd.toFixed(3)}  top3share ${topShare.toFixed(2)}  ${JSON.stringify(overrides)}`,
);
