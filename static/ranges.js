/* stonks-dash — Highs & lows: for each holding (and any extra tickers you add), the highest and lowest close and the
 * biggest one-day rise and fall of the last 15 days, 6 months and 1 year, and where today's price and move sit against them. */
window.StonksRanges = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, fmtPrice, fmtDate, cls, attachSearch, $, $$ } = ctx;
  const WIN = [["15d", "15 days", "15-day"], ["6m", "6 months", "6-month"], ["1y", "1 year", "1-year"]];
  const S = () => state.settings.ranges || (state.settings.ranges = {});
  const sortKey = () => S().sort || "from_hi_1y";
  const extras = () => S().extra || [];
  const intra = () => (S().basis || "intra") === "intra";
  // the min/max view of a window: intraday highs and lows, or closes (falls back to closes when Yahoo has no intraday data)
  const V = (w) => (w && intra() && w.intra ? w.intra : w);
  let data = null, missing = {}, extraInfo = {}, at = 0, loadedFor = "";

  const pct = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`);
  const dS = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(iso + "T00:00:00")) : "");

  async function load(force) {
    const key = extras().join(",");
    if (!force && data && key === loadedFor && Date.now() - at < 120e3) return draw();
    try {
      const r = await api(`/api/moves${key ? `?extra=${encodeURIComponent(key)}` : ""}`);
      data = r.symbols || {}; missing = r.missing || {}; extraInfo = r.extra || {}; at = Date.now(); loadedFor = key;
    } catch (e) {
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
    const rows = [...by.values()].map((h) => ({ ...h, weight: total ? h.value / total * 100 : null }));
    for (const sym of extras()) {
      if (by.has(sym)) continue;
      const x = extraInfo[sym] || {};
      rows.push({ symbol: sym, name: x.name, ccy: x.currency, price: x.price, day: x.day, weight: null, watch: true, bad: x.ok === false });
    }
    return rows.map((h) => ({ ...h, m: data?.[h.symbol], miss: missing[h.symbol] }));
  }

  // one badge per kind, for the longest window it holds in (a 1-year high is also a 6-month and 15-day high)
  const KINDS = [
    ["at_hi", "ok-s", (l, a) => `${a} high`, (l) => intra() ? `Today's intraday high is the highest price of the last ${l}` : `Today's close is the highest of the last ${l}`],
    ["at_lo", "bad-s", (l, a) => `${a} low`, (l) => intra() ? `Today's intraday low is the lowest price of the last ${l}` : `Today's close is the lowest of the last ${l}`],
    ["today_is_best", "ok-s", (l) => `best day in ${l}`, (l) => `Today's rise is the biggest one-day rise of the last ${l}`],
    ["today_is_worst", "bad-s", (l) => `worst day in ${l}`, (l) => `Today's fall is the biggest one-day fall of the last ${l}`],
  ];
  function badges(m) {
    return KINDS.map(([key, c, txt, tip]) => {
      const hit = [...WIN].reverse().find(([k]) => (key.startsWith("at_") ? V(m?.windows?.[k]) : m?.windows?.[k])?.[key]);
      return hit ? `<span class="pill ${c}" title="${esc(tip(hit[1]))}">${txt(hit[1], hit[2])}</span>` : "";
    }).join("");
  }

  function winCell(h, k, l) {
    const w = h.m?.windows?.[k];
    if (!w) {
      const why = h.bad ? "ticker not found" : h.miss ? (h.miss.closes ? `Yahoo has only ${h.miss.closes} closes (since ${fmtDate(h.miss.first)}) and no proxy was found` : "Yahoo returned no price history and no proxy was found")
        : h.m ? `less than 3 closes in the last ${l}` : "loading…";
      return `<td class="rgc"><span class="sub">${esc(why)}</span></td>`;
    }
    const c = h.ccy, x = V(w), pos = Math.max(0, Math.min(1, x.pos));
    const it = w.intra;
    const tip = `Last ${l} (${w.n} sessions)\n`
      + (it ? `Intraday high: ${fmtPrice(it.hi, c)} on ${fmtDate(it.hi_date)} — now ${pct(it.from_hi)}\nIntraday low: ${fmtPrice(it.lo, c)} on ${fmtDate(it.lo_date)} — now ${pct(it.from_lo)}\n`
        + (it.real_days < it.days ? `(${it.days - it.real_days} of ${it.days} days have no intraday data and use the close)\n` : "") : "No intraday highs and lows from Yahoo for this window\n")
      + `Highest close: ${fmtPrice(w.hi, c)} on ${fmtDate(w.hi_date)} — now ${pct(w.from_hi)}\nLowest close: ${fmtPrice(w.lo, c)} on ${fmtDate(w.lo_date)} — now ${pct(w.from_lo)}\n`
      + `Now at ${Math.round(pos * 100)}% of the ${x === it ? "intraday" : "closing"} range · change over the period ${pct(w.change)}\n`
      + (w.best ? `Biggest one-day rise: ${pct(w.best.ret)} on ${fmtDate(w.best.date)}\nBiggest one-day fall: ${pct(w.worst.ret)} on ${fmtDate(w.worst.date)}\nToday: ${pct(w.today)}` : "");
    return `<td class="rgc" title="${esc(tip)}">
      <div class="rgbar"><i class="fill" style="width:${(pos * 100).toFixed(1)}%"></i><i class="dot" style="left:${(pos * 100).toFixed(1)}%"></i></div>
      <div class="rgl"><span class="sub">min</span> ${fmtPrice(x.lo, c)} <span class="up">${pct(x.from_lo)}</span> <span class="sub">${dS(x.lo_date)}</span></div>
      <div class="rgl"><span class="sub">max</span> ${fmtPrice(x.hi, c)} <span class="${x.from_hi < -0.0005 ? "down" : "up"}">${x.from_hi < -0.0005 ? pct(x.from_hi) : "at max"}</span> <span class="sub">${dS(x.hi_date)}</span>${intra() && !it ? ` <span class="sub" title="Yahoo has no intraday highs and lows here">(close)</span>` : ""}</div>
      ${w.best ? `<div class="rgl sub">day <span class="up">${pct(w.best.ret)}</span> / <span class="down">${pct(w.worst.ret)}</span> · period <span class="${cls(w.change)}">${pct(w.change)}</span></div>` : ""}</td>`;
  }

  function proxyNote(m) {
    if (m?.source) return `<div class="sub rg-proxy" title="${esc(`Yahoo's prices for this listing are short or stale, so everything here uses ${m.source}, another listing of the same fund (same currency and price), including intraday highs and lows.`)}">prices from ${esc(m.source)} ⓘ</div>`;
    const p = m?.proxy;
    if (!p) return "";
    const what = p.kind === "listing" ? "another listing of the same fund" : p.kind === "manual" ? "the proxy you chose in Risk" : `an ETF on the same index${p.hedged ? " (its own currency, as your fund is hedged)" : ""}`;
    const tip = `Yahoo's history for this listing is short${p.until ? `: it starts on ${fmtDate(p.until)}` : ""}. Before that, prices come from ${p.symbol}, ${what}, scaled to join this listing's first close. Highs and lows from that part are estimates.`;
    return `<div class="sub rg-proxy" title="${esc(tip)}">${p.until ? `before ${dS(p.until)}: ` : ""}via ${esc(p.symbol)} ⓘ</div>`;
  }

  const SORTS = {
    from_hi_1y: ["Furthest below 1-year max", (h) => V(h.m?.windows?.["1y"])?.from_hi ?? 9, 1],
    pos_6m: ["Lowest in 6-month range", (h) => V(h.m?.windows?.["6m"])?.pos ?? 9, 1],
    from_lo_1y: ["Highest above 1-year min", (h) => -(V(h.m?.windows?.["1y"])?.from_lo ?? -9), 1],
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
    const cnt = (k, key) => rows.filter((h) => V(h.m?.windows?.[k])?.[key]).map((h) => h.symbol);
    $$("#rg-basis button").forEach((b) => b.classList.toggle("active", (b.dataset.v === "intra") === intra()));
    $("#rg-basis-note").textContent = intra() ? "Min and max are intraday lows and highs (what charts show). Biggest day is close to close." : "Min and max are daily closes. Biggest day is close to close.";
    const sum = WIN.map(([k, l]) => {
      const hi = cnt(k, "at_hi"), lo = cnt(k, "at_lo");
      return `<div class="kpi"><div class="k">Last ${l}</div><div class="v"><span class="up">${hi.length}</span> <small>at max</small> · <span class="down">${lo.length}</span> <small>at min</small></div>
        <div class="d">${hi.length ? `<span class="up">↑ ${hi.map(esc).join(", ")}</span>` : ""}${hi.length && lo.length ? " · " : ""}${lo.length ? `<span class="down">↓ ${lo.map(esc).join(", ")}</span>` : ""}${!hi.length && !lo.length ? "none at an extreme" : ""}</div></div>`;
    }).join("");
    $("#rg-kpis").innerHTML = sum;
    t.innerHTML = `<thead><tr><th>Asset</th><th class="num">Now</th>${WIN.map(([, l]) => `<th class="rgc">Last ${l} <span class="sub">min · max · biggest day</span></th>`).join("")}</tr></thead>
      <tbody>${rows.map((h) => `<tr><td class="asset"><b>${esc(h.symbol)}</b><div class="sub">${esc(h.name || "")}${h.weight != null ? ` · ${h.weight.toFixed(1)}%` : ""}</div><div class="rg-badges">${h.watch ? `<span class="pill" title="Not in your portfolio — added to this list">watch</span><button class="linkbtn rg-rm" data-sym="${esc(h.symbol)}" title="Remove from this list">remove</button>` : ""}${badges(h.m)}</div>${proxyNote(h.m)}</td>
        <td class="num">${h.price != null ? fmtPrice(h.price, h.ccy) : "—"}<div class="sub ${cls(h.day)}">${h.day != null ? `${h.day > 0 ? "+" : ""}${h.day.toFixed(2)}% today` : ""}</div></td>
        ${WIN.map(([k, l]) => winCell(h, k, l)).join("")}</tr>`).join("")}</tbody>`;
  }

  $$("#rg-basis button").forEach((b) => b.addEventListener("click", () => { saveSettings({ ranges: { ...S(), basis: b.dataset.v } }); draw(); }));
  $("#rg-sort").addEventListener("change", (e) => { saveSettings({ ranges: { ...S(), sort: e.target.value } }); draw(); });

  // extra tickers you don't hold
  function setExtras(list) { S().extra = list; saveSettings({ ranges: { ...S(), extra: list } }); drawChips(); load(true); }
  function drawChips() {
    $("#rg-extras").innerHTML = extras().map((x) => `<span class="chip-in">${esc(x)}<button data-sym="${esc(x)}" title="Remove">×</button></span>`).join("");
  }
  const addInput = $("#rg-add");
  function addSym(sym) {
    sym = (sym || "").trim().toUpperCase();
    addInput.value = "";
    if (!sym || extras().includes(sym)) return;
    if (holdings().some((h) => !h.watch && h.symbol === sym)) { $("#rg-add-note").textContent = `${sym} is already in your portfolio`; return; }
    $("#rg-add-note").textContent = "";
    setExtras([...extras(), sym].slice(0, 40));
  }
  attachSearch(addInput, (it) => addSym(it.symbol));
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && addInput.value.trim()) { e.preventDefault(); setTimeout(() => addInput.value.trim() && addSym(addInput.value), 0); } });
  const rm = (e) => { const b = e.target.closest("button[data-sym]"); if (b) setExtras(extras().filter((x) => x !== b.dataset.sym)); };
  $("#rg-extras").addEventListener("click", rm);
  $("#rg-table").addEventListener("click", (e) => { if (e.target.closest(".rg-rm")) rm(e); });
  drawChips();
  function refresh(silent) { load(!silent); }
  return { refresh };
};
