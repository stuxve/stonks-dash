// node tests/js/ta-ext.test.js — extra overlays, non-time charts, candlestick / gap / chart-pattern detection
const assert = require("assert");
const T = require("../../static/ta-ext.js");
const days = (n) => [...Array(n).keys()].map((k) => new Date(Date.UTC(2020, 0, 1 + k)).toISOString().slice(0, 10));
const near = (a, b, tol, name) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${name}: ${a} vs ${b}`);

// KAMA vs the Python `ta` library (KAMAIndicator(10, 2, 30))
const c300 = [...Array(300).keys()].map((k) => 100 + 10 * Math.sin(k / 5) + 0.1 * k);
near(T.kama(c300, 10, 2, 30).at(-1), 133.4525992010999, 1e-9, "KAMA");
// DEMA / TEMA have no lag on a straight line
assert.strictEqual(T.dema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3).at(-1), 10);
near(T.tema([...Array(12).keys()].map((k) => k + 1), 3).at(-1), 12, 1e-12, "TEMA");
// linear regression: exact on a line, R² = 1
const fit = T.linFit([1, 3, 5, 7, 9], 0, 4);
near(fit.slope, 2, 1e-12, "slope"); near(fit.at(4), 9, 1e-12, "fit"); near(fit.r2, 1, 1e-12, "R2");

// Renko: 100→110 in steps of 1, box 2 → 5 up bricks; a reversal needs 2 boxes, so 104 gives two down bricks
const c1 = [...Array(11).keys()].map((k) => 100 + k).concat([109, 108, 107, 106, 105, 104]);
assert.deepStrictEqual(T.renko(c1, days(c1.length), 2).map((b) => [b.up, b.o, b.c]),
  [[true, 100, 102], [true, 102, 104], [true, 104, 106], [true, 106, 108], [true, 108, 110], [false, 108, 106], [false, 106, 104]]);
// Three line break: small pullbacks inside the last 3 lines don't reverse
assert.deepStrictEqual(T.lineBreak([10, 11, 12, 13, 12.5, 11.9, 10.9, 11.5, 14], days(9), 3).map((b) => [b.o, b.c]), [[10, 11], [11, 12], [12, 13], [13, 14]]);
// Kagi: thick (yang) → thin (yin) when the waist at 11 is broken
const kg = T.kagi([10, 12, 14, 11, 13, 15, 12, 9, 11], days(9), 2);
assert.deepStrictEqual(kg[3].seg.map((s) => [s.y1, s.y2, s.thick]), [[15, 11, true], [11, 9, false]]);
assert.strictEqual(kg[4].seg[0].thick, false);
// Point & Figure: box 1, 3-box reversal → double top breakout above 20
const H = [10, 12, 15, 18, 20, 19, 18, 17, 18, 20, 21, 22], pf = T.pnf(H, H.map((x) => x - 0.5), days(H.length), { box: 1, rev: 3 });
assert.deepStrictEqual(pf.cols.map((x) => [x.type, x.bot, x.top]), [["X", 9, 20], ["O", 17, 19], ["X", 18, 22]]);
assert.strictEqual(pf.signals[0].type, "Double top breakout"); assert.strictEqual(pf.signals[0].level, 21);
assert.strictEqual(T.niceBox(0.37), 0.25); assert.strictEqual(T.niceBox(0.4), 0.5); assert.strictEqual(T.niceBox(3.2), 2.5);
// ZigZag
assert.deepStrictEqual(T.zigzag([100, 105, 110, 104, 98, 103, 109, 115, 108, 100], [100, 105, 110, 104, 98, 103, 109, 115, 108, 100], 5).map((z) => `${z.k}${z.p}`), ["L100", "H110", "L98", "H115", "L100"]);
// gaps: up gap filled later, down gaps still open
const g = T.gaps([10, 10.5, 12, 12.2, 11, 10.4], [9.5, 10, 11.2, 11.5, 10.6, 10.1], [10, 10.4, 11.8, 12, 10.8, 10.2], 0.5);
assert.deepStrictEqual(g.map((x) => [x.i, x.dir, x.filled]), [[2, 1, 5], [4, -1, null], [5, -1, null]]);
// volume by price puts the volume where it closed
const vp = T.volumeByPrice([1, 1, 1], [11, 11, 11], [9, 9, 9], [10, 10.9, 9.1], [100, 200, 300], 0, 2, 2);
assert.strictEqual(vp.bins[0].up + vp.bins[0].dn + vp.bins[1].up + vp.bins[1].dn, 600);

// candlesticks after a steady decline
function lastPatterns(extra) {
  const o = [], h = [], l = [], c = [];
  for (let k = 0; k < 20; k++) { const op = 120 - k * 1.2, cl = op - 1; o.push(op); c.push(cl); h.push(op + 0.3); l.push(cl - 0.3); }
  for (const [op, hi, lo, cl] of extra) { o.push(op); h.push(hi); l.push(lo); c.push(cl); }
  return T.candles(o, h, l, c).filter((x) => x.i === c.length - 1).map((x) => x.name);
}
const L0 = 120 - 19 * 1.2 - 1;
assert.ok(lastPatterns([[L0 - 0.5, L0 - 0.3, L0 - 3.5, L0 - 0.1]]).includes("Hammer"));
assert.ok(lastPatterns([[L0 - 0.2, L0 + 1.6, L0 - 0.5, L0 + 1.5]]).includes("Bullish engulfing"));
assert.ok(lastPatterns([[L0 - 1.5, L0 - 1.3, L0 - 2.0, L0 - 1.7], [L0 - 0.5, L0 + 0.9, L0 - 0.6, L0 + 0.8]]).includes("Morning star"));
assert.ok(lastPatterns([[L0 - 0.4, L0 + 0.7, L0 - 0.5, L0 + 0.6]]).includes("Piercing line"));
assert.ok(lastPatterns([[L0, L0 + 1.4, L0 - 0.1, L0 + 1.3], [L0 + 0.6, L0 + 2.8, L0 + 0.5, L0 + 2.7], [L0 + 2.0, L0 + 4.2, L0 + 1.9, L0 + 4.1]]).includes("Three white soldiers"));
assert.ok(lastPatterns([[L0, L0 + 0.8, L0 - 0.8, L0 + 0.02]]).includes("Doji"));

// chart patterns on piecewise-linear waves
const wave = (pts) => { const out = []; for (let k = 0; k < pts.length - 1; k++) for (let s = 0; s < 12; s++) out.push(pts[k] + (pts[k + 1] - pts[k]) * s / 12); out.push(pts.at(-1)); return out; };
const det = (w, pct) => T.chartPatterns(w, w.map((x) => x * 1.003), w.map((x) => x * 0.997), w, { pct }).patterns;
const hs = det(wave([80, 100, 90, 110, 90, 100, 85, 80]), 5);
assert.deepStrictEqual(hs.map((x) => x.type), ["Head and shoulders"]);
assert.ok(hs[0].brk != null && hs[0].dir === -1 && hs[0].target < 90);
const dt = det(wave([80, 100, 90, 100.5, 85, 82]), 5);
assert.deepStrictEqual(dt.map((x) => [x.type, x.dir]), [["Double top", -1]]);
const tri = det(wave([70, 100, 80, 99.5, 88, 100.2, 94, 105, 110]), 4);
assert.ok(tri.some((x) => x.type === "Ascending triangle" && x.dir === 1 && x.brk != null));

// seasonality: one return per calendar month per year
const se = T.seasonality(days(800).map((t, k) => ({ t, c: 100 + k })));
assert.ok(se.months.every((m) => m.n >= 2 && m.avg > 0 && m.up === 1));
// Elder impulse is green in a steady rally
assert.strictEqual(T.elderImpulse([...Array(60).keys()].map((k) => 100 * 1.01 ** k)).at(-1), 1);
console.log("ta-ext ok");
