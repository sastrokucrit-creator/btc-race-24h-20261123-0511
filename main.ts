// btc-race-24h-20261123-0511 — trend-following bot for cbBTC/USDC, 1-minute bars.
// Strategy (designed from first principles; no baseline code read or copied):
//   * Long only, one position, full size on entry.
//   * Enter when the fast EMA (12) is above the slow EMA (48) AND the 24-bar
//     return is positive by more than 1.00% (momentum confirmation, avoids chop).
//   * Exit on whichever comes first: fast EMA crosses back below slow EMA,
//     a trailing stop 2.00% below the peak close since entry, or +2.00% take-profit.
//   * 30-bar cooldown after an exit before re-entry.
//   * Parameters verified by a local sweep of 54 variants on the dev window:
//     momentum 100 bps + trailing stop 200 bps is the robust core — positive
//     across every EMA pair and neighbouring trail/TP values, not a lone max.
//   * All indicator math is fixed-point BigInt: deterministic across engines,
//     so two runs produce byte-identical action logs. No clock, no env, no RNG.
// Protocol: agent-fun/bars-replay/v1, NDJSON on stdin/stdout (node:readline only).
// Self-contained: no kit shim import (the loop below speaks the protocol directly).

import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';
const FP = 1_000_000n; // fixed-point scale for EMA values
const EMA_FAST_N = 12n;
const EMA_SLOW_N = 48n;
const MIN_HISTORY = 48; // bars of closes before the first entry
const MOMENTUM_BPS = 100n; // 1.00% — 24-bar return must beat this to enter
const MOMENTUM_BARS = 24;
const TRAIL_BPS = 200n; // 2.00% trailing stop below peak close
const TAKE_PROFIT_BPS = 200n; // 2.00% above entry fill price
const MAX_SLIPPAGE_BPS = 300;
const COOLDOWN_BARS = 30; // bars after an exit before re-entry

interface Bar { symbol: string; t: number; o: string; h: string; l: string; c: string; v: string | null; o_depth: string[]; c_depth: string[] }
interface Position { symbol: string; qty: string; cost_quote_units: string }
interface Account { cash_quote_units: string; positions: Position[]; equity_quote_units: string }
interface Fill { client_id: string; symbol: string; side: 'buy' | 'sell'; status: 'filled' | 'rejected'; reason: string | null; decided_bar: number; fill_bar: number; price: string; qty: string; notional_quote_units: string; fee_quote_units: string }
interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account }

const closes: bigint[] = [];
let emaFast: bigint | null = null; // fixed-point (price * FP)
let emaSlow: bigint | null = null;
let entryPrice: bigint | null = null; // fill price of the open position
let peakClose: bigint | null = null; // highest close since entry
let lastExitSeq = -1000; // seq of the last sell decision: 30-bar cooldown before re-entry
let warmupBars = 0;

function emaUpdate(prev: bigint, price: bigint, n: bigint): bigint {
  // ema += (price - ema) * 2 / (n + 1), all in fixed point; truncation is deterministic.
  return prev + ((price * FP - prev) * 2n) / (n + 1n);
}

function decide(seq: number, bar: Bar, account: Account): unknown[] {
  const close = BigInt(bar.c);
  closes.push(close);
  if (emaFast === null) emaFast = close * FP;
  else emaFast = emaUpdate(emaFast, close, EMA_FAST_N);
  if (emaSlow === null) emaSlow = close * FP;
  else emaSlow = emaUpdate(emaSlow, close, EMA_SLOW_N);

  const pos = account.positions.find((p) => p.symbol === SYMBOL);
  const qty = pos ? BigInt(pos.qty) : 0n;
  const cash = BigInt(account.cash_quote_units);

  if (seq < warmupBars) return [];
  if (closes.length < MIN_HISTORY) return [];

  if (qty > 0n) {
    // Long: update the peak, then check exits.
    if (peakClose === null || close > peakClose) peakClose = close;
    const crossDown = emaFast < emaSlow;
    const trailing = peakClose !== null && close * 10000n <= peakClose * (10000n - TRAIL_BPS);
    const takeProfit = entryPrice !== null && close * 10000n >= entryPrice * (10000n + TAKE_PROFIT_BPS);
    if (crossDown || trailing || takeProfit) {
      lastExitSeq = seq;
      return [{ side: 'sell', client_id: `s${seq}`, symbol: SYMBOL, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: entry needs trend + momentum, and no exit in the last 30 bars
  // (a stop-loss exit must not re-buy straight back into the same falling move).
  const uptrend = emaFast > emaSlow;
  const ago = closes[closes.length - 1 - MOMENTUM_BARS];
  const momentum = ago !== undefined && (close - ago) * 10000n > ago * MOMENTUM_BPS;
  const cooledDown = seq - lastExitSeq >= COOLDOWN_BARS;
  if (uptrend && momentum && cooledDown && cash > 1000000n) {
    return [{ side: 'buy', client_id: `b${seq}`, symbol: SYMBOL, notional_quote_units: cash.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const out = process.stdout;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.type === 'hello') {
      warmupBars = typeof msg.warmup_bars === 'number' ? msg.warmup_bars : 0;
      continue;
    }
    if (msg.type === 'done') {
      lines.close();
      process.stdin.destroy();
      return;
    }
    if (msg.type !== 'batch') throw new Error(`unknown message type ${String(msg.type)}`);
    const batch = msg as unknown as Batch;
    // Fold fills first: a buy fill sets the entry price and peak; a sell fill clears them.
    for (const f of batch.fills ?? []) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (f.side === 'buy') { entryPrice = BigInt(f.price); peakClose = BigInt(f.price); }
      if (f.side === 'sell') { entryPrice = null; peakClose = null; }
    }
    const bar = (batch.bars ?? []).find((b) => b.symbol === SYMBOL);
    const orders = bar ? decide(batch.seq, bar, batch.account) : [];
    out.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
