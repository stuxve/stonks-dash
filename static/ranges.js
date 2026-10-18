/* stonks-dash — Highs & lows: for each holding, the highest and lowest close and the biggest one-day rise and fall
 * of the last 15 days, 6 months and 1 year, and where today's price and today's move sit against them. */
window.StonksRanges = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, fmtPrice, fmtDate, cls, $, $$ } = ctx;
  const WIN = [["15d", "15 days", "15-day"], ["6m", "6 months", "6-month"], ["1y", "1 year", "1-year"]];
  const S = () => state.settings.ranges || (state.settings.ranges = {});
  const sortKey = () => S().sort || "from_hi_1y";
  let data = null, at = 0;

  const pct = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`);
  const dS = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(iso + "T00:00:00")) : "");

  async function load(force) {
    if (!force && data && Date.now() - at < 120e3) return draw();
    try { data = (await api("/api/moves")).symbols || {}; at = Date.now(); } catch (e) {
      $("#rg-table").innerHTML = `<tbody><tr><td class="hint">${esc(e.message)}</td></tr></tbody>`; return;
    }
    draw();
  }

  function holdings() {
    const by = new Map();
    const total = state.port?.totals?.value || 0;
    for (const p of state.port?.positions || []) {
      if (!p.symbol || p.quote_type === "MANUAL") continue;
      const h = by.get(p.symbol) || { symbol: p.symbol, name: p.display_name, ccy: p.price_currency, value: 0, price: p.price, day: p.changes?.["1D"] };
      h.value += p.value || 0;
      by.set(p.symbol, h);
    }
    return [...by.values()].map((h) => ({ ...h, weight: total ? h.value / total * 100 : null, m: data?.[h.symbol] }));
  }

  // one badge per kind, for the longest window it holds in (a 1-year high is also a 6-month and 15-day high)
  const KINDS = [
    ["at_hi", "ok-s", (l, a) => `${a} high`, (l) => `Today's close is the highest of the last ${l}`],
    ["at_lo", "bad-s", (l, a) => `${a} low`, (l) => `Today's close is the lowest of the last ${l}`],
    ["today_is_best", "ok-s", (l) => `best day in ${l}`, (l) => `Today's rise is the biggest one-day rise of the last ${l}`],
    ["today_is_worst", "bad-s", (l) => `worst day in ${l}`, (l) => `Today's fall is the biggest one-day fall of the last ${l}`],
  ];
  function badges(m) {
    return KINDS.map(([key, c, txt, tip]) => {
      const hit = [...WIN].reverse().find(([k]) => m?.windows?.[k]?.[key]);
      return hit ? `<span class="pill ${c}" title="${esc(tip(hit[1]))}">${txt(hit[1], hit[2])}</span>` : "";
    }).join("");
  }

  function winCell(h, k, l) {
    const w = h.m?.windows?.[k];
    if (!w) return `<td class="rgc"><span class="sub">not enough history</span></td>`;
    const c = h.ccy, pos = Math.max(0, Math.min(1, w.pos));
    const tip = `Last ${l} (${w.n} closes)\nHighest close: ${fmtPrice(w.hi, c)} on ${fmtDate(w.hi_date)} — now ${pct(w.from_hi)}\nLowest close: ${fmtPrice(w.lo, c)} on ${fmtDate(w.lo_date)} — now ${pct(w.from_lo)}\n`
      + `Now at ${Math.round(pos * 100)}% of the range · change over the period ${pct(w.change)}\n`
      + (w.best ? `Biggest one-day rise: ${pct(w.best.ret)} on ${fmtDate(w.best.date)}\nBiggest one-day fall: ${pct(w.worst.ret)} on ${fmtDate(w.worst.date)}\nToday: ${pct(w.today)}` : "");
    return `<td class="rgc" title="${esc(tip)}">
      <div class="rgbar"><i class="fill" style="width:${(pos * 100).toFixed(1)}%"></i><i class="dot" style="left:${(pos * 100).toFixed(1)}%"></i></div>
      <div class="rgl"><span class="sub">min</span> ${fmtPrice(w.lo, c)} <span class="up">${pct(w.from_lo)}</span> <span class="sub">${dS(w.lo_date)}</span></div>
      <div class="rgl"><span class="sub">max</span> ${fmtPrice(w.hi, c)} <span class="${w.from_hi < -0.0005 ? "down" : "up"}">${w.from_hi < -0.0005 ? pct(w.from_hi) : "at max"}</span> <span class="sub">${dS(w.hi_date)}</span></div>
      ${w.best ? `<div class="rgl sub">day <span class="up">${pct(w.best.ret)}</span> / <span class="down">${pct(w.worst.ret)}</span> · period <span class="${cls(w.change)}">${pct(w.change)}</span></div>` : ""}</td>`;
  }

  const SORTS = {
    from_hi_1y: ["Furthest below 1-year max", (h) => h.m?.windows?.["1y"]?.from_hi ?? 9, 1],
    pos_6m: ["Lowest in 6-month range", (h) => h.m?.windows?.["6m"]?.pos ?? 9, 1],
    from_lo_1y: ["Highest above 1-year min", (h) => -(h.m?.windows?.["1y"]?.from_lo ?? -9), 1],
    chg_15d: ["15-day change", (h) => h.m?.windows?.["15d"]?.change ?? -9, -1],
    weight: ["Weight", (h) => h.weight ?? 0, -1],
  };

  function draw() {
    const t = $("#rg-table");
    if (!t || !state.port) return;
    $("#rg-sort").innerHTML = Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === sortKey() ? "selected" : ""}>${l}</option>`).join("");
    const rows = holdings();
    const [, f, dir] = SORTS[sortKey()];
    rows.sort((a, c) => (f(a) - f(c)) * dir);
    // summary: what's at a high / low right now
    const cnt = (k, key) => rows.filter((h) => h.m?.windows?.[k]?.[key]).map((h) => h.symbol);
    const sum = WIN.map(([k, l]) => {
      const hi = cnt(k, "at_hi"), lo = cnt(k, "at_lo");
      return `<div class="kpi"><div class="k">Last ${l}</div><div class="v"><span class="up">${hi.length}</span> <small>at max</small> · <span class="down">${lo.length}</span> <small>at min</small></div>
        <div class="d">${hi.length ? `<span class="up">↑ ${hi.map(esc).join(", ")}</span>` : ""}${hi.length && lo.length ? " · " : ""}${lo.length ? `<span class="down">↓ ${lo.map(esc).join(", ")}</span>` : ""}${!hi.length && !lo.length ? "none at an extreme" : ""}</div></div>`;
    }).join("");
    $("#rg-kpis").innerHTML = sum;
    t.innerHTML = `<thead><tr><th>Holding</th><th class="num">Now</th>${WIN.map(([, l]) => `<th class="rgc">Last ${l} <span class="sub">min · max · biggest day</span></th>`).join("")}</tr></thead>
      <tbody>${rows.map((h) => `<tr><td class="asset"><b>${esc(h.symbol)}</b><div class="sub">${esc(h.name || "")}${h.weight != null ? ` · ${h.weight.toFixed(1)}%` : ""}</div><div class="rg-badges">${badges(h.m)}</div></td>
        <td class="num">${h.price != null ? fmtPrice(h.price, h.ccy) : "—"}<div class="sub ${cls(h.day)}">${h.day != null ? `${h.day > 0 ? "+" : ""}${h.day.toFixed(2)}% today` : ""}</div></td>
        ${WIN.map(([k, l]) => winCell(h, k, l)).join("")}</tr>`).join("")}</tbody>`;
  }

  $("#rg-sort").addEventListener("change", (e) => { saveSettings({ ranges: { ...S(), sort: e.target.value } }); draw(); });
  function refresh(silent) { load(!silent); }
  return { refresh };
};
