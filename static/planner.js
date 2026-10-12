/* stonks-dash — contribution planner.
 *
 * Goal: reach a total amount of money invested, ending as close as possible to the target % of each bucket,
 * buying only (no sales), with as few orders as possible (ideally ONE per month, to save fixed fees).
 *
 * 1. Water-filling: find how much each bucket still needs. Buckets already above their share at the goal
 *    are left alone (no selling); the rest are filled so they end at the same "virtual" level F:
 *        sum_i max(0, w_i * F - c_i) = goal - invested_now
 * 2. Whole-order rounding: the money is cut into equal orders (monthly / orders-per-month). Each bucket gets
 *    round(gap / order) orders using largest remainders, so every order goes to a single asset.
 *    The rounding error per bucket is at most half an order.
 * 3. Sequencing: each order goes to the bucket that is furthest below its target at that moment (among
 *    those with orders left), so the portfolio stays balanced along the way, not only at the end.
 */
(function (root) {
  "use strict";
  const sum = (a) => a.reduce((s, x) => s + x, 0);

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  function waterFill(cur, w, need) {
    const keys = Object.keys(w);
    const f = (F) => sum(keys.map((k) => Math.max(0, w[k] * F - (cur[k] || 0))));
    let lo = 0, hi = 1;
    while (f(hi) < need) hi *= 2;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < need) lo = mid; else hi = mid;
    }
    const gap = {};
    keys.forEach((k) => { gap[k] = Math.max(0, w[k] * hi - (cur[k] || 0)); });
    const s = sum(Object.values(gap));
    if (s > 0) keys.forEach((k) => { gap[k] *= need / s; });
    return { F: hi, gap };
  }

  function maxDrift(c, C, w) {
    let m = 0;
    for (const k of Object.keys(w)) m = Math.max(m, Math.abs((c[k] || 0) / C - w[k]) * 100);
    return m;
  }

  /**
   * @param {object} o
   * @param {Object<string,number>} o.current   invested money per bucket (all buckets, targeted or not)
   * @param {Object<string,number>} o.targets   target % per bucket (only these receive money)
   * @param {number} o.goal                     total money invested to reach
   * @param {number} o.monthly                  money available per month
   * @param {number} [o.perMonth=1]             max orders per month
   * @param {Date}   [o.start]                  first month
   */
  function plan({ current, targets, goal, monthly, perMonth = 1, start = new Date(), limitMonths = 1200, onlyFirst = false }) {
    const keys = Object.keys(targets).filter((k) => targets[k] > 0);
    if (!keys.length) return { error: "no-targets" };
    if (!(monthly > 0)) return { error: "no-monthly" };
    const sumT = sum(keys.map((k) => targets[k]));
    const w = Object.fromEntries(keys.map((k) => [k, targets[k] / sumT]));
    const cur = { ...current };
    keys.forEach((k) => { cur[k] = cur[k] || 0; });
    const C0 = sum(Object.values(cur));
    const need = goal - C0;
    const untargeted = Object.keys(cur).filter((k) => !(k in w) && cur[k] > 0);
    if (!(need > 0.005)) return { reached: true, invested: C0, goal, months: [], final: finalRows(cur, C0, w, untargeted) };

    const { F, gap } = waterFill(cur, w, need);
    const k = Math.max(1, Math.floor(perMonth));
    const slot = monthly / k;
    const nSlots = Math.ceil(need / slot - 1e-9);
    const monthsNeeded = Math.ceil(need / monthly - 1e-9);
    const limit = onlyFirst ? 1 : limitMonths;   // very long plans are sequenced only up to `limitMonths`

    // whole orders per bucket (largest remainder)
    const raw = keys.map((b) => ({ b, x: gap[b] / slot }));
    const slots = Object.fromEntries(raw.map((r) => [r.b, Math.floor(r.x)]));
    let left = nSlots - sum(Object.values(slots));
    raw.sort((a, c) => (c.x - Math.floor(c.x)) - (a.x - Math.floor(a.x)) || gap[c.b] - gap[a.b]);
    for (let i = 0; left > 0; i = (i + 1) % raw.length) { slots[raw[i].b] += 1; left -= 1; }

    // sequencing
    const c = { ...cur };
    let C = C0, remaining = need;
    const months = [];
    for (let m = 0; remaining > 0.005 && m < limit; m++) {
      const orders = new Map();
      for (let j = 0; j < k && remaining > 0.005; j++) {
        const amt = Math.min(slot, remaining);
        let cands = keys.filter((b) => slots[b] > 0);
        const fresh = cands.filter((b) => !orders.has(b));
        if (fresh.length) cands = fresh;   // spread a month's orders over different assets
        cands.sort((a, b) => (w[b] * (C + amt) - c[b]) - (w[a] * (C + amt) - c[a]) || slots[b] - slots[a]);
        const pick = cands[0];
        slots[pick] -= 1;
        c[pick] += amt;
        C += amt;
        remaining -= amt;
        orders.set(pick, (orders.get(pick) || 0) + amt);
      }
      months.push({ index: m, date: addMonths(start, m), orders: [...orders].map(([b, amount]) => ({ bucket: b, amount })),
        amount: sum([...orders.values()]), invested: C, drift: maxDrift(c, C, w) });
    }
    const truncated = remaining > 0.005;
    const nOrders = sum(months.map((x) => x.orders.length));
    const fed = keys.filter((b) => gap[b] > 0.005);
    return {
      goal, invested: C0, need, F, months, truncated,
      months_needed: monthsNeeded,
      goal_date: addMonths(start, monthsNeeded - 1),
      orders: truncated ? nSlots : nOrders,           // one order per slot (a month never repeats an asset)
      naive_orders: monthsNeeded * fed.length,        // splitting every month across every underweight bucket
      final: finalRows(c, C, w, untargeted),
      final_drift: maxDrift(c, C, w),
      overweight: keys.filter((b) => cur[b] > w[b] * goal + 0.005),
      untargeted,
    };
  }

  function finalRows(c, C, w, untargeted) {
    return [...Object.keys(w), ...untargeted].map((b) => ({
      bucket: b, target: (w[b] || 0) * 100, amount: c[b] || 0, pct: C ? ((c[b] || 0) / C) * 100 : 0,
    }));
  }

  /** Just this month's order(s) — cheap for any horizon. */
  function nextOrders(o) {
    const p = plan({ ...o, onlyFirst: true });
    if (p.error || p.reached) return p;
    return { orders: p.months[0].orders, need: p.need, invested: p.invested,
             months_to_goal: Math.ceil(p.need / o.monthly - 1e-9), overweight: p.overweight };
  }

  /**
   * Projection of the plan: money invested vs value growing at `annual` (e.g. 0.06), plus a low/high band.
   * Each month's contribution is added at the start of the month and grows with it.
   * Point 0 is today (current value / current money invested).
   */
  function project({ months, startValue, startInvested, annual, band = 0, start = new Date() }) {
    const rate = (r) => Math.pow(1 + r, 1 / 12) - 1;
    const rm = rate(annual), lo = rate(annual - band), hi = rate(annual + band);
    let v = startValue, vl = startValue, vh = startValue, inv = startInvested;
    const pts = [{ i: 0, date: new Date(start.getFullYear(), start.getMonth(), 1), invested: inv, value: v, low: vl, high: vh, contributed: 0 }];
    months.forEach((m, i) => {
      v = (v + m.amount) * (1 + rm);
      vl = (vl + m.amount) * (1 + lo);
      vh = (vh + m.amount) * (1 + hi);
      inv += m.amount;
      pts.push({ i: i + 1, date: new Date(start.getFullYear(), start.getMonth() + i + 1, 1), invested: inv, value: v, low: vl, high: vh, contributed: m.amount });
    });
    return pts;
  }

  /**
   * Monte Carlo of the plan: `sims` paths of monthly returns with the given expected yearly return and volatility.
   * Returns are fat-tailed (Student-t, 5 degrees of freedom, scaled to the same volatility), so big months happen
   * about as often as in real markets. Deterministic for a given seed.
   * Each point has quantiles p10/p25/p50/p75/p90 of the value; `finals` are the sorted end values.
   */
  function monteCarlo({ months, startValue, startInvested, annual, vol, sims = 2000, seed = 7, start = new Date(), df = 5, target = null }) {
    let a = seed >>> 0;
    const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
    const chi2 = () => { let x = 0; for (let i = 0; i < df; i++) { const z = gauss(); x += z * z; } return x; };
    const sm = vol / Math.sqrt(12);
    const tScale = Math.sqrt((df - 2) / df);                 // unit variance
    const mu = Math.log(1 + annual) / 12 - (sm * sm) / 2;    // log drift so the mean grows at `annual`
    const n = months.length;
    const vals = Array.from({ length: n + 1 }, () => new Float64Array(sims));
    for (let s = 0; s < sims; s++) {
      let v = startValue;
      vals[0][s] = v;
      for (let i = 0; i < n; i++) {
        const z = gauss() / Math.sqrt(chi2() / df) * tScale;
        v = (v + months[i].amount) * Math.exp(mu + sm * z);
        vals[i + 1][s] = v;
      }
    }
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
    let inv = startInvested;
    const pts = vals.map((col, i) => {
      if (i > 0) inv += months[i - 1].amount;
      const srt = Float64Array.from(col).sort();
      let below = 0, belowT = 0;
      for (const x of srt) { if (x < inv) below++; else break; }
      if (target != null) for (const x of srt) { if (x < target) belowT++; else break; }
      return { i, date: new Date(start.getFullYear(), start.getMonth() + i, 1), invested: inv, contributed: i ? months[i - 1].amount : 0,
        p10: q(srt, 0.1), p25: q(srt, 0.25), value: q(srt, 0.5), p75: q(srt, 0.75), p90: q(srt, 0.9),
        low: q(srt, 0.1), high: q(srt, 0.9), pLoss: below / srt.length,
        pGoal: target != null ? 1 - belowT / srt.length : null };
    });
    const finals = Float64Array.from(vals[n]).sort();
    const chanceAbove = (x) => { let lo = 0, hi = finals.length; while (lo < hi) { const m = (lo + hi) >> 1; if (finals[m] < x) lo = m + 1; else hi = m; } return (finals.length - lo) / finals.length; };
    return { pts, finals, chanceAbove, sims };
  }

  const api = { plan, nextOrders, waterFill, project, monteCarlo };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StonksPlanner = api;
})(typeof window !== "undefined" ? window : globalThis);
