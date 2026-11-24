/* stonks-dash — US pre-market & after-hours (Market hours tab, plus badges in Holdings and the ticker sheet).
 * Pre-market: 04:00–09:30 New York (10:00–15:30 in Madrid); after-hours: 16:00–20:00 New York. Prices there come
 * from fewer trades, so they move more and can differ from the open. Index futures (S&P 500, Nasdaq 100…) trade
 * almost round the clock and are the usual gauge of how Wall Street will open. */
window.StonksPremarket = function (ctx) {
  "use strict";
  const { api, esc, state, base, fmtMoney, fmtPrice, fmtSigned, fmtPct, cls, $ } = ctx;
  const box = $("#h-pre");
  let data = null, at = 0, key = "", loading = false;
  const listeners = [];
  // US listings: real pre-market / after-hours trades; European funds while closed: the indicative estimate
  const bySym = () => Object.fromEntries((data?.rows || []).map((r) => [r.symbol, r]).concat((data?.etfs || [])
    .filter((e) => e.state === "closed" && e.move_pct != null)
    .map((e) => [e.symbol, { kind: "est", price: e.est_price, change_pct: e.move_pct, currency: e.currency, time: null, drivers: e.drivers, regular: e.last_close }])));
  const openRows = new Set();
  const driversTxt = (ds) => (ds || []).slice(0, 3).map((d) => d.label).join(", ");

  async function load(force) {
    const k = base();
    if (loading) return;
    if (!force && data && k === key && Date.now() - at < 30e3) { draw(); return; }
    loading = true;
    try { data = await api(`/api/premarket?base=${encodeURIComponent(k)}`); at = Date.now(); key = k; }
    catch (e) { if (box && !data) box.innerHTML = `<div class="empty">Could not load pre-market data: ${esc(e.message)}</div>`; return; }
    finally { loading = false; }
    state.pre = bySym();
    draw();
    listeners.forEach((f) => f());
  }

  const tfmt = (ms, o) => new Intl.DateTimeFormat(undefined, o).format(ms);
  const hm = (ms) => tfmt(ms, { hour: "2-digit", minute: "2-digit" });
  function inTxt(ms) {
    const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
    return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
  }
  const NAME = { pre: "Pre-market", regular: "Regular session", post: "After-hours", closed: "Closed" };

  function phaseLine(p) {
    const when = (ms) => { const d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? hm(ms) : `${tfmt(ms, { weekday: "short" })} ${hm(ms)}`; };
    const k = p.k;
    const cur = k === "closed" ? `<span class="st st-closed">US market closed</span>` : `<span class="st ${k === "regular" ? "st-open" : "st-ext"}">US ${NAME[k].toLowerCase()}</span>`;
    const end = k === "closed" ? (p.next_at ? `${NAME[p.next] || p.next} opens ${when(p.next_at)} (in ${inTxt(p.next_at)})` : "")
      : `${k === "regular" ? "closes" : "ends"} ${when(p.until)} (in ${inTxt(p.until)})${p.next && p.next !== k ? ` · then ${NAME[p.next].toLowerCase()}` : ""}`;
    const today = new Date().toISOString().slice(0, 10);
    const hol = (p.holidays || []).filter((h) => h.date >= today).slice(0, 1).map((h) => ` · <span class="warn-t">${esc(h.name)} ${esc(h.date)}: closed</span>`).join("");
    const early = (p.early || []).filter((e) => e.date >= today).slice(0, 1).map((e) => ` · <span class="warn-t">early close ${esc(e.date)} at ${hm(e.close)}</span>`).join("");
    return `${cur} <span class="pm-when">${end}${hol}${early}</span>`;
  }

  function spark(vals, up) {
    const v = (vals || []).filter((x) => x != null);
    if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), W = 70, H = 22;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - ((x - lo) / (hi - lo || 1)) * H).toFixed(1)}`).join(" ");
    return `<svg class="pm-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><polyline points="${pts}" stroke="${up ? "var(--up)" : "var(--down)"}"/></svg>`;
  }

  function draw() {
    if (!box || !data) return;
    const b = data.base, t = data.totals;
    const fut = data.futures.map((f) => `<div class="pm-fut" title="${esc(f.symbol)} · change since the previous settlement / close">
        <div class="k">${esc(f.name)}</div><div class="v">${!f.ok ? "—" : f.symbol === "EURUSD=X" ? f.price.toFixed(4) : f.symbol === "^VIX" ? f.price.toFixed(2) : esc(fmtPrice(f.price, f.currency || "USD"))}</div>
        <div class="d ${cls(f.change_pct)}">${f.change_pct == null ? "" : fmtPct(f.change_pct)}</div>${spark(f.spark, (f.change_pct || 0) >= 0)}</div>`).join("");
    const held = data.rows.filter((r) => r.held), watch = data.rows.filter((r) => !r.held);
    const row = (r) => `<tr class="pm-row" data-sym="${esc(r.symbol)}"><td class="asset"><b>${esc(r.symbol)}</b>${r.held ? "" : ' <span class="pill">watch</span>'}<div class="sub">${esc(r.name || "")}</div></td>
      <td class="num">${r.regular != null ? fmtPrice(r.regular, r.currency) : "—"}<div class="sub">${r.kind === "post" ? "today's close" : "last close"}</div></td>
      <td class="num">${r.price != null ? `<b>${fmtPrice(r.price, r.currency)}</b><div class="sub">${r.kind === "pre" ? "pre-market" : "after-hours"}${r.time ? ` · ${hm(r.time * 1000)}` : ""}</div>` : '<span class="sub">no trades yet</span>'}</td>
      <td class="num ${cls(r.change_pct)}">${r.change_pct == null ? "—" : fmtPct(r.change_pct)}</td>
      <td class="num ${cls(r.impact)}">${r.impact == null ? "" : fmtSigned(r.impact, b)}</td></tr>`;
    const table = data.rows.length ? `<div class="table-wrap"><table class="grid pm-table"><thead><tr><th>Asset</th><th class="num">Regular</th><th class="num">Outside hours</th><th class="num">Change</th><th class="num" title="Units you hold × the move, in ${esc(b)}">Your P&amp;L</th></tr></thead>
        <tbody>${held.map(row).join("")}${watch.map(row).join("")}</tbody></table></div>`
      : '<p class="hint">You hold no US-listed stocks or ETFs (and none on the Highs &amp; lows watch list). Yahoo only publishes pre-market and after-hours prices for US listings.</p>';
    const sum = held.some((r) => r.impact != null) ? `<p class="pm-sum">If the US open matched these prices: <b class="${cls(t.impact)}">${fmtSigned(t.impact, b)}</b> on your US holdings
        (${fmtPct(t.impact_pct)}), ${fmtPct(t.portfolio_pct)} of your whole portfolio.</p>` : "";
    box.innerHTML = `<div class="pm-phase">${phaseLine(data.phase)}</div>
      <div class="pm-futs">${fut}</div>${sum}${table}${etfTable()}
      <p class="hint">US pre-market runs 04:00–09:30 and after-hours 16:00–20:00 New York time (${hm(nyToday(4))}–${hm(nyToday(9.5))} and ${hm(nyToday(16))}–${hm(nyToday(20))} your time).
        Fewer trades happen then, so prices jump more and the open can differ. Futures on the S&amp;P 500, Nasdaq 100, Dow and Russell 2000 trade almost round the clock and show where Wall Street is heading; the VIX is the market's expected volatility.
        European listings have no pre-market on Yahoo (some brokers, like Trade Republic, quote them from 07:30 on their own venue). Tap a row for its chart.</p>`;
  }
  // European-listed funds: indicative move while their exchange (Xetra, Euronext… 09:00–17:30) is closed
  function etfTable() {
    const E = data.etfs || [];
    if (!E.length) return "";
    const b = data.base, t = data.totals;
    const closed = E.filter((e) => e.state === "closed");
    const row = (e) => {
      const est = e.state === "closed" && e.move_pct != null;
      const open = openRows.has(e.symbol);
      const det = open && est ? `<tr class="pm-det"><td colspan="5"><div class="pm-drv">${e.drivers.map((d) => `<div><span>${esc(d.country)} <i>${d.weight_pct.toFixed(0)}%</i> · ${esc(d.label)}</span>
          <span class="${cls(d.market_pct)}">${fmtPct(d.market_pct)}</span>${e.hedged ? "" : `<span class="sub" title="Currency against ${esc(e.currency)}">fx ${fmtPct(d.fx_pct)}</span>`}
          <b class="${cls(d.contribution_pct)}">${fmtPct(d.contribution_pct)}</b></div>`).join("")}</div>
          <p class="hint">Weights from the fund's index profile (${esc(e.profile)}${e.covered_pct < 99.9 ? `; ${e.covered_pct.toFixed(0)}% of it has a gauge, scaled to 100%` : ""}), moves since its last close at ${esc(when(e.last_close_at))}.
          ${e.hedged ? "Currency-hedged: exchange rates left out." : "Not hedged: a stronger dollar, yen… raises it in " + esc(e.currency) + "."} Change the profile in Exposure if it's wrong.</p></td></tr>` : "";
      return `<tr class="pm-etf" data-sym="${esc(e.symbol)}"><td class="asset">${est ? `<button class="exp">${open ? "▾" : "▸"}</button>` : ""}<b>${esc(e.symbol)}</b>${e.hedged ? ' <span class="pill" title="Currency-hedged share class">hedged</span>' : ""}<div class="sub">${esc(e.profile)}</div></td>
        <td class="num">${fmtPrice(e.last_close, e.currency)}<div class="sub">${e.state === "open" ? "trading now" : `close ${esc(when(e.last_close_at))}`}</div></td>
        <td class="num">${est ? `<b>${fmtPrice(e.est_price, e.currency)}</b><div class="sub" title="${esc(driversTxt(e.drivers))}">indicative</div>` : e.state === "open" ? '<span class="sub">live price</span>' : '<span class="sub">no gauge</span>'}</td>
        <td class="num ${cls(est ? e.move_pct : e.day_pct)}">${est ? fmtPct(e.move_pct) : e.state === "open" ? `${fmtPct(e.day_pct)}<div class="sub">today</div>` : "—"}</td>
        <td class="num ${cls(e.impact)}">${e.impact == null ? "" : fmtSigned(e.impact, b)}</td></tr>${det}`;
    };
    const sum = closed.some((e) => e.impact != null) ? `<p class="pm-sum">Indicative for your European-listed funds: <b class="${cls(t.etf_impact)}">${fmtSigned(t.etf_impact, b)}</b>
      (${fmtPct(t.etf_value ? t.etf_impact / t.etf_value * 100 : null)}) since their last close.</p>` : "";
    return `<h4 class="pm-h">Your ETFs listed in Europe <span class="hint">· estimated from the markets they hold while their exchange is closed (09:00–17:30)</span></h4>${sum}
      <div class="table-wrap"><table class="grid pm-table"><thead><tr><th>Fund</th><th class="num">Last close</th><th class="num">Now (est.)</th><th class="num">Move</th><th class="num">Your P&amp;L</th></tr></thead>
      <tbody>${E.map(row).join("")}</tbody></table></div>
      <p class="hint">Indicative value = each country's weight in the fund × that market's move since the fund last traded (US: S&amp;P 500 futures, Japan: Nikkei 225, China: Hang Seng…), converted into the fund's currency unless it's hedged.
        Markets that haven't traded since (Europe before 09:00) count as unchanged. It's an estimate, not a quote: the real opening price also reflects spreads and demand. Tap ▸ for the breakdown.</p>`;
  }
  function when(ms) { const d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? hm(ms) : `${tfmt(ms, { weekday: "short" })} ${hm(ms)}`; }

  // a New York wall-clock hour today, as a timestamp in this browser's zone
  function nyToday(h) {
    const now = new Date();
    const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const off = now - ny;
    const d = new Date(ny); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
    return d.getTime() + off;
  }

  box?.addEventListener("click", (e) => {
    const x = e.target.closest(".pm-etf[data-sym]");
    if (x) {
      if (e.target.closest(".exp")) { const s = x.dataset.sym; openRows.has(s) ? openRows.delete(s) : openRows.add(s); draw(); }
      else ctx.openSheet(x.dataset.sym);
      return;
    }
    const r = e.target.closest(".pm-row[data-sym]");
    if (r) ctx.openSheet(r.dataset.sym);
  });

  // badge for one symbol (Holdings, sheet): "pre −1.3% · 13:52"
  function badge(sym, cur) {
    const r = state.pre?.[sym];
    if (!r || r.price == null || r.change_pct == null) return "";
    if (r.kind === "est") {
      return `<span class="pm-badge est ${cls(r.change_pct)}" title="Exchange closed. Indicative ${esc(fmtPrice(r.price, r.currency))} from the markets this fund holds (${esc(driversTxt(r.drivers))}) since its last close — an estimate, not a trade">est ${fmtPct(r.change_pct)}</span>`;
    }
    return `<span class="pm-badge ${cls(r.change_pct)}" title="${r.kind === "pre" ? "Pre-market" : "After-hours"} price ${esc(fmtPrice(r.price, cur || r.currency))}${r.time ? ` at ${hm(r.time * 1000)}` : ""}, vs ${r.kind === "post" ? "today's" : "the last"} close">${r.kind === "pre" ? "pre" : "after"} ${fmtPct(r.change_pct)}</span>`;
  }
  return { load, draw, badge, row: (sym) => state.pre?.[sym], onChange: (f) => listeners.push(f) };
};
