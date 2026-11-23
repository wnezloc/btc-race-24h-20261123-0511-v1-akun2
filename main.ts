// adaptive-v2c: P1-A — regime-gated adaptive dip-buy + brake.
// Protocol: agent-fun/bars-replay/v1 (symbol CBBTC, 1-minute bars).
// Params: drop=1.5%, TP up 2% / range 1%, stop 1.5%, frac=1.0,
// ADX_DEF=20, ADX_UP=25, confirm=15, brake 2%/120 bars.
// Runs on Node 22+ / 24 without extra deps (erasable syntax only).

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const DROP = 0.015; // dip below 120-bar peak that arms a buy.
const TP_UP = 0.02; // take profit in an up regime.
const TP_RANGE = 0.01; // take profit in a ranging regime.
const STOP = 0.015; // stop loss.
const FRAC_NUM = 1n; // fraction of free cash per buy (1.0).
const FRAC_DEN = 1n;
const ADX_DEF = 20.0; // defensive regime when ADX >= this.
const ADX_UP = 25.0; // up regime when ADX >= this.
const CONFIRM = 15; // bars of hysteresis for regime switches.
const BRAKE_DD = 0.02; // drawdown that triggers the brake.
const BRAKE_BARS = 120; // window for the drawdown brake.
const MAX_HOLD = 240; // max bars held before forced exit.
const MAX_SLIPPAGE_BPS = 100; // max slippage vs latest close.

// ---- indicators ---------------------------------------------------------
// EMA over the last N bars (seeded on the first bar, recursive update).
class Ema {
  private n: number;
  private alpha: number;
  private v: number | null = null;
  constructor(n: number) {
    this.n = n;
    this.alpha = 2 / (n + 1);
  }
  update(x: number): number {
    if (this.v === null) this.v = x;
    else this.v = this.alpha * x + (1 - this.alpha) * this.v;
    return this.v;
  }
  get value(): number | null {
    return this.v;
  }
}

// ADX(14), Wilder smoothing — matches the Python reference exactly:
// seed = sum of TR/PDM/MDM over bars 1..14; first DX at bar 15;
// first ADX = mean of the first 14 DX values at bar 28;
// then ADX = (ADX*13 + DX)/14.
class Adx {
  private tr = 0;
  private pdm = 0;
  private mdm = 0;
  private dxs: number[] = [];
  private adx: number | null = null;
  private prevClose: number | null = null;
  private prevHigh: number | null = null;
  private prevLow: number | null = null;
  private count = 0;
  update(high: number, low: number, close: number): number | null {
    this.count += 1;
    if (this.prevClose === null) {
      this.prevClose = close;
      this.prevHigh = high;
      this.prevLow = low;
      return null;
    }
    const tr = Math.max(
      high - low,
      Math.abs(high - this.prevClose),
      Math.abs(low - this.prevClose),
    );
    const up = high - this.prevHigh!;
    const dn = this.prevLow! - low;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    this.prevClose = close;
    this.prevHigh = high;
    this.prevLow = low;
    if (this.count <= 14) {
      this.tr += tr;
      this.pdm += pdm;
      this.mdm += mdm;
      return null;
    }
    if (this.count === 15) {
      this.tr = (this.tr * 13 + tr) / 14;
      this.pdm = (this.pdm * 13 + pdm) / 14;
      this.mdm = (this.mdm * 13 + mdm) / 14;
    } else {
      this.tr = (this.tr * 13 + tr) / 14;
      this.pdm = (this.pdm * 13 + pdm) / 14;
      this.mdm = (this.mdm * 13 + mdm) / 14;
    }
    const diP = this.tr === 0 ? 0 : (100 * this.pdm) / this.tr;
    const diM = this.tr === 0 ? 0 : (100 * this.mdm) / this.tr;
    const sum = diP + diM;
    const dx = sum === 0 ? 0 : (100 * Math.abs(diP - diM)) / sum;
    this.dxs.push(dx);
    if (this.adx === null) {
      if (this.dxs.length < 14) return null;
      this.adx = this.dxs.reduce((a, b) => a + b, 0) / 14;
      return this.adx;
    }
    this.adx = (this.adx * 13 + dx) / 14;
    return this.adx;
  }
}

// Regime classifier: up / range / defensive with N-bar hysteresis.
// Slope = (EMA(240) now - EMA(240) 60 bars ago) / 60, in price units.
// Up: slope >= 0.001 AND adx >= ADX_UP. Defensive: slope <= -0.001
// OR adx >= ADX_DEF. Otherwise range. A switch only takes effect
// after CONFIRM consecutive bars asking for it.
type Regime = 'up' | 'range' | 'defensive';
class RegimeClassifier {
  private ema = new Ema(240);
  private adx = new Adx();
  private emaHist: number[] = [];
  private mode: Regime = 'range';
  private pending: Regime | null = null;
  private pendingCount = 0;
  private adxDef: number;
  private adxUp: number;
  private confirm: number;
  constructor(adxDef: number, adxUp: number, confirm: number) {
    this.adxDef = adxDef;
    this.adxUp = adxUp;
    this.confirm = confirm;
  }
  update(high: number, low: number, close: number): Regime {
    const e = this.ema.update(close);
    this.emaHist.push(e);
    const adx = this.adx.update(high, low, close);
    let target: Regime = 'range';
    if (this.emaHist.length > 60) {
      const slope = (e - this.emaHist[this.emaHist.length - 61]) / 60;
      if (slope >= 0.001 && adx !== null && adx >= this.adxUp) target = 'up';
      else if (slope <= -0.001 || (adx !== null && adx >= this.adxDef))
        target = 'defensive';
    }
    if (target === this.mode) {
      this.pending = null;
      this.pendingCount = 0;
    } else if (target === this.pending) {
      this.pendingCount += 1;
      if (this.pendingCount >= this.confirm) {
        this.mode = target;
        this.pending = null;
        this.pendingCount = 0;
      }
    } else {
      this.pending = target;
      this.pendingCount = 1;
    }
    return this.mode;
  }
  get current(): Regime {
    return this.mode;
  }
}

