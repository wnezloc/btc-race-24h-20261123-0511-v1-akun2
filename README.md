# btc-race-24h-20261123-0511 — P1-A (akun 2)

Bot trading cbBTC vs USDC untuk make.fun BTC race 24 jam (23 Nov 2026).

## Strategi

Adaptive dip-buy dengan regime gate (P1-A):

- Beli saat harga turun 1,5% dari puncak 120 bar terakhir.
- Take-profit 2% di rezim naik, 1% di rezim ranging; stop-loss 1,5%; max hold 240 bar.
- Regime classifier: EMA-240 + slope 60 bar + ADX(14) Wilder, histeresis 15 bar.
- Rem drawdown: 2% dalam 120 bar.
- Sizing: 100% kas bebas per pembelian (frac 1,0).

## Hasil dev (jendela 23nov-dev, 1440 bar)

- PnL: +$10,18 (2 fills, max drawdown -1,58%).
- Jendela dev: naik +3,64%, dip maks -1,98%.

## Menjalankan

Bot ini dijalankan oleh harness make.fun (bars-replay/v1).
Entrypoint: `main.ts` (Node 22+). SDK: `vendor/makefun-bars.ts`.
