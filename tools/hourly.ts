// Print hourly equity + returns for a params set (local full-dev sim, fail key 11).
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const r = simulate(ds, hello, createStrategy({ ...DEFAULT_PARAMS, ...overrides }), { failKey: 11n });
const marks = r.equityHourly;
console.log('hours:', marks.length);
for (let i = 1; i < marks.length; i++) {
  const a = Number(marks[i - 1]!.equity) / 1e9;
  const b = Number(marks[i]!.equity) / 1e9;
  console.log(`hour ${marks[i]!.hour}: equity ${b.toFixed(4)} SOL  return ${(((b / a - 1) * 100).toFixed(3))}%`);
}
console.log('net:', (Number(r.netPnl) / 1e9).toFixed(4), 'fills:', r.fills, 'coins:', r.mints, 'trips:', r.trips.length);
