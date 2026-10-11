/* stonks-dash — sell targets: a take-profit, a stop loss and an optional trailing stop for every buy,
 * monitored against the live price. Exits are stored on the buy (lot) in the asset's quote currency. */
window.StonksTargets = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtPct, fmtMoney, fmtSigned, fmtNum, fmtPrice, fmtDate, fmtHeld, cls,
    showTip, moveTip, hideTip, loadPortfolio, feeFor, openTx, $, $$ } = ctx;

  const S = () => state.settings.sell_targets || (state.settings.sell_targets = {});
  const mode = () => S().mode || "price";              // how stop/target are typed: price | pct (vs buy price)
  const near = () => (S().near > 0 ? +S().near : 5);   // "near" threshold, % of the current price
  const filter = () => S().filter || "all";
  const save = (patch) => saveSettings({ sell_targets: { ...S(), ...patch } });

  let peaks = {}, peaksAt = 0, pending = false;
  const STATUS = {
    tp: { o: 0, label: "Target hit", cls: "st-open", tip: "The price is at or above your target." },
    sl: { o: 1, label: "Stop hit", cls: "st-down", tip: "The price is at or below your stop." },
    "near-tp": { o: 2, label: "Near target", cls: "st-ext", tip: "Within the 'near' range below your target." },
    "near-sl": { o: 3, label: "Near stop", cls: "st-warn", tip: "Within the 'near' range above your stop." },
    watch: { o: 4, label: "Watching", cls: "st-closed", tip: "Between your stop and your target." },
    nodata: { o: 5, label: "No price", cls: "st-closed", tip: "No live price for this asset right now." },
    none: { o: 6, label: "No exit set", cls: "st-none", tip: "Set a target, a stop or a trailing stop to monitor this buy." },
  };

  // ------------------------------------------------------------------ maths for one buy
  function evalLot(p) {
    const fx = state.port?.fx || {};
    const pccy = p.price_currency || p.currency;
    const rate = fx[p.currency] && fx[pccy] ? fx[p.currency] / fx[pccy] : 1;
    const buy = p.avg_cost * rate;                     // buy price in the quote currency (incl. nothing else)
    const price = p.ok ? p.price : null;
    const pk = peaks[p.id];
    const peak = pk ? Math.max(pk.peak, price ?? -Infinity) : null;
    const trail = p.trail_pct && peak ? peak * (1 - p.trail_pct / 100) : null;
    let stop = p.stop_price ?? null, stopSrc = stop != null ? "fixed" : null;
    if (trail != null && (stop == null || trail > stop)) { stop = trail; stopSrc = "trail"; }
    const tp = p.target_price ?? null;
    const has = tp != null || p.stop_price != null || p.trail_pct != null;
    let st = "watch";
    if (!has) st = "none";
    else if (price == null) st = "nodata";
    else if (tp != null && price >= tp) st = "tp";
    else if (stop != null && price <= stop) st = "sl";
    else if (tp != null && (tp / price - 1) * 100 <= near()) st = "near-tp";
    else if (stop != null && (1 - stop / price) * 100 <= near()) st = "near-sl";
    const fxp = fx[pccy] || 0;
    // P/L if sold at `px`, after the account's sell fee rule (fee assumed in the trade currency)
    const pnlAt = (px) => {
      if (px == null || p.cost == null || !fxp) return null;
      const gross = p.quantity * px;
      const fee = feeFor(p.account, gross) || 0;
      return (gross - fee) * fxp - p.cost;
    };
    const atTp = pnlAt(tp), atSl = pnlAt(stop);
    return {
      p, pccy, buy, price, peak, peakDate: pk?.peak_date, trail, stop, stopSrc, tp, st, has,
      toTp: tp != null && price ? (tp / price - 1) * 100 : null,
      toSl: stop != null && price ? (stop / price - 1) * 100 : null,
      fromPeak: peak && price ? (price / peak - 1) * 100 : null,
      atTp, atSl,
      atTpPct: atTp != null && p.cost ? atTp / p.cost * 100 : null,
      atSlPct: atSl != null && p.cost ? atSl / p.cost * 100 : null,
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

  // ------------------------------------------------------------------ badge on the sub-tab
  function badge() {
    const el = $("#tg-badge");
    if (!el) return;
    if (lots().some((p) => p.trail_pct) && Date.now() - peaksAt > 10 * 60e3) loadPeaks().then(badge);
    const n = lots().map(evalLot).filter((r) => r.st === "tp" || r.st === "sl").length;
    el.textContent = n;
    el.hidden = !n;
  }

  async function loadPeaks() {
    try { peaks = (await api("/api/targets/peaks")).peaks || {}; peaksAt = Date.now(); } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------------ rendering
  const pctTxt = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
  const vsBuy = (px, buy) => (px == null || !buy ? null : (px / buy - 1) * 100);
  const round = (v) => (v == null ? null : +(v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4)));

  function input(r, f) {
    const p = r.p;
    let v = p[f], ph = "";
    if (f === "trail_pct") { ph = "e.g. 15"; }
    else {
      ph = mode() === "pct" ? (f === "target_price" ? "+25" : "−10") : "price";
      if (v != null && mode() === "pct") v = +vsBuy(v, r.buy).toFixed(2);
      else if (v != null) v = round(v);
    }
    return `<input class="tgt ${f === "trail_pct" ? "" : "px"}" data-id="${p.id}" data-f="${f}" type="number" step="any" value="${v ?? ""}" placeholder="${ph}">`;
  }

  function rangeBar(r) {
    const vals = [r.stop, r.buy, r.price, r.tp].filter((x) => x != null && isFinite(x));
    if (vals.length < 2) return `<div class="rb empty"></div>`;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || hi * 0.05;
    lo -= pad; hi += pad;
    const x = (v) => ((v - lo) / (hi - lo) * 100).toFixed(2);
    const fill = r.price != null ? `<i class="fill ${r.price >= r.buy ? "up" : "down"}" style="left:${x(Math.min(r.buy, r.price))}%;width:${(x(Math.max(r.buy, r.price)) - x(Math.min(r.buy, r.price))).toFixed(2)}%"></i>` : "";
    return `<div class="rb" data-id="${r.p.id}">${fill}
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
    $("#tg-near").value = near();
    kpis(all);

    let rows = all;
    if (filter() === "set") rows = rows.filter((r) => r.has);
    if (filter() === "alert") rows = rows.filter((r) => r.st === "tp" || r.st === "sl" || r.st === "near-tp" || r.st === "near-sl");
    rows.sort((a, c) => STATUS[a.st].o - STATUS[c.st].o || (a.p.symbol || "").localeCompare(c.p.symbol || "")
      || (a.p.bought_at || "").localeCompare(c.p.bought_at || ""));

    const u = mode() === "pct" ? "% vs buy" : "price";
    t.tHead.innerHTML = `<tr><th>Buy</th><th>Bought</th><th class="num">Qty</th><th class="num">Buy price</th><th class="num">Now</th>
      <th class="num" title="Highest close since the buy">Peak</th>
      <th class="num">Stop loss <span class="sub">${u}</span></th><th class="num" title="Stop that follows the price up: % below the highest close since the buy">Trailing <span class="sub">% off peak</span></th>
      <th class="num">Target <span class="sub">${u}</span></th><th class="rbcol">Stop · buy · now · target</th>
      <th class="num">To target</th><th class="num" title="Profit or loss if sold at the target, after the account's sell fee">P/L at target</th><th>Status</th><th></th></tr>`;
    t.tBodies[0].innerHTML = rows.length ? rows.map((r) => {
      const p = r.p, s = STATUS[r.st];
      const other = (f) => {
        const v = f === "target_price" ? r.tp : p.stop_price;
        if (v == null) return "";
        return mode() === "pct" ? fmtPrice(v, r.pccy) : pctTxt(vsBuy(v, r.buy));
      };
      const fifo = r.fifo > 0 ? `<span class="pill warn" title="Sales are matched oldest buy first (FIFO): selling now uses the buy of ${fmtDate(r.fifoFirst.p.bought_at) || "an older date"} before this one.">FIFO ${r.fifo + 1}/${r.fifoN}</span>` : "";
      return `<tr data-id="${p.id}" class="st-row-${r.st}">
        <td class="asset"><b>${esc(p.symbol || p.name || "—")}</b>${fifo}<div class="sub">${esc(p.display_name || "")}${p.account ? ` · ${esc(p.account)}` : ""}</div></td>
        <td>${p.bought_at ? fmtDate(p.bought_at) : "—"}<div class="sub">${p.bought_at ? fmtHeld(p.bought_at) : "no date"}</div></td>
        <td class="num">${fmtNum(p.quantity)}</td>
        <td class="num">${fmtPrice(r.buy, r.pccy)}<div class="sub">${fmtMoney(p.cost, b)}</div></td>
        <td class="num">${r.price != null ? fmtPrice(r.price, r.pccy) : '<span class="down">n/a</span>'}<div class="sub ${cls(p.pnl_pct)}">${pctTxt(p.pnl_pct)}</div></td>
        <td class="num">${r.peak != null ? fmtPrice(r.peak, r.pccy) : "—"}<div class="sub">${r.fromPeak != null ? `${pctTxt(r.fromPeak)} from peak` : (p.bought_at ? "" : "needs a buy date")}</div></td>
        <td class="num">${input(r, "stop_price")}<div class="sub">${other("stop_price")}</div></td>
        <td class="num">${input(r, "trail_pct")}<div class="sub">${r.trail != null ? `stop ${fmtPrice(r.trail, r.pccy)}${r.stopSrc === "trail" ? " ◂" : ""}` : ""}</div></td>
        <td class="num">${input(r, "target_price")}<div class="sub">${other("target_price")}</div></td>
        <td class="rbcol">${rangeBar(r)}</td>
        <td class="num">${r.st === "tp" ? '<span class="up">reached</span>' : pctTxt(r.toTp)}<div class="sub">${r.toSl != null ? (r.st === "sl" ? "stop reached" : `${pctTxt(r.toSl)} to stop`) : ""}</div></td>
        <td class="num ${cls(r.atTp)}">${r.atTp != null ? fmtSigned(r.atTp, b) : "—"}<div class="sub">${r.atTpPct != null ? pctTxt(r.atTpPct) : ""}</div></td>
        <td><span class="st ${s.cls}" title="${s.tip}">${s.label}</span></td>
        <td><div class="row-actions">
          <button class="sell" title="Record the sale of this buy">Sell</button>
          <button class="copy" title="Use these exits for every buy of ${esc(p.symbol || "")}">All buys</button>
          <button class="clear" title="Remove the exits of this buy">Clear</button></div></td></tr>`;
    }).join("") : `<tr><td colspan="14" class="hint">${all.length ? "Nothing matches this filter." : "No open buys yet."}</td></tr>`;
    if (focus) {
      const el = t.querySelector(`input[data-id="${focus.id}"][data-f="${focus.f}"]`);
      if (el) { el.focus(); el.select?.(); }
    }
  }

  function kpis(all) {
    const b = base();
    const kpi = (k, v, d = "") => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const set = all.filter((r) => r.has);
    const hitTp = all.filter((r) => r.st === "tp").length, hitSl = all.filter((r) => r.st === "sl").length;
    const nearN = all.filter((r) => r.st === "near-tp" || r.st === "near-sl").length;
    const withTp = all.filter((r) => r.atTp != null), withSl = all.filter((r) => r.atSl != null);
    const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);
    const tpNow = sum(withTp, (r) => r.p.pnl), slNow = sum(withSl, (r) => r.p.pnl);
    const tpSum = sum(withTp, (r) => r.atTp), slSum = sum(withSl, (r) => r.atSl);
    const both = all.filter((r) => r.atTp != null && r.atSl != null);
    const up = sum(both, (r) => r.atTp - r.p.pnl), down = sum(both, (r) => r.p.pnl - r.atSl);
    $("#tg-kpis").innerHTML = [
      kpi("Buys monitored", `${set.length} / ${all.length}`, `<span class="muted-t">with a target, stop or trailing stop</span>`),
      kpi("Alerts", `<span class="${hitTp || hitSl ? "warn-t" : ""}">${hitTp + hitSl}</span>`,
        `<span class="up">${hitTp} target</span> · <span class="down">${hitSl} stop</span> · ${nearN} near`),
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
    const old = p ? { target_price: p.target_price, stop_price: p.stop_price, trail_pct: p.trail_pct } : null;
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
    const px = mode() === "pct" ? r.buy * (1 + v / 100) : v;
    return px > 0 ? round(px) : undefined;
  }

  const tbl = $("#tg-table");
  tbl.addEventListener("change", (e) => {
    const el = e.target.closest("input[data-f]");
    if (!el) return;
    const r = lots().map(evalLot).find((x) => x.p.id === +el.dataset.id);
    if (!r) return;
    const v = parse(r, el.dataset.f, el.value.trim());
    if (v === undefined) { showErr(el.dataset.f === "trail_pct" ? "Trailing stop: a % between 0 and 100." : "Enter a price above 0."); return; }
    el.defaultValue = el.value;
    patch(r.p.id, { [el.dataset.f]: v });
  });
  tbl.addEventListener("focusout", () => setTimeout(() => { if (pending && !tbl.contains(document.activeElement)) render(); }, 0));
  tbl.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[data-f]")) e.target.blur(); });
  tbl.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const r = lots().map(evalLot).find((x) => x.p.id === +tr.dataset.id);
    if (!r) return;
    const p = r.p;
    if (e.target.closest(".sell")) {
      const px = r.st === "tp" ? r.tp : r.st === "sl" ? r.stop : r.price;
      openTx("SELL", { symbol: p.symbol, account: p.account || "", quantity: +p.quantity.toFixed(8),
        price: px != null ? round(px) : null, currency: r.pccy,
        notes: r.st === "tp" ? "Target reached" : r.st === "sl" ? "Stop reached" : null });
      const f = $("#tx-form");
      f?.price?.dispatchEvent(new Event("input", { bubbles: true }));   // prefill the fee rule
    } else if (e.target.closest(".copy")) {
      const sibs = lots().filter((x) => x.symbol === p.symbol && x.id !== p.id);
      if (!sibs.length) return showErr(`This is your only open buy of ${p.symbol}.`);
      if (!confirm(`Use target ${p.target_price ?? "—"}, stop ${p.stop_price ?? "—"}, trailing ${p.trail_pct ?? "—"}% for all ${sibs.length + 1} buys of ${p.symbol}?`)) return;
      for (const s of sibs) {
        if (!(await patch(s.id, { target_price: p.target_price ?? null, stop_price: p.stop_price ?? null, trail_pct: p.trail_pct ?? null }))) break;
      }
    } else if (e.target.closest(".clear")) {
      patch(p.id, { target_price: null, stop_price: null, trail_pct: null });
    }
  });
  tbl.addEventListener("mouseover", (e) => {
    const bar = e.target.closest(".rb[data-id]");
    if (!bar) return;
    const r = lots().map(evalLot).find((x) => x.p.id === +bar.dataset.id);
    if (!r) return;
    const b = base(), c = r.pccy;
    const line = (k, v, extra = "") => `<dt>${k}</dt><dd>${v}${extra}</dd>`;
    showTip(`<div class="tt-head"><b>${esc(r.p.symbol || r.p.name)}</b>${r.p.bought_at ? ` · bought ${fmtDate(r.p.bought_at)}` : ""}</div><dl>
      ${line("Target", r.tp != null ? fmtPrice(r.tp, c) : "—", r.tp != null ? ` <span class="muted-t">${pctTxt(vsBuy(r.tp, r.buy))} vs buy</span>` : "")}
      ${line("Now", r.price != null ? fmtPrice(r.price, c) : "—", r.price != null ? ` <span class="${cls(r.p.pnl_pct)}">${pctTxt(r.p.pnl_pct)}</span>` : "")}
      ${line("Buy", fmtPrice(r.buy, c))}
      ${r.stop != null ? line(r.stopSrc === "trail" ? `Stop (trailing ${r.p.trail_pct}%)` : "Stop", fmtPrice(r.stop, c), ` <span class="muted-t">${pctTxt(vsBuy(r.stop, r.buy))} vs buy</span>`) : ""}
      ${r.peak != null ? line("Peak since buy", fmtPrice(r.peak, c), r.peakDate ? ` <span class="muted-t">${fmtDate(r.peakDate)}</span>` : "") : ""}
      ${r.atTp != null ? line("P/L at target", `<span class="${cls(r.atTp)}">${fmtSigned(r.atTp, b)}</span>`, r.fee ? ` <span class="muted-t">after ${fmtMoney(r.fee, b)} fee</span>` : "") : ""}
      ${r.atSl != null ? line("P/L at stop", `<span class="${cls(r.atSl)}">${fmtSigned(r.atSl, b)}</span>`) : ""}
      ${line("P/L now", `<span class="${cls(r.p.pnl)}">${fmtSigned(r.p.pnl, b)}</span>`)}</dl>`, e);
  });
  tbl.addEventListener("mousemove", (e) => { if (e.target.closest(".rb[data-id]")) moveTip(e); });
  tbl.addEventListener("mouseout", (e) => { if (e.target.closest(".rb[data-id]")) hideTip(); });

  $("#tg-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    save({ mode: b.dataset.v }); render();
  });
  $("#tg-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    save({ filter: b.dataset.v }); render();
  });
  $("#tg-near").addEventListener("change", (e) => {
    const v = +e.target.value;
    if (v > 0 && v <= 50) { save({ near: v }); render(); badge(); }
  });

  // fill buys that have no exit yet
  for (const [id, k] of [["#tg-fill-tp", "fill_tp"], ["#tg-fill-sl", "fill_sl"], ["#tg-fill-tr", "fill_tr"]]) {
    $(id).value = S()[k] ?? "";
    $(id).addEventListener("change", (e) => save({ [k]: e.target.value === "" ? null : +e.target.value }));
  }
  $("#tg-fill-btn").addEventListener("click", async () => {
    const tp = $("#tg-fill-tp").value, sl = $("#tg-fill-sl").value, tr = $("#tg-fill-tr").value;
    if (tp === "" && sl === "" && tr === "") return showErr("Enter a target %, a stop % or a trailing %.");
    if ((sl !== "" && !(+sl > 0 && +sl < 100)) || (tr !== "" && !(+tr > 0 && +tr < 100)) || (tp !== "" && !(+tp > -100))) {
      return showErr("Stop and trailing are % below (0–100); target is % above the buy price.");
    }
    const jobs = [];
    for (const r of lots().map(evalLot)) {
      const body = {};
      if (tp !== "" && r.p.target_price == null) body.target_price = round(r.buy * (1 + +tp / 100));
      if (sl !== "" && r.p.stop_price == null) body.stop_price = round(r.buy * (1 - +sl / 100));
      if (tr !== "" && r.p.trail_pct == null) body.trail_pct = +tr;
      if (Object.keys(body).length) jobs.push([r.p.id, body]);
    }
    if (!jobs.length) return showErr("Every buy already has these exits — edit them in the table.");
    if (!confirm(`Set exits on ${jobs.length} buy${jobs.length > 1 ? "s" : ""}? Exits you already set are kept.`)) return;
    for (const [id, body] of jobs) { if (!(await patch(id, body))) break; }
    if (tr !== "") { await loadPeaks(); render(); }
  });

  async function refresh(silent) {
    if (!state.port) return;
    render();
    if (Date.now() - peaksAt > 60e3 || !silent) { await loadPeaks(); render(); badge(); }
  }

  return { refresh, badge };
};
