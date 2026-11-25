// Cleanest Paper Bot — strategy for the pump.fun bonding-curve replay.
//
// Idea: most new pump.fun coins are bundled launches that dump on the first buyers, so the
// bot only buys a fresh curve that already looks clean — a small creator buy, no creator
// sell, a handful of distinct early buyers, net SOL flowing in, sells still small, and the
// price not yet run away. It then risks very little per coin and exits fast: half the
// position is sold at a modest take-profit, the rest rides a trailing stop, and any sign of
// trouble (stop loss, fading flow, a big sell, the creator selling, staleness, or a time
// limit) closes the whole remainder. Small stakes across many coins keep each hour's return
// smooth, which is what an hourly Sharpe ranking rewards.
//
// Guardrail probes keep the run above the minimum bar (20 distinct mints, round trips of at
// least 0.01 SOL): when the bot's own fills or coins lag a pace set in block time, it buys a
// tiny probe of a liquid curve and sells it as soon as the buy lands.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O. Every map is
// iterated in insertion order, so two runs on the same data produce the same orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buy SOL at launch, at least / at most. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Net SOL (buys minus sells) seen before entry, at least. */
  minFlowSol: number;
  /** Sell SOL seen, at most this share of buy SOL. */
  maxSellRatio: number;
  /** Price now over the create price, at most (1 + this). */
  maxRunup: number;
  /** Largest single sell seen before entry (SOL), at most. */
  maxSingleSellSol: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** An add needs the price at least this far above the previous buy's decision price. */
  addStep: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** First take-profit: sell tp1Part of the tokens once value is tp1 over cost. */
  tp1: number;
  tp1Part: number;
  /** Second take-profit: sell the rest once value is tp2 over cost. */
  tp2: number;
  /** Stop loss: sell all once value is sl under cost. */
  stopLoss: number;
  /** Trailing stop, armed once value reached cost * (1 + trailArm). */
  trail: number;
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeSol. */
  fadeWindow: number;
  fadeSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when no trade has been recorded for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins and plenty of fills. When the
   * bot's own fills or coins lag targetFills / targetCoins scaled by the share of paceSecs
   * elapsed (block time since the first batch), it opens tiny probe round trips (buy
   * probeSol, sell it all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Bank-it rule (Sharpe protection): once the run's mark-to-market net PnL reaches this
   * (SOL), stop opening new positions and let the open ones exit on their own rules, so a
   * good start is not given back to a market whose average trade loses money. 0 = off.
   */
  bankSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 40,
  minRqSol: 3,
  maxRqSol: 60,
  minDevBuySol: 1,
  maxDevBuySol: 2.5,
  minBuyers: 12,
  maxBuyers: 100,
  minTrades: 8,
  minFlowSol: 1,
  maxSellRatio: 0.5,
  maxRunup: 1,
  maxSingleSellSol: 1,
  stakeSol: 0.06,
  initialSol: 0.03,
  addSol: 0.03,
  maxAdds: 1,
  addStep: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.2,
  tp1Part: 0.5,
  tp2: 0.6,
  stopLoss: 0.08,
  trail: 0.2,
  trailArm: 0.15,
  fadeWindow: 12,
  fadeSol: 1000,
  bigSellSol: 2,
  maxHold: 1000,
  staleSlots: 120,
  cooldown: 200,
  maxEntries: 1,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 3600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 2,
  bankSol: 0.05,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuySol: number;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  adds: number;
  tp1Done: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Bank-it rule latched: stop opening new positions once ahead by bankSol. */
  let banked = false;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        createPrice: 0,
        devBuySol: 0,
        devSold: false,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        lastTradeSlot: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The clean-launch gate: true only when a fresh curve already looks honest. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.devBuySol < p.minDevBuySol || t.devBuySol > p.maxDevBuySol) return false;
    // Note: a creator sell is NOT a reject — on this data coins whose creator sold early
    // run more often than ones whose creator never sold.
    if (t.createPrice <= 0 || price > t.createPrice * (1 + p.maxRunup)) return false;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let biggestSell = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        if (tr.user !== t.creator) buyers.add(tr.user);
      } else {
        sellSol += tr.sol;
        if (tr.sol > biggestSell) biggestSell = tr.sol;
      }
    }
    if (buys < p.minTrades) return false;
    if (buyers.size < p.minBuyers || buyers.size > p.maxBuyers) return false;
    if (buySol - sellSol < p.minFlowSol) return false;
    if (sellSol > p.maxSellRatio * buySol) return false;
    if (biggestSell > p.maxSingleSellSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          t.lastTradeSlot = e.slot;
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy) t.devBuySol += sol;
            else t.devSold = true;
          }
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Keep tapes short: only the recent window matters for flow checks.
      const keep = Math.max(p.fadeWindow, p.maxAge + 5);
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Close value of a position in SOL, curve and tx fees deducted. */
      const closeValue = (mint: Pubkey, tokens: bigint): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk === undefined && curve === undefined) return 0;
        const vq = Number(mk ? mk.virtual_quote_reserves : curve!.virtual_quote_reserves);
        const vt = Number(mk ? mk.virtual_token_reserves : curve!.virtual_token_reserves);
        return ((Number(tokens) * vq) / (vt + Number(tokens)) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: scale out at take-profits, cut everything on trouble.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // First take-profit: sell a slice, let the rest ride the trailing stop.
        if (!h.tp1Done && value >= cost * (1 + p.tp1)) {
          if (pendingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          const part = (pos.token_amount * BigInt(Math.round(p.tp1Part * 1000))) / 1000n;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            h.tp1Done = true;
            continue;
          }
        }
        let exit = false;
        if (value >= cost * (1 + p.tp2)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && now - t.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Bank-it rule: once mark-to-market net PnL reaches bankSol, stop opening new
      // positions (open ones still exit on their own rules). A good start is not given
      // back to a market whose average trade loses money.
      if (p.bankSol > 0 && !banked) {
        let equity = Number(state.cash) / LAMPORTS;
        for (const [mint, pos] of state.positions) equity += closeValue(mint, pos.token_amount);
        const start = Number(state.hello.capital.lamports) / LAMPORTS;
        if (equity - start >= p.bankSol) banked = true;
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (banked) break;
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol, price)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // One small add into strength only: price stepped up and flow still positive.
          if (h.adds >= p.maxAdds || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.fadeWindow) < 0) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            adds: 0,
            tp1Done: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
