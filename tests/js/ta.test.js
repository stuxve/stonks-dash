// node tests/js/ta.test.js — indicator math vs reference values from the Python `ta` library (bukosabino/ta)
const assert = require("assert");
const T = require("../../static/ta-ind.js");

const n = 300, i = [...Array(n).keys()];
const c = i.map((k) => 100 + 10 * Math.sin(k / 5) + 0.1 * k);
const h = i.map((k) => c[k] + 1 + 0.5 * Math.cos(k / 3) ** 2);
const l = i.map((k) => c[k] - 1 - 0.5 * Math.sin(k / 4) ** 2);
const v = i.map((k) => 1000 + 10 * k + 300 * Math.sin(k / 7));
const last = (a) => a[a.length - 1];
const near = (got, want, rel, name) => assert.ok(Math.abs(got - want) <= rel * Math.max(1, Math.abs(want)), `${name}: ${got} vs ${want}`);

const ref = { rsi: 41.95940948, macd: 1.659974177, signal: 2.639605608, bb_up: 143.1623129, atr: 2.841603277, adx: 32.52752655,
  stoch: 9.184105123, wr: -90.81589488, cci: -72.61463847, mfi: 44.06824321, cmf: 0.01982960445, kijun: 128.4434261 };
// RSI / MACD use a different EMA seed than `ta`; the difference has decayed to ~1e-6 after 300 bars
near(last(T.rsi(c, 14)), ref.rsi, 1e-5, "RSI");
const m = T.macd(c);
near(last(m.macd), ref.macd, 1e-5, "MACD"); near(last(m.signal), ref.signal, 1e-5, "MACD signal");
near(last(T.bollinger(c, 20, 2).up), ref.bb_up, 1e-9, "Bollinger");
near(last(T.atr(h, l, c, 14)), ref.atr, 1e-9, "ATR");
near(last(T.adx(h, l, c, 14).adx), ref.adx, 1e-9, "ADX");
near(last(T.stochastic(h, l, c, 14, 1, 3).k), ref.stoch, 1e-9, "Stochastic %K");
near(last(T.williamsR(h, l, c, 14)), ref.wr, 1e-9, "Williams %R");
near(last(T.cci(h, l, c, 20)), ref.cci, 1e-9, "CCI");
near(last(T.mfi(h, l, c, v, 14)), ref.mfi, 1e-9, "MFI");
near(last(T.cmf(h, l, c, v, 20)), ref.cmf, 1e-9, "CMF");
near(last(T.ichimoku(h, l, c).kijun), ref.kijun, 1e-9, "Ichimoku kijun");

// basics
assert.deepStrictEqual(T.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
assert.strictEqual(last(T.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)), 100);
assert.deepStrictEqual(T.crosses([1, 2, 3, 1], [2, 2, 2, 2]), [[2, 1], [3, -1]]);
// supertrend / SAR flip direction in a V
const vv = [...Array(80).keys()].map((k) => (k < 40 ? 100 - k : 60 + (k - 40) * 1.5));
const st = T.supertrend(vv.map((x) => x + 0.5), vv.map((x) => x - 0.5), vv, 10, 3);
assert.ok(st.up[35] === false && st.up[79] === true, "supertrend follows the V");
const sar = T.psar(vv.map((x) => x + 0.5), vv.map((x) => x - 0.5));
assert.ok(sar.up[35] === false && sar.up[79] === true, "SAR follows the V");
// weekly resample: Mon–Fri → one bar with the week's high/low, last close, summed volume
const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26"];
const wk = T.resample(days.map((t, k) => ({ t, o: 10 + k, h: 12 + k, l: 9 + k, c: 11 + k, v: 100 })), "W");
assert.deepStrictEqual(wk[0], { t: "2026-10-19", o: 10, h: 16, l: 9, c: 15, v: 500 });
assert.strictEqual(wk.length, 2);
// pivots
const pv = T.pivots(110, 90, 100);
assert.deepStrictEqual([pv.P, pv.R1, pv.S1], [100, 110, 90]);
console.log("ta indicators ok");
