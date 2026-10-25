/* stonks-dash — technical indicators. Pure functions over arrays (oldest first); warm-up values are null.
 * Conventions follow the usual definitions (Wilder smoothing for RSI / ATR / ADX, EMA seeded with an SMA).
 * Works in the browser (window.TA) and in Node (module.exports) for tests. */
(function (root) {
  "use strict";
  const N = (x) => x != null && isFinite(x);

  function sma(x, n) {
    const out = new Array(x.length).fill(null);
    let sum = 0, cnt = 0;
    for (let i = 0; i < x.length; i++) {
      if (N(x[i])) { sum += x[i]; cnt++; }
      if (i >= n && N(x[i - n])) { sum -= x[i - n]; cnt--; }
      if (i >= n - 1 && cnt === n) out[i] = sum / n;
    }
    return out;
  }
  // EMA seeded with the SMA of the first n valid values; skips leading nulls
  function ema(x, n, alpha = 2 / (n + 1)) {
    const out = new Array(x.length).fill(null);
    let start = x.findIndex(N);
    if (start < 0) return out;
    let acc = 0, k = 0, prev = null;
    for (let i = start; i < x.length; i++) {
      if (!N(x[i])) { out[i] = prev; continue; }
      if (prev == null) {
        acc += x[i]; k++;
        if (k === n) { prev = acc / n; out[i] = prev; }
      } else { prev = prev + alpha * (x[i] - prev); out[i] = prev; }
    }
    return out;
  }
  const rma = (x, n) => ema(x, n, 1 / n);          // Wilder's smoothing
  function wma(x, n) {
    const out = new Array(x.length).fill(null), den = (n * (n + 1)) / 2;
    for (let i = n - 1; i < x.length; i++) {
      let s = 0, ok = true;
      for (let j = 0; j < n; j++) { const v = x[i - j]; if (!N(v)) { ok = false; break; } s += v * (n - j); }
      if (ok) out[i] = s / den;
    }
    return out;
  }
  function hma(x, n) {
    const a = wma(x, Math.max(1, Math.round(n / 2))), b = wma(x, n);
    return wma(a.map((v, i) => (N(v) && N(b[i]) ? 2 * v - b[i] : null)), Math.max(1, Math.round(Math.sqrt(n))));
  }
  function stdev(x, n) {
    const m = sma(x, n);
    return x.map((_, i) => {
      if (m[i] == null) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (x[j] - m[i]) ** 2;
      return Math.sqrt(s / n);
    });
  }
  const highest = (x, n) => x.map((_, i) => (i < n - 1 ? null : Math.max(...x.slice(i - n + 1, i + 1))));
  const lowest = (x, n) => x.map((_, i) => (i < n - 1 ? null : Math.min(...x.slice(i - n + 1, i + 1))));
  const diff = (a, b) => a.map((v, i) => (N(v) && N(b[i]) ? v - b[i] : null));

  function trueRange(h, l, c) {
    return h.map((v, i) => (i === 0 ? v - l[i] : Math.max(v - l[i], Math.abs(v - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  }
  const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c), n);

  function rsi(c, n = 14) {
    const up = c.map((v, i) => (i ? Math.max(v - c[i - 1], 0) : null));
    const dn = c.map((v, i) => (i ? Math.max(c[i - 1] - v, 0) : null));
    const au = rma(up, n), ad = rma(dn, n);
    return c.map((_, i) => (au[i] == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i])));
  }
  function macd(c, fast = 12, slow = 26, sig = 9) {
    const line = diff(ema(c, fast), ema(c, slow));
    const signal = ema(line, sig);
    return { macd: line, signal, hist: diff(line, signal) };
  }
  function bollinger(c, n = 20, k = 2) {
    const mid = sma(c, n), sd = stdev(c, n);
    const up = mid.map((m, i) => (m == null ? null : m + k * sd[i])), lo = mid.map((m, i) => (m == null ? null : m - k * sd[i]));
    return { mid, up, lo, pctB: c.map((v, i) => (up[i] == null || up[i] === lo[i] ? null : (v - lo[i]) / (up[i] - lo[i]))),
      width: mid.map((m, i) => (m ? (up[i] - lo[i]) / m : null)) };
  }
  function keltner(h, l, c, n = 20, mult = 2, atrN = 10) {
    const mid = ema(c, n), a = atr(h, l, c, atrN);
    return { mid, up: mid.map((m, i) => (m == null || a[i] == null ? null : m + mult * a[i])),
      lo: mid.map((m, i) => (m == null || a[i] == null ? null : m - mult * a[i])) };
  }
  function donchian(h, l, n = 20) {
    const up = highest(h, n), lo = lowest(l, n);
    return { up, lo, mid: up.map((u, i) => (u == null ? null : (u + lo[i]) / 2)) };
  }
  function stochastic(h, l, c, n = 14, kS = 3, dS = 3) {
    const hh = highest(h, n), ll = lowest(l, n);
    const raw = c.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
    const k = sma(raw, kS);
    return { k, d: sma(k, dS) };
  }
  function williamsR(h, l, c, n = 14) {
    const hh = highest(h, n), ll = lowest(l, n);
    return c.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - v)) / (hh[i] - ll[i])));
  }
  function cci(h, l, c, n = 20) {
    const tp = c.map((v, i) => (h[i] + l[i] + v) / 3), m = sma(tp, n);
    return tp.map((v, i) => {
      if (m[i] == null) return null;
      let md = 0;
      for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n;
      return md ? (v - m[i]) / (0.015 * md) : 0;
    });
  }
  const roc = (c, n = 12) => c.map((v, i) => (i < n || !c[i - n] ? null : (100 * (v - c[i - n])) / c[i - n]));
  function obv(c, v) {
    let s = 0;
    return c.map((x, i) => { if (i) s += x > c[i - 1] ? v[i] : x < c[i - 1] ? -v[i] : 0; return s; });
  }
  function mfi(h, l, c, v, n = 14) {
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
    return tp.map((_, i) => {
      if (i < n) return null;
      let pos = 0, neg = 0;
      for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * v[j]; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; }
      return neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
    });
  }
  function cmf(h, l, c, v, n = 20) {
    const mfv = c.map((x, i) => (h[i] === l[i] ? 0 : (((x - l[i]) - (h[i] - x)) / (h[i] - l[i])) * v[i]));
    return c.map((_, i) => {
      if (i < n - 1) return null;
      let a = 0, b = 0;
      for (let j = i - n + 1; j <= i; j++) { a += mfv[j]; b += v[j]; }
      return b ? a / b : null;
    });
  }
  // ADX with +DI / −DI (Wilder)
  function adx(h, l, c, n = 14) {
    const pdm = h.map((x, i) => { if (!i) return null; const u = x - h[i - 1], d = l[i - 1] - l[i]; return u > d && u > 0 ? u : 0; });
    const mdm = h.map((x, i) => { if (!i) return null; const u = x - h[i - 1], d = l[i - 1] - l[i]; return d > u && d > 0 ? d : 0; });
    const tr = trueRange(h, l, c).map((v, i) => (i ? v : null));
    const sTR = rma(tr, n), sP = rma(pdm, n), sM = rma(mdm, n);
    const pdi = sTR.map((t, i) => (t ? (100 * sP[i]) / t : null)), mdi = sTR.map((t, i) => (t ? (100 * sM[i]) / t : null));
    const dx = pdi.map((p, i) => (p == null || mdi[i] == null || p + mdi[i] === 0 ? null : (100 * Math.abs(p - mdi[i])) / (p + mdi[i])));
    return { adx: rma(dx, n), pdi, mdi };
  }
  // Parabolic SAR: returns {sar, up} (up = SAR below the price)
  function psar(h, l, step = 0.02, max = 0.2) {
    const n = h.length, sar = new Array(n).fill(null), up = new Array(n).fill(null);
    if (n < 3) return { sar, up };
    let bull = h[1] + l[1] >= h[0] + l[0], af = step, ep = bull ? Math.max(h[0], h[1]) : Math.min(l[0], l[1]);
    let s = bull ? Math.min(l[0], l[1]) : Math.max(h[0], h[1]);
    for (let i = 2; i < n; i++) {
      s = s + af * (ep - s);
      if (bull) {
        s = Math.min(s, l[i - 1], l[i - 2]);
        if (l[i] < s) { bull = false; s = ep; ep = l[i]; af = step; }
        else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
      } else {
        s = Math.max(s, h[i - 1], h[i - 2]);
        if (h[i] > s) { bull = true; s = ep; ep = h[i]; af = step; }
        else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
      }
      sar[i] = s; up[i] = bull;
    }
    return { sar, up };
  }
  // Supertrend (ATR bands that only tighten in the trend direction)
  function supertrend(h, l, c, n = 10, mult = 3) {
    const a = atr(h, l, c, n), len = c.length;
    const line = new Array(len).fill(null), up = new Array(len).fill(null);
    let fu = null, fl = null, bull = true;
    for (let i = 0; i < len; i++) {
      if (a[i] == null) continue;
      const mid = (h[i] + l[i]) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i];
      fu = fu == null || bu < fu || c[i - 1] > fu ? bu : fu;
      fl = fl == null || bl > fl || c[i - 1] < fl ? bl : fl;
      if (bull && c[i] < fl) bull = false; else if (!bull && c[i] > fu) bull = true;
      line[i] = bull ? fl : fu; up[i] = bull;
    }
    return { line, up };
  }
  // Ichimoku: spans are returned unshifted; the caller plots spanA/spanB `disp` bars ahead and chikou `disp` back
  function ichimoku(h, l, c, conv = 9, base = 26, spanB = 52) {
    const mid = (n) => { const hh = highest(h, n), ll = lowest(l, n); return hh.map((x, i) => (x == null ? null : (x + ll[i]) / 2)); };
    const tenkan = mid(conv), kijun = mid(base);
    return { tenkan, kijun, spanA: tenkan.map((t, i) => (t == null || kijun[i] == null ? null : (t + kijun[i]) / 2)), spanB: mid(spanB), disp: base };
  }
  // VWAP anchored at index `from` (typical price × volume)
  function vwap(h, l, c, v, from = 0) {
    let pv = 0, vv = 0;
    return c.map((x, i) => { if (i < from) return null; const tp = (h[i] + l[i] + x) / 3; pv += tp * v[i]; vv += v[i]; return vv ? pv / vv : null; });
  }
  // classic floor pivots from one period's high / low / close
  function pivots(H, L, C) {
    const P = (H + L + C) / 3;
    return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + (H - L), S2: P - (H - L), R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
  }
  function heikinAshi(o, h, l, c) {
    const ho = [], hc = [], hh = [], hl = [];
    for (let i = 0; i < c.length; i++) {
      hc[i] = (o[i] + h[i] + l[i] + c[i]) / 4;
      ho[i] = i ? (ho[i - 1] + hc[i - 1]) / 2 : (o[i] + c[i]) / 2;
      hh[i] = Math.max(h[i], ho[i], hc[i]); hl[i] = Math.min(l[i], ho[i], hc[i]);
    }
    return { o: ho, h: hh, l: hl, c: hc };
  }
  // indices where a crosses above (+1) / below (−1) b
  function crosses(a, b) {
    const out = [];
    for (let i = 1; i < a.length; i++) {
      if ([a[i], b[i], a[i - 1], b[i - 1]].every(N)) {
        if (a[i - 1] <= b[i - 1] && a[i] > b[i]) out.push([i, 1]);
        else if (a[i - 1] >= b[i - 1] && a[i] < b[i]) out.push([i, -1]);
      }
    }
    return out;
  }
  // share of the last `n` values that are <= the last one (0..1)
  function percentile(x, n = 252) {
    const w = x.slice(-n).filter(N), last = w[w.length - 1];
    return w.length < 20 ? null : w.filter((v) => v <= last).length / w.length;
  }
  // aggregate daily bars into weeks (key = Monday) or months; time = first session of the period
  function resample(bars, unit) {
    if (unit === "D") return bars;
    const out = [];
    let key = null, cur = null;
    for (const b of bars) {
      const d = new Date(b.t + "T00:00:00Z");
      let k;
      if (unit === "W") { const m = new Date(d); m.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); k = m.toISOString().slice(0, 10); }
      else k = b.t.slice(0, 7);
      if (k !== key) { if (cur) out.push(cur); key = k; cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    }
    if (cur) out.push(cur);
    return out;
  }

  const TA = { sma, ema, rma, wma, hma, stdev, highest, lowest, trueRange, atr, rsi, macd, bollinger, keltner, donchian,
    stochastic, williamsR, cci, roc, obv, mfi, cmf, adx, psar, supertrend, ichimoku, vwap, pivots, heikinAshi, crosses,
    percentile, resample };
  if (typeof module !== "undefined" && module.exports) module.exports = TA;
  else root.TA = TA;
})(typeof window !== "undefined" ? window : globalThis);
