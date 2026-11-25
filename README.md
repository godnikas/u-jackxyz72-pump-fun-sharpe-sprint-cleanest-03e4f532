[![competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/godnikas/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/godnikas/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Cleanest Paper Bot — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition. Places go by **hourly Sharpe ratio** on a 6-hour pump.fun replay, so this bot is built for steady, small, diversified gains instead of one lucky moonshot.

## Strategy

- **Clean-launch gate only.** A fresh curve is bought only once it already looks honest: the creator bought 1–2.5 SOL, at least 12 distinct buyers, real SOL ≥ 3, net inflow ≥ 1 SOL, sells still small, and the price not yet run away. (On the dev window, creator sells and tiny creator buys marked the losers, so neither is a filter anymore.)
- **Tiny stakes, one small add.** 0.03 SOL in, one 0.03 SOL add into strength only — losers stay tiny, runners get a little more.
- **Fast scale-out exits.** Half sold at +20%, the rest rides a 20% trailing stop (armed at +15%); a tight 8% stop-loss, a 1,000-slot time limit, and a big-sell exit cut trouble early.
- **Bank-it rule.** Once mark-to-market net PnL reaches +0.05 SOL the bot stops opening new positions, so a good start is not given back to a market whose average trade loses money.
- **Front-loaded guardrail probes.** Tiny 0.01 SOL probe round trips in the first hour guarantee the 20-coin / round-trip minimums at minimal cost, then the bot goes quiet unless a real setup appears.

## Local results (dev window, kit's own grader)

| | |
|---|---|
| Hourly Sharpe (dev) | **-0.11** (local sim) |
| Net PnL (dev) | **-0.012 SOL** |
| Round trips / coins | 41 / 29 |
| Max drawdown | 0.2% |

For comparison on the same dev window: momentum pilot Sharpe -0.58 (net -9.44 SOL), reversion pilot -0.48 (net -3.99 SOL), sniper pilot -0.84 (net -0.50 SOL). The edge here is not a better crystal ball — it is refusing almost every trade and keeping the few it takes small.

## Layout

- `main.ts` — entrypoint: runs the strategy through the vendored SDK shim.
- `strategy.ts` — the strategy (params + logic, no I/O, no clock, no randomness).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/` — local backtest / sweep / hourly-Sharpe evaluation on the kit's dev window (`sim.ts` is the kit pilot's engine port, extended to read all dataset parts and to record hourly equity).

## Run it

```sh
node main.ts            # the grader runs exactly this, on Node 22
```

Paper trading only — no real funds, no SOL spent.
