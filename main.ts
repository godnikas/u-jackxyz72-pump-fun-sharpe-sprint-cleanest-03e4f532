// Cleanest Paper Bot — a Sharpe-first paper trader for the pump.fun replay.
//
// The final window is only six hours and places go by hourly Sharpe ratio, so this bot is
// built for steady, small, diversified gains instead of one lucky moonshot: a strict
// clean-launch gate (creator bought 1–2.5 SOL, 12+ distinct buyers, real SOL ≥ 3), tiny
// 0.03 SOL stakes, fast scale-out take-profits, a tight stop, and a bank-it rule that stops
// opening new positions once the run is +0.05 SOL ahead. Guardrail probes in the first hour
// guarantee the 20-coin minimum at minimal cost.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