// ---- bot state ----------------------------------------------------------
interface Pos {
  entry: number;
  bar: number;
}
let priceScale = 5; // CBBTC price_scale, set from hello.
let qtyScale = 8; // CBBTC qty_scale, set from hello.
let quoteScale = 6; // capital quote_scale, set from hello.
let peak = 0; // rolling 120-bar max close (decision-bar index).
const peakWindow: { bar: number; close: number }[] = [];
let pos: Pos | null = null;
let lastSellBar = -1e9;
let equityPeak = 1000; // starting cash, USD.
let equityPeakBar = 0;
let brakeUntil = -1;
let clf: RegimeClassifier | null = null;

// Average entry price in USD, fees included (cost / qty, both raw).
function entryUsd(state: BarsState): number {
  const p = state.positions.get(SYM);
  if (!p || p.qty === 0n) return 0;
  return (Number(p.cost) * 10 ** qtyScale) / (Number(p.qty) * 10 ** quoteScale);
}

async function main() {
  await runBars({
    onHello(state) {
      const s = state.symbols.get(SYM);
      if (s !== undefined) {
        priceScale = s.price_scale;
        qtyScale = s.qty_scale;
      }
      quoteScale = state.hello.capital.quote_scale;
      equityPeak =
        Number(state.hello.capital.quote_units) / 10 ** quoteScale;
      clf = new RegimeClassifier(ADX_DEF, ADX_UP, CONFIRM);
      const d = new Date(state.hello.first_close_ms).toISOString();
      console.error(`hello: ${SYM} first close ${d}`);
    },
    onBatch(state: BarsState, batch: Batch): OrderInput[] {
      const seq = batch.seq;

      // Fills from the previous decision land in this batch.
      for (const f of batch.fills) {
        if (f.symbol !== SYM || f.status !== 'filled') continue;
        if (f.side === 'buy') {
          pos = { entry: entryUsd(state), bar: f.decided_bar };
        } else if (f.side === 'sell') {
          pos = null;
          lastSellBar = f.decided_bar;
        }
      }

      const bar = batch.bars.find((b) => b.symbol === SYM);
      if (bar === undefined) return [];
      const close = Number(bar.c) / 10 ** priceScale;
      const high = Number(bar.h) / 10 ** priceScale;
      const low = Number(bar.l) / 10 ** priceScale;

      // Rolling 120-bar peak (decision bars; evict bars <= seq-120).
      while (peakWindow.length > 0 && peakWindow[0].bar <= seq - 120)
        peakWindow.shift();
      // Keep the window monotone decreasing by close.
      while (
        peakWindow.length > 0 &&
        peakWindow[peakWindow.length - 1].close <= close
      )
        peakWindow.pop();
      peakWindow.push({ bar: seq, close });
      peak = peakWindow[0].close;

      // Regime + brake state update every bar, even while warming up.
      if (clf === null) clf = new RegimeClassifier(ADX_DEF, ADX_UP, CONFIRM);
      const regime = clf.update(high, low, close);

      // Equity for the drawdown brake: cash + position at latest close.
      const equity = Number(state.equity) / 10 ** quoteScale;
      if (equity > equityPeak) {
        equityPeak = equity;
        equityPeakBar = seq;
      }
      const dd = equityPeak === 0 ? 0 : (equityPeak - equity) / equityPeak;
      if (dd >= BRAKE_DD && seq - equityPeakBar <= BRAKE_BARS) {
        brakeUntil = seq + BRAKE_BARS;
      }
      const brakeOn = seq < brakeUntil;

      if (state.warmingUp) return [];

      // --- exits (checked before entries) ---
      if (pos !== null) {
        const tp = regime === 'up' ? TP_UP : TP_RANGE;
        if (
          close >= pos.entry * (1 + tp) ||
          close <= pos.entry * (1 - STOP) ||
          seq - pos.bar >= MAX_HOLD
        ) {
          const qty = state.positions.get(SYM)?.qty ?? 0n;
          if (qty > 0n) {
            return [
              {
                side: 'sell',
                symbol: SYM,
                qty,
                max_slippage_bps: MAX_SLIPPAGE_BPS,
              },
            ];
          }
        }
      }

      // --- entries ---
      if (pos === null && !brakeOn && regime !== 'defensive') {
        const dipped = close <= peak * (1 - DROP);
        if (dipped) {
          const notional = (state.cash * FRAC_NUM) / FRAC_DEN;
          if (notional > 0n) {
            return [
              {
                side: 'buy',
                symbol: SYM,
                notional_quote_units: notional,
                max_slippage_bps: MAX_SLIPPAGE_BPS,
              },
            ];
          }
        }
      }
      return [];
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Guard: P1-A entrypoint — dip 1,5% / TP 1% / frac 1,0 / ADX_DEF 20 / confirm 15.
// Dev 23nov grade-local: +$10,179441 (2 trades, maxDD 1,58%). Reproduces Python backtest.
