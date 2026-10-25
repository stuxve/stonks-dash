/* stonks-dash — more technical analysis: extra moving averages and overlays, non-time charts (Renko, Kagi, Line Break,
 * Point & Figure), seasonality, candlestick patterns, gaps and chart-pattern detection. Pure functions; extends window.TA
 * in the browser, or exports for Node tests (require after ta-ind.js). Arrays are oldest first; warm-up values are null. */
(function (root) {
  "use strict";
  const T = typeof module !== "undefined" && module.exports ? require("./ta-ind.js") : root.TA;
  const N = (x) => x != null && isFinite(x);
  const lin = (a, b, f) => a.map((v, i) => (N(v) && N(b[i]) ? f(v, b[i]) : null));

  // ---------------------------------------------------------------- moving averages
  function dema(x, n) { const e1 = T.ema(x, n), e2 = T.ema(e1, n); return lin(e1, e2, (a, b) => 2 * a - b); }
  function tema(x, n) {
    const e1 = T.ema(x, n), e2 = T.ema(e1, n), e3 = T.ema(e2, n);
    return e1.map((a, i) => (N(a) && N(e2[i]) && N(e3[i]) ? 3 * a - 3 * e2[i] + e3[i] : null));
  }
  // Kaufman's adaptive MA: efficiency ratio over `n` bars scales between a fast and a slow EMA constant
  function kama(x, n = 10, fast = 2, slow = 30) {
    const out = new Array(x.length).fill(null), fsc = 2 / (fast + 1), ssc = 2 / (slow + 1);
    if (x.length <= n) return out;
    let k = x[n - 1];
    out[n - 1] = k;
    for (let i = n; i < x.length; i++) {
      let vol = 0;
      for (let j = i - n + 1; j <= i; j++) vol += Math.abs(x[j] - x[j - 1]);
      const er = vol ? Math.abs(x[i] - x[i - n]) / vol : 0, sc = (er * (fsc - ssc) + ssc) ** 2;
      k += sc * (x[i] - k);
      out[i] = k;
    }
    return out;
  }
  // Bill Williams' Alligator: smoothed MAs of the median price, plotted `shift` bars ahead
  function alligator(h, l, jaw = 13, teeth = 8, lips = 5) {
    const m = h.map((v, i) => (v + l[i]) / 2);
    return { jaw: T.rma(m, jaw), teeth: T.rma(m, teeth), lips: T.rma(m, lips), shifts: [8, 5, 3] };
  }
  function envelopes(c, n = 20, pct = 2.5) {
    const mid = T.sma(c, n);
    return { mid, up: mid.map((m) => (m == null ? null : m * (1 + pct / 100))), lo: mid.map((m) => (m == null ? null : m * (1 - pct / 100))) };
  }

  // ---------------------------------------------------------------- stops
  // Chandelier exit (Le Beau): highest high − k·ATR for longs, lowest low + k·ATR for shorts
  function chandelier(h, l, c, n = 22, k = 3) {
    const a = T.atr(h, l, c, n), hh = T.highest(h, n), ll = T.lowest(l, n);
    return { long: hh.map((x, i) => (x == null || a[i] == null ? null : x - k * a[i])), short: ll.map((x, i) => (x == null || a[i] == null ? null : x + k * a[i])) };
  }
  // ATR trailing stop on closes: ratchets with the trend and flips when the close crosses it
  function atrTrail(h, l, c, n = 14, k = 3) {
    const a = T.atr(h, l, c, n), stop = new Array(c.length).fill(null), up = new Array(c.length).fill(null);
    for (let i = 1; i < c.length; i++) {
      if (a[i] == null) continue;
      const loss = k * a[i], p = stop[i - 1];
      if (p == null) { stop[i] = c[i] - loss; up[i] = true; continue; }
      if (c[i] > p && c[i - 1] > p) stop[i] = Math.max(p, c[i] - loss);
      else if (c[i] < p && c[i - 1] < p) stop[i] = Math.min(p, c[i] + loss);
      else stop[i] = c[i] > p ? c[i] - loss : c[i] + loss;
      up[i] = c[i] > stop[i];
    }
    return { stop, up };
  }

  // ---------------------------------------------------------------- linear regression
  // least squares on (index, value) over [a, b]; returns value(i) plus residual stdev and Raff width (max high/low distance)
  function linFit(y, a, b, h, l) {
    const n = b - a + 1;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = a; i <= b; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), icpt = (sy - slope * sx) / n;
    const at = (i) => icpt + slope * i;
    let ss = 0, raff = 0;
    for (let i = a; i <= b; i++) {
      ss += (y[i] - at(i)) ** 2;
      if (h && l) raff = Math.max(raff, h[i] - at(i), at(i) - l[i]);
    }
    return { slope, icpt, at, sd: Math.sqrt(ss / n), raff, r2: (() => { const m = sy / n; let st = 0; for (let i = a; i <= b; i++) st += (y[i] - m) ** 2; return st ? 1 - ss / st : 1; })() };
  }
  // rolling regression end-point (a.k.a. least-squares moving average / linear regression forecast)
  function linreg(x, n = 20) {
    return x.map((_, i) => (i < n - 1 ? null : linFit(x, i - n + 1, i).at(i)));
  }

  // ---------------------------------------------------------------- ZigZag
  // swing pivots that reverse by at least `pct` %, on highs / lows. The last pivot is provisional (may still move).
  function zigzag(h, l, pct = 5) {
    const th = pct / 100, piv = [];
    if (h.length < 2) return piv;
    let dir = 0, hiI = 0, loI = 0;
    for (let i = 1; i < h.length; i++) {
      if (dir === 0) {
        if (h[i] > h[hiI]) hiI = i;
        if (l[i] < l[loI]) loI = i;
        if (h[hiI] >= l[loI] * (1 + th) && loI < hiI) { piv.push({ i: loI, p: l[loI], k: "L" }); dir = 1; }
        else if (l[loI] <= h[hiI] * (1 - th) && hiI < loI) { piv.push({ i: hiI, p: h[hiI], k: "H" }); dir = -1; }
      } else if (dir === 1) {
        if (h[i] >= h[hiI]) hiI = i;
        else if (l[i] <= h[hiI] * (1 - th)) { piv.push({ i: hiI, p: h[hiI], k: "H" }); dir = -1; loI = i; }
      } else {
        if (l[i] <= l[loI]) loI = i;
        else if (h[i] >= l[loI] * (1 + th)) { piv.push({ i: loI, p: l[loI], k: "L" }); dir = 1; hiI = i; }
      }
    }
    if (dir === 1) piv.push({ i: hiI, p: h[hiI], k: "H", last: true });
    else if (dir === -1) piv.push({ i: loI, p: l[loI], k: "L", last: true });
    return piv;
  }

  // ---------------------------------------------------------------- volume by price
  function volumeByPrice(o, h, l, c, v, a, b, bins = 24) {
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i <= b; i++) { lo = Math.min(lo, l[i]); hi = Math.max(hi, h[i]); }
    if (!(hi > lo)) return null;
    const w = (hi - lo) / bins, out = Array.from({ length: bins }, (_, k) => ({ lo: lo + k * w, hi: lo + (k + 1) * w, up: 0, dn: 0 }));
    for (let i = a; i <= b; i++) {
      const k = Math.min(bins - 1, Math.max(0, Math.floor((c[i] - lo) / w)));
      if (c[i] >= o[i]) out[k].up += v[i]; else out[k].dn += v[i];
    }
    const poc = out.reduce((m, x, k) => (x.up + x.dn > out[m].up + out[m].dn ? k : m), 0);
    return { bins: out, poc, lo, hi };
  }

  // ---------------------------------------------------------------- non-time charts (on closes unless noted)
  // Renko: a new brick each time the close moves a full box beyond the last brick; reversals need two boxes
  function renko(c, t, box) {
    const out = [];
    if (!(box > 0) || !c.length) return out;
    let top = c[0], bot = c[0];
    for (let i = 1; i < c.length; i++) {
      if (c[i] >= top + box) {
        while (c[i] >= top + box) { out.push({ i, t: t[i], o: top, c: top + box, up: true }); top += box; }
        bot = top - box;
      } else if (c[i] <= bot - box) {
        while (c[i] <= bot - box) { out.push({ i, t: t[i], o: bot, c: bot - box, up: false }); bot -= box; }
        top = bot + box;
      }
    }
    return out;
  }
  // Three Line Break: continue on a new closing high / low; reverse only past the extreme of the last `n` lines
  function lineBreak(c, t, n = 3) {
    const out = [];
    let i0 = 1;
    while (i0 < c.length && c[i0] === c[0]) i0++;
    if (i0 >= c.length) return out;
    out.push({ i: i0, t: t[i0], o: c[0], c: c[i0], up: c[i0] > c[0] });
    for (let i = i0 + 1; i < c.length; i++) {
      const last = out[out.length - 1], recent = out.slice(-n);
      const hi = Math.max(...recent.map((x) => Math.max(x.o, x.c))), lo = Math.min(...recent.map((x) => Math.min(x.o, x.c)));
      if (last.up) {
        if (c[i] > last.c) out.push({ i, t: t[i], o: last.c, c: c[i], up: true });
        else if (c[i] < lo) out.push({ i, t: t[i], o: last.o, c: c[i], up: false });
      } else {
        if (c[i] < last.c) out.push({ i, t: t[i], o: last.c, c: c[i], up: false });
        else if (c[i] > hi) out.push({ i, t: t[i], o: last.o, c: c[i], up: true });
      }
    }
    return out;
  }
  // Kagi: the line changes direction after a reversal of `rev`; it turns thick (yang) above the previous shoulder and
  // thin (yin) below the previous waist. Returns columns with vertical segments {y1, y2, thick}.
  function kagi(c, t, rev) {
    const cols = [];
    if (!(rev > 0) || c.length < 2) return cols;
    let dir = 0, cur = { from: c[0], to: c[0], i: 0, t: t[0] };
    for (let i = 1; i < c.length; i++) {
      if (dir === 0) {
        if (Math.abs(c[i] - c[0]) >= rev) { dir = c[i] > c[0] ? 1 : -1; cur.to = c[i]; cur.i = i; cur.t = t[i]; cols.push(cur); }
      } else if (dir === 1) {
        if (c[i] > cur.to) { cur.to = c[i]; cur.i = i; cur.t = t[i]; }
        else if (cur.to - c[i] >= rev) { cur = { from: cur.to, to: c[i], i, t: t[i] }; cols.push(cur); dir = -1; }
      } else {
        if (c[i] < cur.to) { cur.to = c[i]; cur.i = i; cur.t = t[i]; }
        else if (c[i] - cur.to >= rev) { cur = { from: cur.to, to: c[i], i, t: t[i] }; cols.push(cur); dir = 1; }
      }
    }
    let thick = cols.length ? cols[0].to > cols[0].from : true, shoulder = null, waist = null;
    for (const col of cols) {
      const up = col.to > col.from;
      col.up = up;
      if (up && !thick && shoulder != null && col.to > shoulder) { col.seg = [{ y1: col.from, y2: shoulder, thick: false }, { y1: shoulder, y2: col.to, thick: true }]; thick = true; }
      else if (!up && thick && waist != null && col.to < waist) { col.seg = [{ y1: col.from, y2: waist, thick: true }, { y1: waist, y2: col.to, thick: false }]; thick = false; }
      else col.seg = [{ y1: col.from, y2: col.to, thick }];
      if (up) shoulder = col.to; else waist = col.to;
    }
    return cols;
  }
  // Point & Figure on highs/lows. Boxes are arithmetic (`box` in price) or logarithmic (`pct` %). `rev` boxes to reverse.
  // Signals: double / triple top breakouts and bottom breakdowns, with a vertical-count price objective.
  function pnf(h, l, t, { box, pct, rev = 3 }) {
    const logm = pct > 0, step = logm ? Math.log(1 + pct / 100) : box, base = logm ? Math.min(...l.filter((x) => x > 0)) : 0;
    if (!(step > 0) || !h.length) return null;
    const idx = (p) => (logm ? Math.log(p / base) / step : p / step);
    const level = (k) => (logm ? base * Math.exp(k * step) : k * step);
    const upK = (p) => Math.floor(idx(p) + 1e-9), dnK = (p) => Math.ceil(idx(p) - 1e-9);
    const cols = [], signals = [];
    let start = upK((h[0] + l[0]) / 2), col = null;
    const sameTypePrev = (k) => { let n = 0; for (let j = cols.length - 2; j >= 0; j--) if (cols[j].type === cols[cols.length - 1].type && ++n === k) return cols[j]; return null; };
    const check = (i) => {
      const cur = cols[cols.length - 1], p1 = sameTypePrev(1), p2 = sameTypePrev(2);
      if (!p1) return;
      if (cur.type === "X" && cur.top > p1.top && !cur.sig) {
        const triple = p2 && p2.top === p1.top;
        cur.sig = { type: triple ? "Triple top breakout" : "Double top breakout", dir: 1, i, t: t[i], level: level(p1.top + 1), col: cols.length - 1 };
        signals.push(cur.sig);
      } else if (cur.type === "O" && cur.bot < p1.bot && !cur.sig) {
        const triple = p2 && p2.bot === p1.bot;
        cur.sig = { type: triple ? "Triple bottom breakdown" : "Double bottom breakdown", dir: -1, i, t: t[i], level: level(p1.bot - 1), col: cols.length - 1 };
        signals.push(cur.sig);
      }
    };
    for (let i = 0; i < h.length; i++) {
      if (!col) {
        const hk = upK(h[i]), lk = dnK(l[i]);
        if (hk - start >= rev) { col = { type: "X", bot: start, top: hk, i0: i, i1: i, t0: t[i] }; cols.push(col); }
        else if (start - lk >= rev) { col = { type: "O", top: start, bot: lk, i0: i, i1: i, t0: t[i] }; cols.push(col); }
        continue;
      }
      if (col.type === "X") {
        const hk = upK(h[i]);
        if (hk > col.top) { col.top = hk; col.i1 = i; check(i); }
        else { const lk = dnK(l[i]); if (col.top - lk >= rev) { col = { type: "O", top: col.top - 1, bot: lk, i0: i, i1: i, t0: t[i] }; cols.push(col); check(i); } }
      } else {
        const lk = dnK(l[i]);
        if (lk < col.bot) { col.bot = lk; col.i1 = i; check(i); }
        else { const hk = upK(h[i]); if (hk - col.bot >= rev) { col = { type: "X", bot: col.bot + 1, top: hk, i0: i, i1: i, t0: t[i] }; cols.push(col); check(i); } }
      }
    }
    // vertical count for the last signal: length of the first column off the swing extreme × reversal
    const last = signals[signals.length - 1];
    let objective = null;
    if (last) {
      const win = cols.slice(Math.max(0, last.col - 6), last.col + 1);
      if (last.dir > 0) {
        const lowest = win.filter((x) => x.type === "O").reduce((m, x) => (!m || x.bot < m.bot ? x : m), null);
        const k = lowest ? cols.indexOf(lowest) + 1 : -1, first = cols[k];
        if (first && first.type === "X") objective = { level: level(first.bot + (first.top - first.bot + 1) * rev), from: cols.indexOf(first) };
      } else {
        const highest = win.filter((x) => x.type === "X").reduce((m, x) => (!m || x.top > m.top ? x : m), null);
        const k = highest ? cols.indexOf(highest) + 1 : -1, first = cols[k];
        if (first && first.type === "O") objective = { level: level(first.top - (first.top - first.bot + 1) * rev), from: cols.indexOf(first) };
      }
    }
    return { cols, signals, objective, level, step, logm };
  }
  // a "nice" round box size near x (1, 2, 2.5, 5 × 10^k)
  function niceBox(x) {
    if (!(x > 0)) return 1;
    const e = 10 ** Math.floor(Math.log10(x)), m = x / e;
    return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.75 ? 2.5 : m < 7.5 ? 5 : 10) * e;
  }

  // ---------------------------------------------------------------- seasonality (from daily bars {t, c})
  function seasonality(bars) {
    const lastOfMonth = new Map();
    for (const b of bars) lastOfMonth.set(b.t.slice(0, 7), b.c);
    const keys = [...lastOfMonth.keys()].sort(), years = {};
    for (let k = 1; k < keys.length; k++) {
      const [y, m] = keys[k].split("-").map(Number), r = lastOfMonth.get(keys[k]) / lastOfMonth.get(keys[k - 1]) - 1;
      (years[y] = years[y] || {})[m] = r;
    }
    const months = Array.from({ length: 12 }, (_, k) => {
      const r = Object.values(years).map((y) => y[k + 1]).filter(N).sort((a, b) => a - b);
      return { m: k + 1, n: r.length, avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null,
        med: r.length ? (r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2) : null,
        up: r.length ? r.filter((x) => x > 0).length / r.length : null, best: r.length ? r[r.length - 1] : null, worst: r.length ? r[0] : null };
    });
    return { years, months };
  }

  // ---------------------------------------------------------------- Elder impulse: EMA(13) slope and MACD-histogram slope agree
  function elderImpulse(c, n = 13) {
    const e = T.ema(c, n), hst = T.macd(c, 12, 26, 9).hist;
    return c.map((_, i) => (i && N(e[i - 1]) && N(hst[i - 1]) ? (e[i] > e[i - 1] && hst[i] > hst[i - 1] ? 1 : e[i] < e[i - 1] && hst[i] < hst[i - 1] ? -1 : 0) : null));
  }

  // ---------------------------------------------------------------- gaps
  // up gap: today's low above yesterday's high; filled when a later low comes back to yesterday's high (mirror for down)
  function gaps(h, l, c, minPct = 0.5) {
    const out = [];
    for (let i = 1; i < h.length; i++) {
      let g = null;
      if (l[i] > h[i - 1] && (l[i] / h[i - 1] - 1) * 100 >= minPct) g = { i, dir: 1, top: l[i], bot: h[i - 1] };
      else if (h[i] < l[i - 1] && (1 - h[i] / l[i - 1]) * 100 >= minPct) g = { i, dir: -1, top: l[i - 1], bot: h[i] };
      if (!g) continue;
      g.size = g.top / g.bot - 1;
      g.filled = null;
      for (let j = i + 1; j < h.length; j++) {
        if ((g.dir > 0 && l[j] <= g.bot) || (g.dir < 0 && h[j] >= g.top)) { g.filled = j; break; }
      }
      out.push(g);
    }
    return out;
  }

  // ---------------------------------------------------------------- candlestick patterns
  // Shape rules follow the common definitions (Nison / StockCharts). Trend context: close vs its 10-bar SMA on the bar
  // before the pattern. kind: R = reversal, C = continuation, I = indecision; dir: 1 bullish, −1 bearish, 0 neutral.
  function candles(o, h, l, c) {
    const n = c.length, out = [];
    const sma10 = T.sma(c, 10), body = c.map((x, i) => Math.abs(x - o[i])), rng = h.map((x, i) => x - l[i]);
    const avgB = T.sma(body, 14), avgR = T.sma(rng, 14);
    const top = (i) => Math.max(o[i], c[i]), bot = (i) => Math.min(o[i], c[i]);
    const upper = (i) => h[i] - top(i), lower = (i) => bot(i) - l[i];
    const white = (i) => c[i] > o[i], black = (i) => c[i] < o[i];
    const doji = (i) => rng[i] > 0 && body[i] <= 0.1 * rng[i];
    const long = (i, j) => body[i] >= (avgB[j] || 0) * 1.0 && body[i] >= 0.5 * rng[i];
    const small = (i, j) => body[i] <= (avgB[j] || 0) * 0.5;
    const down = (i) => i >= 0 && sma10[i] != null && c[i] < sma10[i], up = (i) => i >= 0 && sma10[i] != null && c[i] > sma10[i];
    const mid = (i) => (o[i] + c[i]) / 2;
    const add = (i, name, dir, kind, bars) => out.push({ i, name, dir, kind, bars });
    for (let i = 15; i < n; i++) {
      const p = i - 1, q = i - 2, ref = i - 1;
      if (!(rng[i] > 0) || avgB[ref] == null) continue;
      // ---- single bar
      if (doji(i)) {
        if (upper(i) <= 0.1 * rng[i] && lower(i) >= 0.6 * rng[i]) add(i, "Dragonfly doji", down(p) ? 1 : 0, down(p) ? "R" : "I", 1);
        else if (lower(i) <= 0.1 * rng[i] && upper(i) >= 0.6 * rng[i]) add(i, "Gravestone doji", up(p) ? -1 : 0, up(p) ? "R" : "I", 1);
        else if (upper(i) >= 0.3 * rng[i] && lower(i) >= 0.3 * rng[i] && rng[i] >= 1.3 * avgR[ref]) add(i, "Long-legged doji", 0, "I", 1);
        else add(i, "Doji", 0, "I", 1);
      } else {
        const b = body[i];
        if (lower(i) >= 2 * b && upper(i) <= Math.max(0.25 * b, 0.1 * rng[i])) {
          if (down(p)) add(i, "Hammer", 1, "R", 1); else if (up(p)) add(i, "Hanging man", -1, "R", 1);
        } else if (upper(i) >= 2 * b && lower(i) <= Math.max(0.25 * b, 0.1 * rng[i])) {
          if (down(p)) add(i, "Inverted hammer", 1, "R", 1); else if (up(p)) add(i, "Shooting star", -1, "R", 1);
        } else if (b >= 0.95 * rng[i] && b >= avgB[ref]) add(i, white(i) ? "Bullish marubozu" : "Bearish marubozu", white(i) ? 1 : -1, "C", 1);
        else if (b <= 0.3 * rng[i] && upper(i) > b && lower(i) > b) add(i, "Spinning top", 0, "I", 1);
        if (white(i) && down(p) && lower(i) <= 0.02 * rng[i] && long(i, ref) && o[i] < c[p]) add(i, "Bullish belt hold", 1, "R", 1);
        if (black(i) && up(p) && upper(i) <= 0.02 * rng[i] && long(i, ref) && o[i] > c[p]) add(i, "Bearish belt hold", -1, "R", 1);
      }
      // ---- two bars
      if (black(p) && white(i) && down(q) && o[i] <= c[p] && c[i] >= o[p] && body[i] > body[p]) add(i, "Bullish engulfing", 1, "R", 2);
      if (white(p) && black(i) && up(q) && o[i] >= c[p] && c[i] <= o[p] && body[i] > body[p]) add(i, "Bearish engulfing", -1, "R", 2);
      if (black(p) && long(p, ref) && down(q) && top(i) <= o[p] && bot(i) >= c[p] && body[i] < body[p]) {
        if (doji(i)) add(i, "Bullish harami cross", 1, "R", 2); else if (white(i)) add(i, "Bullish harami", 1, "R", 2);
      }
      if (white(p) && long(p, ref) && up(q) && top(i) <= c[p] && bot(i) >= o[p] && body[i] < body[p]) {
        if (doji(i)) add(i, "Bearish harami cross", -1, "R", 2); else if (black(i)) add(i, "Bearish harami", -1, "R", 2);
      }
      if (down(q) && black(p) && long(p, ref) && white(i) && o[i] < c[p] && c[i] > mid(p) && c[i] < o[p]) add(i, "Piercing line", 1, "R", 2);
      if (up(q) && white(p) && long(p, ref) && black(i) && o[i] > c[p] && c[i] < mid(p) && c[i] > o[p]) add(i, "Dark cloud cover", -1, "R", 2);
      const tw = 0.05 * (avgR[ref] || rng[i]);
      if (down(q) && black(p) && white(i) && Math.abs(l[i] - l[p]) <= tw) add(i, "Tweezer bottom", 1, "R", 2);
      if (up(q) && white(p) && black(i) && Math.abs(h[i] - h[p]) <= tw) add(i, "Tweezer top", -1, "R", 2);
      if (black(p) && white(i) && o[i] > o[p] && long(p, ref) && long(i, ref)) add(i, "Bullish kicker", 1, "R", 2);
      if (white(p) && black(i) && o[i] < o[p] && long(p, ref) && long(i, ref)) add(i, "Bearish kicker", -1, "R", 2);
      if (l[i] > h[p]) add(i, "Rising window", 1, "C", 2);
      if (h[i] < l[p]) add(i, "Falling window", -1, "C", 2);
      // ---- three bars
      if (i >= 17) {
        const r3 = i - 3;
        if (down(r3) && black(q) && long(q, ref) && small(p, ref) && top(p) < c[q] && white(i) && c[i] > mid(q)) {
          if (doji(p) && h[p] < l[q] && l[i] > h[p]) add(i, "Abandoned baby (bullish)", 1, "R", 3);
          else add(i, doji(p) ? "Morning doji star" : "Morning star", 1, "R", 3);
        }
        if (up(r3) && white(q) && long(q, ref) && small(p, ref) && bot(p) > c[q] && black(i) && c[i] < mid(q)) {
          if (doji(p) && l[p] > h[q] && h[i] < l[p]) add(i, "Abandoned baby (bearish)", -1, "R", 3);
          else add(i, doji(p) ? "Evening doji star" : "Evening star", -1, "R", 3);
        }
        const soldier = (k) => white(k) && long(k, ref) && upper(k) <= 0.25 * body[k];
        if (soldier(q) && soldier(p) && soldier(i) && c[p] > c[q] && c[i] > c[p] && o[p] > o[q] && o[p] < c[q] && o[i] > o[p] && o[i] < c[p]) add(i, "Three white soldiers", 1, "R", 3);
        const crow = (k) => black(k) && long(k, ref) && lower(k) <= 0.25 * body[k];
        if (crow(q) && crow(p) && crow(i) && c[p] < c[q] && c[i] < c[p] && o[p] < o[q] && o[p] > c[q] && o[i] < o[p] && o[i] > c[p]) add(i, "Three black crows", -1, "R", 3);
        if (down(r3) && black(q) && long(q, ref) && white(p) && top(p) <= o[q] && bot(p) >= c[q] && c[i] > o[q]) add(i, "Three inside up", 1, "R", 3);
        if (up(r3) && white(q) && long(q, ref) && black(p) && top(p) <= c[q] && bot(p) >= o[q] && c[i] < o[q]) add(i, "Three inside down", -1, "R", 3);
        if (down(r3) && black(q) && white(p) && o[p] <= c[q] && c[p] >= o[q] && c[i] > c[p]) add(i, "Three outside up", 1, "R", 3);
        if (up(r3) && white(q) && black(p) && o[p] >= c[q] && c[p] <= o[q] && c[i] < c[p]) add(i, "Three outside down", -1, "R", 3);
        if (white(q) && white(p) && l[p] > h[q] && black(i) && o[i] < c[p] && o[i] > o[p] && c[i] < o[p] && c[i] > h[q]) add(i, "Upside tasuki gap", 1, "C", 3);
        if (black(q) && black(p) && h[p] < l[q] && white(i) && o[i] > c[p] && o[i] < o[p] && c[i] > o[p] && c[i] < l[q]) add(i, "Downside tasuki gap", -1, "C", 3);
      }
      // ---- five bars: rising / falling three methods
      if (i >= 19) {
        const f = i - 4;
        const inside = [f + 1, f + 2, f + 3].every((k) => small(k, ref) && h[k] <= h[f] && l[k] >= l[f]);
        if (white(f) && long(f, ref) && inside && white(i) && long(i, ref) && c[i] > c[f]) add(i, "Rising three methods", 1, "C", 5);
        if (black(f) && long(f, ref) && inside && black(i) && long(i, ref) && c[i] < c[f]) add(i, "Falling three methods", -1, "C", 5);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- chart patterns (from ZigZag pivots)
  // Heuristic detection: double/triple tops & bottoms, head & shoulders (and inverse), triangles, wedges, rectangles,
  // and bull/bear flags & pennants. A pattern is "confirmed" once a close breaks its neckline / boundary.
  function chartPatterns(o, h, l, c, opts = {}) {
    const n = c.length, a = T.atr(h, l, c, 14);
    const atrPct = a.map((x, i) => (x == null ? null : x / c[i])).filter(N);
    const med = atrPct.length ? atrPct.slice().sort((x, y) => x - y)[Math.floor(atrPct.length / 2)] : 0.02;
    const pct = opts.pct > 0 ? opts.pct : Math.min(15, Math.max(3, Math.round(med * 100 * 3)));
    const piv = zigzag(h, l, pct), tol = Math.max(0.015, (pct / 100) * 0.45);
    const eq = (x, y, t = tol) => Math.abs(x - y) / ((x + y) / 2) <= t;
    const out = [];
    const firstClose = (from, test) => { for (let j = from; j < n; j++) if (test(j)) return j; return null; };
    for (let k = 0; k + 2 < piv.length; k++) {
      const [A, B, Cp] = [piv[k], piv[k + 1], piv[k + 2]];
      // head & shoulders (5 pivots)
      if (k + 4 < piv.length) {
        const [P1, P2, P3, P4, P5] = piv.slice(k, k + 5);
        const line = (x) => P2.p + ((P4.p - P2.p) / (P4.i - P2.i)) * (x - P2.i);
        if (P1.k === "H" && P3.p > Math.max(P1.p, P5.p) * (1 + tol) && eq(P1.p, P5.p, tol * 1.6) && Math.abs(P2.p - P4.p) / P3.p < tol * 2) {
          const brk = firstClose(P5.i + 1, (j) => c[j] < line(j));
          out.push({ type: "Head and shoulders", dir: -1, pts: [P1, P2, P3, P4, P5], lines: [[P2.i, P2.p, brk ?? n - 1, line(brk ?? n - 1)]], brk, target: brk != null ? line(brk) - (P3.p - line(P3.i)) : null, end: P5.i });
          k += 3; continue;
        }
        if (P1.k === "L" && P3.p < Math.min(P1.p, P5.p) * (1 - tol) && eq(P1.p, P5.p, tol * 1.6) && Math.abs(P2.p - P4.p) / P3.p < tol * 2) {
          const brk = firstClose(P5.i + 1, (j) => c[j] > line(j));
          out.push({ type: "Inverse head and shoulders", dir: 1, pts: [P1, P2, P3, P4, P5], lines: [[P2.i, P2.p, brk ?? n - 1, line(brk ?? n - 1)]], brk, target: brk != null ? line(brk) + (line(P3.i) - P3.p) : null, end: P5.i });
          k += 3; continue;
        }
        // triple top / bottom
        if (P1.k === "H" && eq(P1.p, P3.p) && eq(P3.p, P5.p) && eq(P1.p, P5.p)) {
          const neck = Math.min(P2.p, P4.p), brk = firstClose(P5.i + 1, (j) => c[j] < neck);
          out.push({ type: "Triple top", dir: -1, pts: [P1, P2, P3, P4, P5], lines: [[P2.i, neck, brk ?? n - 1, neck]], brk, target: brk != null ? neck - (Math.max(P1.p, P3.p, P5.p) - neck) : null, end: P5.i });
          k += 3; continue;
        }
        if (P1.k === "L" && eq(P1.p, P3.p) && eq(P3.p, P5.p) && eq(P1.p, P5.p)) {
          const neck = Math.max(P2.p, P4.p), brk = firstClose(P5.i + 1, (j) => c[j] > neck);
          out.push({ type: "Triple bottom", dir: 1, pts: [P1, P2, P3, P4, P5], lines: [[P2.i, neck, brk ?? n - 1, neck]], brk, target: brk != null ? neck + (neck - Math.min(P1.p, P3.p, P5.p)) : null, end: P5.i });
          k += 3; continue;
        }
        // triangles / wedges / rectangles from 5 alternating pivots
        const pts = piv.slice(k, k + 5), hs = pts.filter((x) => x.k === "H"), ls = pts.filter((x) => x.k === "L");
        if (hs.length >= 2 && ls.length >= 2) {
          const fit = (ps) => { const m = ps.length, sx = ps.reduce((s, x) => s + x.i, 0), sy = ps.reduce((s, x) => s + x.p, 0), sxy = ps.reduce((s, x) => s + x.i * x.p, 0), sxx = ps.reduce((s, x) => s + x.i * x.i, 0); const b = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1); return { b, a: (sy - b * sx) / m, at(i) { return this.a + this.b * i; } }; };
          const U = fit(hs), Lo = fit(ls), i0 = pts[0].i, i1 = pts[4].i, span = i1 - i0, pm = (U.at(i1) + Lo.at(i1)) / 2;
          const chU = (U.at(i1) - U.at(i0)) / pm, chL = (Lo.at(i1) - Lo.at(i0)) / pm;
          const w0 = U.at(i0) - Lo.at(i0), w1 = U.at(i1) - Lo.at(i1);
          const fitOk = hs.every((x) => Math.abs(x.p - U.at(x.i)) / pm < tol) && ls.every((x) => Math.abs(x.p - Lo.at(x.i)) / pm < tol);
          if (fitOk && w1 > 0 && span >= 15) {
            const flat = (x) => Math.abs(x) < tol, conv = w1 < w0 * 0.8;
            let type = null, dir = 0;
            if (flat(chU) && chL > tol && conv) { type = "Ascending triangle"; dir = 1; }
            else if (flat(chL) && chU < -tol && conv) { type = "Descending triangle"; dir = -1; }
            else if (chU < -tol && chL > tol && conv) type = "Symmetrical triangle";
            else if (chU > tol && chL > tol && conv && chL > chU) { type = "Rising wedge"; dir = -1; }
            else if (chU < -tol && chL < -tol && conv && chL > chU) { type = "Falling wedge"; dir = 1; }
            else if (flat(chU) && flat(chL)) type = "Rectangle";
            if (type) {
              const brk = firstClose(i1 + 1, (j) => c[j] > U.at(j) || c[j] < Lo.at(j));
              const bdir = brk == null ? dir : c[brk] > U.at(brk) ? 1 : -1;
              const e = brk ?? Math.min(n - 1, i1 + Math.round(span / 3));
              out.push({ type, dir: bdir, pts, lines: [[i0, U.at(i0), e, U.at(e)], [i0, Lo.at(i0), e, Lo.at(e)]], brk,
                target: brk != null ? (bdir > 0 ? c[brk] + w0 : c[brk] - w0) : null, end: i1 });
              k += 3; continue;
            }
          }
        }
      }
      // double top / bottom (3 pivots)
      if (A.k === "H" && eq(A.p, Cp.p) && Cp.i - A.i >= 8 && (Math.min(A.p, Cp.p) - B.p) / B.p >= pct / 100) {
        const brk = firstClose(Cp.i + 1, (j) => c[j] < B.p);
        out.push({ type: "Double top", dir: -1, pts: [A, B, Cp], lines: [[B.i, B.p, brk ?? n - 1, B.p]], brk, target: brk != null ? B.p - (Math.max(A.p, Cp.p) - B.p) : null, end: Cp.i });
      } else if (A.k === "L" && eq(A.p, Cp.p) && Cp.i - A.i >= 8 && (B.p - Math.max(A.p, Cp.p)) / B.p >= pct / 100) {
        const brk = firstClose(Cp.i + 1, (j) => c[j] > B.p);
        out.push({ type: "Double bottom", dir: 1, pts: [A, B, Cp], lines: [[B.i, B.p, brk ?? n - 1, B.p]], brk, target: brk != null ? B.p + (B.p - Math.min(A.p, Cp.p)) : null, end: Cp.i });
      }
    }
    // flags & pennants: a sharp pole (≥ 4 ATR in ≤ 15 bars) then a tight 5–25 bar pause that holds ≥ half the pole
    for (let e = 20; e < n - 5; e++) {
      if (a[e] == null) continue;
      for (const dir of [1, -1]) {
        const ext = dir > 0 ? h[e] : l[e];
        let s0 = e, best = 0;
        for (let s = Math.max(0, e - 15); s < e; s++) { const mv = dir > 0 ? ext - l[s] : h[s] - ext; if (mv > best) { best = mv; s0 = s; } }
        if (best < 4 * a[e]) continue;
        if (dir > 0 ? h[e] < Math.max(...h.slice(e - 3, Math.min(n, e + 4))) : l[e] > Math.min(...l.slice(e - 3, Math.min(n, e + 4)))) continue;   // pole must end at a local extreme
        let j = e + 1, brk = null;
        for (; j < Math.min(n, e + 26); j++) {
          if (dir > 0 ? c[j] > ext : c[j] < ext) { brk = j; break; }
          if (dir > 0 ? l[j] < ext - best * 0.5 : h[j] > ext + best * 0.5) { j = -1; break; }
        }
        if (j < 0) continue;
        const z = (brk ?? j) - 1;
        if (z - e < 5) continue;
        const seg = []; for (let x = e + 1; x <= z; x++) seg.push(x);
        const fitS = (ys) => { const m = seg.length, sx = seg.reduce((s, x) => s + x, 0), sy = seg.reduce((s, x, q) => s + ys[q], 0), sxy = seg.reduce((s, x, q) => s + x * ys[q], 0), sxx = seg.reduce((s, x) => s + x * x, 0); const b = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1); return { b, a: (sy - b * sx) / m }; };
        const U = fitS(seg.map((x) => h[x])), Lw = fitS(seg.map((x) => l[x]));
        const at = (f, x) => f.a + f.b * x, w0 = at(U, e + 1) - at(Lw, e + 1), w1 = at(U, z) - at(Lw, z);
        let type = null;
        if (w1 < w0 * 0.6 && w1 > 0) type = dir > 0 ? "Bull pennant" : "Bear pennant";
        else if (Math.sign(U.b) === -dir && Math.sign(Lw.b) === -dir) type = dir > 0 ? "Bull flag" : "Bear flag";
        if (!type) continue;
        out.push({ type, dir, pts: [{ i: s0, p: dir > 0 ? l[s0] : h[s0] }, { i: e, p: ext }], lines: [[e + 1, at(U, e + 1), z, at(U, z)], [e + 1, at(Lw, e + 1), z, at(Lw, z)]],
          brk, target: brk != null ? c[brk] + dir * best : null, end: z });
        e = z;   // don't report overlapping flags
        break;
      }
    }
    out.sort((x, y) => x.end - y.end);
    return { patterns: out, pct, pivots: piv };
  }

  const EXT = { dema, tema, kama, alligator, envelopes, chandelier, atrTrail, linFit, linreg, zigzag, volumeByPrice,
    renko, lineBreak, kagi, pnf, niceBox, seasonality, elderImpulse, gaps, candles, chartPatterns };
  if (typeof module !== "undefined" && module.exports) module.exports = Object.assign({}, T, EXT);
  else Object.assign(root.TA, EXT);
})(typeof window !== "undefined" ? window : globalThis);
