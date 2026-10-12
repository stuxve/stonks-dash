/* stonks-dash — sell targets: your own target, stop loss and trailing stop for every buy, monitored against the
 * live price, plus suggestions you can click: resistance / support zones from closing prices, the analyst
 * consensus, a volatility-based (chandelier) trailing stop, the chance of touching a level, and breakouts.
 * Exits are stored on the buy (lot) in the asset's quote currency. Nothing here sells anything. */
window.StonksTargets = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtMoney, fmtSigned, fmtNum, fmtPrice, fmtDate, fmtHeld, cls,
    showTip, moveTip, hideTip, feeFor, openTx, $, $$ } = ctx;

  const S = () => state.settings.sell_targets || (state.settings.sell_targets = {});
  const mode = () => S().mode || "price";              // how stop/target are typed: price | pct (vs buy price)
  const near = () => (S().near > 0 ? +S().near : 5);   // "near" threshold, % of the current price
  const filter = () => S().filter || "all";
  const horizon = () => +(S().horizon || 12);          // months, for the chance of touching a level
  const save = (patch) => saveSettings({ sell_targets: { ...S(), ...patch } });

  let LV = { symbols: {}, lots: {} }, lvAt = 0, pending = false;
  const trailUi = {};                                   // per-lot trailing mode chosen before a value exists

  const STATUS = {
    brk: { o: -1, label: "Broke out", cls: "st-brk", tip: "Closed above a resistance (or your target) for 2+ days by more than a typical daily move. Raising the stop keeps the gain and lets it run." },
    tp: { o: 0, label: "Target hit", cls: "st-open", tip: "The price is at or above your target." },
    sl: { o: 1, label: "Stop hit", cls: "st-down", tip: "The price is at or below your stop." },
    "near-tp": { o: 2, label: "Near target", cls: "st-ext", tip: "Within the 'near' range below your target." },
    "near-sl": { o: 3, label: "Near stop", cls: "st-warn", tip: "Within the 'near' range above your stop." },
    watch: { o: 4, label: "Watching", cls: "st-closed", tip: "Between your stop and your target." },
    nodata: { o: 5, label: "No price", cls: "st-closed", tip: "No live price for this asset right now." },
    none: { o: 6, label: "No exit set", cls: "st-none", tip: "Set a target, a stop or a trailing stop to monitor this buy." },
  };
  const ALERT = new Set(["tp", "sl", "brk"]);

  // ------------------------------------------------------------------ helpers
  const pctTxt = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
  const vsBuy = (px, buy) => (px == null || !buy ? null : (px / buy - 1) * 100);
  const round = (v) => (v == null ? null : +(v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4)));
  function erf(x) {   // Abramowitz–Stegun 7.1.26
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  // chance the price TOUCHES `lvl` within `years` (driftless log random walk, reflection principle)
  function pHit(px, lvl, volY, years) {
    if (!(px > 0 && lvl > 0 && volY > 0 && years > 0)) return null;
    const z = Math.abs(Math.log(lvl / px)) / (volY * Math.sqrt(years));
    return Math.min(1, 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2))));
  }
  const chance = (v) => (v == null ? "" : v >= 0.995 ? ">99%" : v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
  const hz = () => (horizon() >= 12 ? `${horizon() / 12}y` : `${horizon()}m`);

  // ------------------------------------------------------------------ maths for one buy
  function trailMode(p) { return p.atr_k != null ? "atr" : p.trail_pct != null ? "pct" : (trailUi[p.id] || S().fill_mode || "pct"); }

  function evalLot(p) {
    const fx = state.port?.fx || {};
    const pccy = p.price_currency || p.currency;
    const rate = fx[p.currency] && fx[pccy] ? fx[p.currency] / fx[pccy] : 1;
    const buy = p.avg_cost * rate;                     // buy price in the quote currency
    const price = p.ok ? p.price : null;
    const L = LV.symbols[p.symbol] || null;
    const atr = L?.vol?.atr ?? null, volY = L?.vol?.vol_y ?? null;
    const pk = LV.lots[p.id];
    const peak = pk ? Math.max(pk.peak, price ?? -Infinity) : null;
    const trail = p.trail_pct && peak ? peak * (1 - p.trail_pct / 100) : null;
    const chand = p.atr_k && peak && atr ? peak - p.atr_k * atr : null;
    let stop = p.stop_price ?? null, stopSrc = stop != null ? "fixed" : null;
    if (trail != null && (stop == null || trail > stop)) { stop = trail; stopSrc = "trail"; }
    if (chand != null && (stop == null || chand > stop)) { stop = chand; stopSrc = "atr"; }
    const tp = p.target_price ?? null;
    const has = tp != null || p.stop_price != null || p.trail_pct != null || p.atr_k != null;
    let st = "watch";
    if (!has) st = "none";
    else if (price == null) st = "nodata";
    else if (tp != null && price >= tp) st = "tp";
    else if (stop != null && price <= stop) st = "sl";
    else if (tp != null && (tp / price - 1) * 100 <= near()) st = "near-tp";
    else if (stop != null && (1 - stop / price) * 100 <= near()) st = "near-sl";

    // breakout → suggest raising the stop under the broken level and moving the target to the next zone
    let sugg = null;
    if (price != null && atr && L && st !== "sl" && st !== "nodata") {
      const nextZone = (L.resistance || []).find((z) => z.level > price);
      const closes = (L.last_closes || []).slice(-2);
      if (tp != null && price >= tp && closes.length === 2 && closes.every((c) => c >= tp + atr)) {
        const ns = tp - 0.5 * atr;
        if (stop == null || ns > stop + 0.1 * atr) sugg = { stop: ns, target: nextZone ? nextZone.level : null, why: `closed above your target ${fmtPrice(tp, pccy)} for 2 days` };
      } else if (L.breakout && price > L.breakout.hi) {
        const ns = L.breakout.lo - 0.5 * atr;
        if (ns < price && (stop == null || ns > stop + 0.1 * atr)) {
          sugg = { stop: ns, target: tp != null && tp > price ? tp : (nextZone ? nextZone.level : null),
            why: `broke the ${fmtPrice(L.breakout.level, pccy)} resistance (${L.breakout.touches}× touched)${L.breakout.since ? ` on ${fmtDate(L.breakout.since)}` : ""}` };
        }
      }
      if (sugg && sugg.target != null && sugg.target <= sugg.stop) sugg.target = null;
      if (sugg) st = "brk";
    }

    const fxp = fx[pccy] || 0;
    const pnlAt = (px) => {     // P/L if sold at `px`, after the account's sell fee rule (fee in the trade currency)
      if (px == null || p.cost == null || !fxp) return null;
      const gross = p.quantity * px;
      return (gross - (feeFor(p.account, gross) || 0)) * fxp - p.cost;
    };
    const atTp = pnlAt(tp), atSl = pnlAt(stop), yrs = horizon() / 12;
    return {
      p, L, pccy, buy, price, atr, volY, peak, peakDate: pk?.peak_date, trail, chand, stop, stopSrc, tp, st, has, sugg,
      toTp: tp != null && price ? (tp / price - 1) * 100 : null,
      toSl: stop != null && price ? (stop / price - 1) * 100 : null,
      pTp: tp != null && price && tp > price ? pHit(price, tp, volY, yrs) : null,
      pSl: stop != null && price && stop < price ? pHit(price, stop, volY, yrs) : null,
      fromPeak: peak && price ? (price / peak - 1) * 100 : null,
      atTp, atSl,
      atTpPct: atTp != null && p.cost ? atTp / p.cost * 100 : null,
      fee: tp != null ? (feeFor(p.account, p.quantity * tp) || 0) * fxp : null,
    };
  }

  function lots() { return (state.port?.positions || []).filter((p) => p.quantity > 0); }
  function evaluated() {
    const all = lots().map(evalLot);
    // FIFO order inside symbol+account: a later buy can't be sold before the older ones
    const groups = {};
    for (const r of all) (groups[`${r.p.symbol || r.p.name}|${r.p.account || ""}`] ||= []).push(r);
    for (const g of Object.values(groups)) {
      g.sort((a, b) => (a.p.bought_at || "").localeCompare(b.p.bought_at || "") || a.p.id - b.p.id);
      g.forEach((r, i) => { r.fifo = i; r.fifoFirst = g[0]; r.fifoN = g.length; });
    }
    return all;
  }
  const findRow = (id) => { const p = lots().find((x) => x.id === +id); return p ? evalLot(p) : null; };

  // ------------------------------------------------------------------ data + badge
  let EARN = {};
  async function loadLevels() {
    try { LV = await api("/api/targets/levels"); lvAt = Date.now(); } catch (e) { console.warn(e); }
    try { EARN = Object.fromEntries(((await api("/api/earnings")).items || []).map((x) => [x.symbol, x])); } catch (e) { console.warn(e); }
  }
  // % from today's price to the nearest effective stop, per symbol (negative = below) — used by the earnings calendar
  function stopDistance() {
    const out = {};
    for (const p of lots()) {
      const r = evalLot(p);
      if (r.toSl == null) continue;
      if (out[p.symbol] == null || r.toSl > out[p.symbol]) out[p.symbol] = r.toSl;
    }
    return out;
  }
  function badge() {
    const el = $("#tg-badge");
    if (!el) return;
    if (lots().length && Date.now() - lvAt > 10 * 60e3) { lvAt = Date.now(); loadLevels().then(badge); }
    const n = lots().map(evalLot).filter((r) => ALERT.has(r.st)).length;
    el.textContent = n;
    el.hidden = !n;
  }

  // ------------------------------------------------------------------ rendering
  function input(r, f) {
    const p = r.p;
    let v = p[f], ph = "";
    if (f === "trail_pct") ph = "e.g. 15";
    else if (f === "atr_k") ph = "e.g. 3";
    else {
      ph = mode() === "pct" ? (f === "target_price" ? "+25" : "−10") : "price";
      if (v != null && mode() === "pct") v = +vsBuy(v, r.buy).toFixed(2);
      else if (v != null) v = round(v);
    }
    const narrow = f === "trail_pct" || f === "atr_k";
    return `<input class="tgt ${narrow ? "" : "px"}" data-id="${p.id}" data-f="${f}" type="number" step="any" value="${v ?? ""}" placeholder="${ph}">`;
  }

  function zoneTitle(r, z, kind) {
    const c = r.pccy;
    return `${kind} zone ${fmtPrice(z.lo, c)}–${fmtPrice(z.hi, c)} · touched ${z.touches}× (${z.highs} highs, ${z.lows} lows), last ${fmtDate(z.last_touch)}`
      + (z.recent ? " · recent swing high, not confirmed yet" : "")
      + (r.price ? ` · ${pctTxt((z.level / r.price - 1) * 100)} from now` : "")
      + (r.price && r.volY ? ` · ≈${chance(pHit(r.price, z.level, r.volY, horizon() / 12))} chance to touch within ${hz()}` : "")
      + (z.confluence ? " · ★ within 3% of the analyst consensus" : "");
  }

  function targetChips(r) {
    if (!r.L || r.price == null) return "";
    const zs = r.L.resistance || [];
    if (!zs.length) return `<div class="lv-none" title="No stable turning point above the current price in the last 3 years">at its highs — no resistance above</div>`;
    return `<div class="lv">${zs.map((z) => `<button class="lvc r ${z.confluence ? "star" : ""} ${Math.abs(z.level - (r.tp ?? -1)) < 1e-9 ? "on" : ""}" data-set="target_price" data-v="${round(z.level)}" title="${esc(zoneTitle(r, z, "Resistance"))}">${z.confluence ? "★ " : ""}${fmtPrice(z.level, r.pccy)}<span>${z.touches}×</span></button>`).join("")}</div>`;
  }
  function stopChips(r) {
    if (!r.L || r.price == null || !r.atr) return "";
    // a resistance the price just broke is now the nearest support: always offer it first
    const bk = r.L.breakout && r.price > r.L.breakout.hi ? r.L.breakout : null;
    const zs = (r.L.support || []).filter((z) => !bk || Math.abs(z.level - bk.level) > 1e-9).slice(0, bk ? 1 : 2);
    const chip = (z, flip) => {
      const v = round(z.lo - 0.5 * r.atr);
      const why = flip ? `Old resistance broken${z.since ? ` on ${fmtDate(z.since)}` : ""} — now acting as support. Half a typical daily move below it. `
        : "Half a typical daily move below the support. ";
      return `<button class="lvc s ${flip ? "flip" : ""}" data-set="stop_price" data-v="${v}" title="${esc(why + zoneTitle(r, z, flip ? "Broken resistance" : "Support"))}">${fmtPrice(v, r.pccy)}<span>${flip ? "↑ broke" : `${z.touches}×`}</span></button>`;
    };
    const html = (bk ? [chip(bk, true)] : []).concat(zs.map((z) => chip(z, false)));
    return html.length ? `<div class="lv">${html.join("")}</div>` : "";
  }

  function trailCell(r) {
    const p = r.p, m = trailMode(p);
    const f = m === "atr" ? "atr_k" : "trail_pct";
    const val = m === "atr" ? r.chand : r.trail;
    let sub = "";
    if (val != null) sub = `stop ${fmtPrice(val, r.pccy)}${r.stopSrc === m.replace("pct", "trail") ? " ◂" : ""}`;
    else if (m === "atr" && r.atr) sub = `1× = ${fmtPrice(r.atr, r.pccy)} (${r.L.vol.atr_pct.toFixed(1)}%)`;
    else if (!p.bought_at) sub = "needs a buy date";
    return `<div class="trail">${input(r, f)}<button class="tmode" data-id="${p.id}" title="${m === "atr"
      ? "Chandelier stop: highest close since the buy minus k × the typical daily move. Click for a fixed %."
      : "Trailing stop: % below the highest close since the buy. Click for a volatility-based (×ATR) stop."}">${m === "atr" ? "×ATR" : "%"}</button></div><div class="sub">${sub}</div>`;
  }

  function analystCell(r) {
    const a = r.L?.analyst;
    if (!a) {
      const qt = r.p.quote_type;
      return `<span class="muted-t">—</span><div class="sub">${qt === "CRYPTOCURRENCY" ? "no analysts for crypto" : qt && qt !== "EQUITY" ? "no holdings data" : r.L ? "no coverage" : ""}</div>`;
    }
    const tags = [];
    if (a.implied) {
      const top = (a.top || []).map((t) => `${t.symbol} ${t.weight.toFixed(1)}% → ${pctTxt(t.upside)}`).join("\n");
      const tip = `Implied target: the analyst consensus upside of the fund's top holdings, weighted by their share of the fund`
        + `${a.proxy ? ` (holdings of ${a.proxy}, an ETF on the same index — Yahoo has none for this listing)` : ""}.`
        + ` They cover ${a.coverage.toFixed(0)}% of the fund; the rest is assumed to move like them. Prices in the holdings' own currency, so FX moves are not included unless the fund is hedged.\n\n${top}`;
      if (a.likely_break) tags.push(`<span class="pill ext" title="The implied target is ${pctTxt(a.vs_resistance)} above the nearest resistance">likely to break</span>`);
      if ((r.L.resistance || []).some((z) => z.confluence)) tags.push(`<span class="pill ok" title="A resistance zone sits within 3% of the implied target">★ agrees</span>`);
      return `<button class="lvc a imp" data-set="target_price" data-v="${round(a.mean)}" title="${esc(tip)}\n\nClick to use as target">≈${fmtPrice(a.mean, r.pccy)}</button>
        <div class="sub ${cls(a.upside)}">${pctTxt(a.upside)} implied</div>
        <div class="sub" title="${esc(tip)}">top ${a.n_holdings} = ${a.coverage.toFixed(0)}% of fund${a.proxy ? ` · via ${esc(a.proxy)}` : ""}</div>${tags.join("")}`;
    }
    if (a.likely_break) tags.push(`<span class="pill ext" title="The consensus is ${pctTxt(a.vs_resistance)} above the nearest resistance: that level is more likely to give way">likely to break</span>`);
    if ((r.L.resistance || []).some((z) => z.confluence)) tags.push(`<span class="pill ok" title="A resistance zone sits within 3% of the consensus: two independent methods agree">★ agrees</span>`);
    const tip = `${a.n || "?"} analysts · low ${fmtPrice(a.low, r.pccy)} · median ${fmtPrice(a.median, r.pccy)} · high ${fmtPrice(a.high, r.pccy)}${a.rec ? ` · ${a.rec.replace("_", " ")}` : ""}`;
    return `<button class="lvc a" data-set="target_price" data-v="${round(a.mean)}" title="${esc(tip)} — click to use as target">${fmtPrice(a.mean, r.pccy)}</button>
      <div class="sub ${cls(a.upside)}">${pctTxt(a.upside)} · ${a.n || "?"} an.</div>${tags.join("")}`;
  }

  function rangeBar(r) {
    const vals = [r.stop, r.buy, r.price, r.tp].filter((x) => x != null && isFinite(x));
    if (vals.length < 2) return `<div class="rb empty"></div>`;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || hi * 0.05;
    lo -= pad; hi += pad;
    const x = (v) => ((v - lo) / (hi - lo) * 100).toFixed(2);
    const zs = [...(r.L?.resistance || []), ...(r.L?.support || []), ...(r.L?.breakout ? [r.L.breakout] : [])].filter((z) => z.hi > lo && z.lo < hi);
    const fill = r.price != null ? `<i class="fill ${r.price >= r.buy ? "up" : "down"}" style="left:${x(Math.min(r.buy, r.price))}%;width:${(x(Math.max(r.buy, r.price)) - x(Math.min(r.buy, r.price))).toFixed(2)}%"></i>` : "";
    return `<div class="rb" data-id="${r.p.id}">${zs.map((z) => `<i class="zone" style="left:${x(Math.max(z.lo, lo))}%;width:${Math.max(0.8, x(Math.min(z.hi, hi)) - x(Math.max(z.lo, lo))).toFixed(2)}%"></i>`).join("")}${fill}
      ${r.stop != null ? `<i class="m stop ${r.stopSrc}" style="left:${x(r.stop)}%"></i>` : ""}
      <i class="m buy" style="left:${x(r.buy)}%"></i>
      ${r.tp != null ? `<i class="m tp" style="left:${x(r.tp)}%"></i>` : ""}
      ${r.price != null ? `<i class="dot" style="left:${x(r.price)}%"></i>` : ""}</div>`;
  }

  function render() {
    const t = $("#tg-table");
    if (!t) return;
    // don't wipe a value being typed (auto-refresh); redraw once the field loses focus
    const ae = document.activeElement;
    if (ae && ae.tagName === "INPUT" && t.contains(ae) && ae.value !== ae.defaultValue) { pending = true; return; }
    const focus = ae && t.contains(ae) && ae.dataset.f ? { id: ae.dataset.id, f: ae.dataset.f } : null;
    pending = false;
    const b = base();
    const all = evaluated();
    $$("#tg-mode button").forEach((x) => x.classList.toggle("active", x.dataset.v === mode()));
    $$("#tg-filter button").forEach((x) => x.classList.toggle("active", x.dataset.v === filter()));
    $$("#tg-horizon button").forEach((x) => x.classList.toggle("active", +x.dataset.v === horizon()));
    $("#tg-near").value = near();
    kpis(all);

    let rows = all;
    if (filter() === "set") rows = rows.filter((r) => r.has);
    if (filter() === "alert") rows = rows.filter((r) => ALERT.has(r.st) || r.st === "near-tp" || r.st === "near-sl");
    rows.sort((a, c) => STATUS[a.st].o - STATUS[c.st].o || (a.p.symbol || "").localeCompare(c.p.symbol || "")
      || (a.p.bought_at || "").localeCompare(c.p.bought_at || ""));

    const u = mode() === "pct" ? "% vs buy" : "price";
    t.tHead.innerHTML = `<tr><th>Buy</th><th>Bought</th><th class="num">Buy price</th><th class="num">Now</th>
      <th class="num">Stop loss <span class="sub">${u} · ▾ supports</span></th>
      <th class="num" title="Follows the price up from the highest close since the buy">Trailing stop <span class="sub">% or ×ATR off peak</span></th>
      <th class="num">Target <span class="sub">${u} · ▾ resistances</span></th>
      <th class="num" title="Analyst consensus price target. ETFs: implied from the consensus of their top holdings">Analysts <span class="sub">mean / implied target</span></th>
      <th class="rbcol">Stop · buy · now · target</th>
      <th class="num">To target <span class="sub">chance in ${hz()}</span></th>
      <th class="num" title="Profit or loss if sold at the target, after the account's sell fee">P/L at target</th><th>Status</th><th></th></tr>`;
    t.tBodies[0].innerHTML = rows.length ? rows.map((r) => {
      const p = r.p, s = STATUS[r.st];
      const other = (f) => {
        const v = f === "target_price" ? r.tp : p.stop_price;
        if (v == null) return "";
        return mode() === "pct" ? fmtPrice(v, r.pccy) : pctTxt(vsBuy(v, r.buy));
      };
      const ev = EARN[p.symbol];
      const earnSoon = ev && ev.days != null && ev.days >= 0 && ev.days <= 14;
      const earnRisky = earnSoon && ev.typical_move != null && r.toSl != null && Math.abs(r.toSl) <= ev.typical_move * 1.2;
      const earnPill = earnSoon ? `<span class="pill ${earnRisky ? "warn" : "ext"}" title="Reports earnings ${ev.days === 0 ? "today" : ev.days === 1 ? "tomorrow" : `in ${ev.days} days`} (${fmtDate(ev.next)}${ev.next_to ? ", estimated" : ""}).${ev.typical_move != null ? ` Typical move after a report: ±${ev.typical_move.toFixed(1)}%.` : ""}${earnRisky ? ` Your stop is only ${Math.abs(r.toSl).toFixed(1)}% away — inside that range.` : ""}">earnings ${ev.days === 0 ? "today" : `${ev.days}d`}</span>` : "";
      const fifo = r.fifo > 0 ? `<span class="pill warn" title="Sales are matched oldest buy first (FIFO): selling now uses the buy of ${fmtDate(r.fifoFirst.p.bought_at) || "an older date"} before this one.">FIFO ${r.fifo + 1}/${r.fifoN}</span>` : "";
      const vol = r.L?.vol;
      return `<tr data-id="${p.id}" class="st-row-${r.st}">
        <td class="asset"><b>${esc(p.symbol || p.name || "—")}</b>${fifo}${earnPill}<div class="sub">${esc(p.display_name || "")}${p.account ? ` · ${esc(p.account)}` : ""}</div></td>
        <td>${p.bought_at ? fmtDate(p.bought_at) : "—"}<div class="sub">${p.bought_at ? fmtHeld(p.bought_at) : "no date"} · ${fmtNum(p.quantity)} u.</div></td>
        <td class="num">${fmtPrice(r.buy, r.pccy)}<div class="sub">${fmtMoney(p.cost, b)}</div></td>
        <td class="num">${r.price != null ? fmtPrice(r.price, r.pccy) : '<span class="down">n/a</span>'}<div class="sub ${cls(p.pnl_pct)}">${pctTxt(p.pnl_pct)}</div>
          ${vol ? `<div class="sub" title="Typical daily move (22-day average of close-to-close changes) and annual volatility">±${vol.atr_pct.toFixed(1)}%/d · σ ${(vol.vol_y * 100).toFixed(0)}%</div>` : ""}</td>
        <td class="num">${input(r, "stop_price")}<div class="sub">${other("stop_price")}</div>${stopChips(r)}</td>
        <td class="num">${trailCell(r)}</td>
        <td class="num">${input(r, "target_price")}<div class="sub">${other("target_price")}</div>${targetChips(r)}</td>
        <td class="num">${analystCell(r)}</td>
        <td class="rbcol">${rangeBar(r)}${r.peak != null ? `<div class="sub rb-sub">peak ${fmtPrice(r.peak, r.pccy)} · ${pctTxt(r.fromPeak)}</div>` : ""}</td>
        <td class="num">${r.st === "tp" || (r.st === "brk" && r.tp != null && r.price >= r.tp) ? '<span class="up">reached</span>' : pctTxt(r.toTp)}${r.pTp != null ? `<div class="sub" title="Chance of touching the target within ${hz()}, from this asset's volatility, assuming no trend">≈${chance(r.pTp)}</div>` : ""}
          <div class="sub">${r.toSl != null ? (r.st === "sl" ? "stop reached" : `${pctTxt(r.toSl)} to stop${r.pSl != null ? ` · ≈${chance(r.pSl)}` : ""}`) : ""}</div></td>
        <td class="num ${cls(r.atTp)}">${r.atTp != null ? fmtSigned(r.atTp, b) : "—"}<div class="sub">${r.atTpPct != null ? pctTxt(r.atTpPct) : ""}</div></td>
        <td><span class="st ${s.cls}" title="${esc(r.sugg ? `${s.tip} It ${r.sugg.why}.` : s.tip)}">${s.label}</span></td>
        <td><div class="row-actions">
          ${r.sugg ? `<button class="raise" title="Stop → ${fmtPrice(r.sugg.stop, r.pccy)}${r.sugg.target != null ? `, target → ${fmtPrice(r.sugg.target, r.pccy)}` : ", target cleared"}">Raise stop</button>` : ""}
          <button class="sell" title="Record the sale of this buy">Sell</button>
          <button class="copy" title="Use these exits for every buy of ${esc(p.symbol || "")}">All buys</button>
          <button class="clear" title="Remove the exits of this buy">Clear</button></div></td></tr>`;
    }).join("") : `<tr><td colspan="13" class="hint">${all.length ? "Nothing matches this filter." : "No open buys yet."}</td></tr>`;
    if (focus) {
      const el = t.querySelector(`input[data-id="${focus.id}"][data-f="${focus.f}"]`);
      if (el) { el.focus(); el.select?.(); }
    }
  }

  function kpis(all) {
    const b = base();
    const kpi = (k, v, d = "") => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const set = all.filter((r) => r.has);
    const n = (st) => all.filter((r) => r.st === st).length;
    const hitTp = n("tp"), hitSl = n("sl"), brk = n("brk"), nearN = n("near-tp") + n("near-sl");
    const withTp = all.filter((r) => r.atTp != null), withSl = all.filter((r) => r.atSl != null);
    const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);
    const tpNow = sum(withTp, (r) => r.p.pnl), slNow = sum(withSl, (r) => r.p.pnl);
    const tpSum = sum(withTp, (r) => r.atTp), slSum = sum(withSl, (r) => r.atSl);
    const both = all.filter((r) => r.atTp != null && r.atSl != null);
    const up = sum(both, (r) => r.atTp - r.p.pnl), down = sum(both, (r) => r.p.pnl - r.atSl);
    $("#tg-kpis").innerHTML = [
      kpi("Buys monitored", `${set.length} / ${all.length}`, `<span class="muted-t">with a target, stop or trailing stop</span>`),
      kpi("Alerts", `<span class="${hitTp + hitSl + brk ? "warn-t" : ""}">${hitTp + hitSl + brk}</span>`,
        `<span class="up">${hitTp} target</span> · <span class="down">${hitSl} stop</span> · <span class="ext-t">${brk} breakout</span> · ${nearN} near`),
      kpi("If every target is hit", withTp.length ? `<span class="${cls(tpSum)}">${fmtSigned(tpSum, b)}</span>` : "—",
        withTp.length ? `<span class="${cls(tpSum - tpNow)}">${fmtSigned(tpSum - tpNow, b)}</span> vs now · ${withTp.length} buys` : ""),
      kpi("If every stop is hit", withSl.length ? `<span class="${cls(slSum)}">${fmtSigned(slSum, b)}</span>` : "—",
        withSl.length ? `<span class="${cls(slSum - slNow)}">${fmtSigned(slSum - slNow, b)}</span> vs now · ${withSl.length} buys` : ""),
      kpi("Reward / risk from here", both.length && down > 0 ? `${(up / down).toFixed(2)}×` : "—",
        both.length ? `+${fmtMoney(Math.max(up, 0), b)} to targets / −${fmtMoney(Math.max(down, 0), b)} to stops` : "needs a target and a stop"),
    ].join("");
  }

  // ------------------------------------------------------------------ editing
  function showErr(m) { const e = $("#tg-error"); e.textContent = m; e.hidden = !m; }

  async function patch(id, body) {
    showErr("");
    const p = lots().find((x) => x.id === id);
    const old = p ? Object.fromEntries(Object.keys(body).map((k) => [k, p[k]])) : null;
    if (p) Object.assign(p, body);
    setTimeout(render, 0);
    try { await api(`/api/positions/${id}`, { method: "PATCH", body }); }
    catch (e) {
      if (p && old) Object.assign(p, old);
      showErr(e.message);
      setTimeout(render, 0);
      return false;
    }
    badge();
    return true;
  }

  function parse(r, f, raw) {
    if (raw === "") return null;
    const v = +raw;
    if (!isFinite(v)) return undefined;
    if (f === "trail_pct") return v > 0 && v < 100 ? v : undefined;
    if (f === "atr_k") return v > 0 && v <= 20 ? v : undefined;
    const px = mode() === "pct" ? r.buy * (1 + v / 100) : v;
    return px > 0 ? round(px) : undefined;
  }
  const ERR = { trail_pct: "Trailing stop: a % between 0 and 100.", atr_k: "Volatility stop: a multiple between 0 and 20 (3 is typical).",
    stop_price: "Enter a price above 0.", target_price: "Enter a price above 0." };

  const tbl = $("#tg-table");
  tbl.addEventListener("change", (e) => {
    const el = e.target.closest("input[data-f]");
    if (!el) return;
    const r = findRow(el.dataset.id);
    if (!r) return;
    const v = parse(r, el.dataset.f, el.value.trim());
    if (v === undefined) return showErr(ERR[el.dataset.f]);
    el.defaultValue = el.value;
    patch(r.p.id, { [el.dataset.f]: v });
  });
  tbl.addEventListener("focusout", () => setTimeout(() => { if (pending && !tbl.contains(document.activeElement)) render(); }, 0));
  tbl.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[data-f]")) e.target.blur(); });
  tbl.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const r = findRow(tr.dataset.id);
    if (!r) return;
    const p = r.p;
    const chip = e.target.closest("[data-set]");
    if (chip) return patch(p.id, { [chip.dataset.set]: +chip.dataset.v });
    if (e.target.closest(".tmode")) {
      const m = trailMode(p), atrPct = r.L?.vol?.atr_pct;
      if (m === "pct") {
        if (p.trail_pct != null && atrPct) return patch(p.id, { trail_pct: null, atr_k: Math.max(0.5, Math.round(p.trail_pct / atrPct * 2) / 2) });
        trailUi[p.id] = "atr";
      } else {
        if (p.atr_k != null && atrPct) return patch(p.id, { atr_k: null, trail_pct: Math.min(99, Math.max(0.5, Math.round(p.atr_k * atrPct * 2) / 2)) });
        trailUi[p.id] = "pct";
      }
      return render();
    }
    if (e.target.closest(".raise") && r.sugg) {
      const g = r.sugg;
      if (!confirm(`${p.symbol}: ${g.why}.\n\nStop → ${fmtPrice(g.stop, r.pccy)}\nTarget → ${g.target != null ? fmtPrice(g.target, r.pccy) : "none (no resistance above)"}\n\nApply?`)) return;
      // set the target first when it goes up, so the stop never ends above it on the server
      const body = { stop_price: round(g.stop), target_price: g.target != null ? round(g.target) : null };
      return patch(p.id, body);
    }
    if (e.target.closest(".sell")) {
      const px = r.st === "tp" ? r.tp : r.st === "sl" ? r.stop : r.price;
      openTx("SELL", { symbol: p.symbol, account: p.account || "", quantity: +p.quantity.toFixed(8),
        price: px != null ? round(px) : null, currency: r.pccy,
        notes: r.st === "tp" ? "Target reached" : r.st === "sl" ? "Stop reached" : null });
      $("#tx-form")?.price?.dispatchEvent(new Event("input", { bubbles: true }));   // prefill the fee rule
    } else if (e.target.closest(".copy")) {
      const sibs = lots().filter((x) => x.symbol === p.symbol && x.id !== p.id);
      if (!sibs.length) return showErr(`This is your only open buy of ${p.symbol}.`);
      if (!confirm(`Use target ${p.target_price ?? "—"}, stop ${p.stop_price ?? "—"}, trailing ${p.trail_pct != null ? p.trail_pct + "%" : p.atr_k != null ? p.atr_k + "×ATR" : "—"} for all ${sibs.length + 1} buys of ${p.symbol}?`)) return;
      for (const s of sibs) {
        if (!(await patch(s.id, { target_price: p.target_price ?? null, stop_price: p.stop_price ?? null,
          trail_pct: p.trail_pct ?? null, atr_k: p.atr_k ?? null }))) break;
      }
    } else if (e.target.closest(".clear")) {
      patch(p.id, { target_price: null, stop_price: null, trail_pct: null, atr_k: null });
    }
  });
  tbl.addEventListener("mouseover", (e) => {
    const bar = e.target.closest(".rb[data-id]");
    if (!bar) return;
    const r = findRow(bar.dataset.id);
    if (!r) return;
    const b = base(), c = r.pccy;
    const line = (k, v, extra = "") => `<dt>${k}</dt><dd>${v}${extra}</dd>`;
    const srcName = { fixed: "Stop", trail: `Stop (trailing ${r.p.trail_pct}%)`, atr: `Stop (${r.p.atr_k}× ATR)` };
    showTip(`<div class="tt-head"><b>${esc(r.p.symbol || r.p.name)}</b>${r.p.bought_at ? ` · bought ${fmtDate(r.p.bought_at)}` : ""}</div><dl>
      ${line("Target", r.tp != null ? fmtPrice(r.tp, c) : "—", r.tp != null ? ` <span class="muted-t">${pctTxt(vsBuy(r.tp, r.buy))} vs buy</span>` : "")}
      ${line("Now", r.price != null ? fmtPrice(r.price, c) : "—", r.price != null ? ` <span class="${cls(r.p.pnl_pct)}">${pctTxt(r.p.pnl_pct)}</span>` : "")}
      ${line("Buy", fmtPrice(r.buy, c))}
      ${r.stop != null ? line(srcName[r.stopSrc], fmtPrice(r.stop, c), ` <span class="muted-t">${pctTxt(vsBuy(r.stop, r.buy))} vs buy</span>`) : ""}
      ${r.peak != null ? line("Peak since buy", fmtPrice(r.peak, c), r.peakDate ? ` <span class="muted-t">${fmtDate(r.peakDate)}</span>` : "") : ""}
      ${r.atr ? line("Typical daily move", fmtPrice(r.atr, c), ` <span class="muted-t">${r.L.vol.atr_pct.toFixed(2)}% · σ ${(r.volY * 100).toFixed(0)}%/y</span>`) : ""}
      ${(r.L?.resistance || []).map((z) => line("Resistance", fmtPrice(z.level, c), ` <span class="muted-t">${z.touches}× · ${pctTxt((z.level / r.price - 1) * 100)}</span>`)).join("")}
      ${(r.L?.support || []).slice(0, 2).map((z) => line("Support", fmtPrice(z.level, c), ` <span class="muted-t">${z.touches}× · ${pctTxt((z.level / r.price - 1) * 100)}</span>`)).join("")}
      ${r.atTp != null ? line("P/L at target", `<span class="${cls(r.atTp)}">${fmtSigned(r.atTp, b)}</span>`, r.fee ? ` <span class="muted-t">after ${fmtMoney(r.fee, b)} fee</span>` : "") : ""}
      ${r.atSl != null ? line("P/L at stop", `<span class="${cls(r.atSl)}">${fmtSigned(r.atSl, b)}</span>`) : ""}
      ${line("P/L now", `<span class="${cls(r.p.pnl)}">${fmtSigned(r.p.pnl, b)}</span>`)}</dl>`, e);
  });
  tbl.addEventListener("mousemove", (e) => { if (e.target.closest(".rb[data-id]")) moveTip(e); });
  tbl.addEventListener("mouseout", (e) => { if (e.target.closest(".rb[data-id]")) hideTip(); });

  for (const [id, key, num] of [["#tg-mode", "mode"], ["#tg-filter", "filter"], ["#tg-horizon", "horizon", true]]) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      save({ [key]: num ? +b.dataset.v : b.dataset.v }); render();
    });
  }
  $("#tg-near").addEventListener("change", (e) => {
    const v = +e.target.value;
    if (v > 0 && v <= 50) { save({ near: v }); render(); badge(); }
  });

  // fill buys that have no exit yet
  for (const [id, k] of [["#tg-fill-tp", "fill_tp"], ["#tg-fill-sl", "fill_sl"], ["#tg-fill-tr", "fill_tr"]]) {
    $(id).value = S()[k] ?? "";
    $(id).addEventListener("change", (e) => save({ [k]: e.target.value === "" ? null : +e.target.value }));
  }
  $("#tg-fill-mode").value = S().fill_mode || "pct";
  $("#tg-fill-mode").addEventListener("change", (e) => save({ fill_mode: e.target.value }));
  $("#tg-fill-btn").addEventListener("click", async () => {
    const tp = $("#tg-fill-tp").value, sl = $("#tg-fill-sl").value, tr = $("#tg-fill-tr").value;
    const atrMode = $("#tg-fill-mode").value === "atr";
    if (tp === "" && sl === "" && tr === "") return showErr("Enter a target %, a stop % or a trailing value.");
    if ((sl !== "" && !(+sl > 0 && +sl < 100)) || (tp !== "" && !(+tp > -100))
      || (tr !== "" && !(+tr > 0 && +tr < (atrMode ? 20.0001 : 100)))) {
      return showErr("Stop is % below the buy price (0–100), target % above it; trailing is a % (0–100) or a ×ATR multiple (0–20).");
    }
    const jobs = [];
    for (const r of lots().map(evalLot)) {
      const body = {};
      if (tp !== "" && r.p.target_price == null) body.target_price = round(r.buy * (1 + +tp / 100));
      if (sl !== "" && r.p.stop_price == null) body.stop_price = round(r.buy * (1 - +sl / 100));
      if (tr !== "" && r.p.trail_pct == null && r.p.atr_k == null) body[atrMode ? "atr_k" : "trail_pct"] = +tr;
      if (Object.keys(body).length) jobs.push([r.p.id, body]);
    }
    if (!jobs.length) return showErr("Every buy already has these exits — edit them in the table.");
    if (!confirm(`Set exits on ${jobs.length} buy${jobs.length > 1 ? "s" : ""}? Exits you already set are kept.`)) return;
    for (const [id, body] of jobs) { if (!(await patch(id, body))) break; }
  });

  async function refresh(silent) {
    if (!state.port) return;
    render();
    if (Date.now() - lvAt > 60e3 || !silent) { await loadLevels(); render(); badge(); }
  }

  return { refresh, badge, stopDistance };
};
