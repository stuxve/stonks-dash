/* stonks-dash frontend — vanilla JS + d3 treemap */
// starts once the dashboard is unlocked (static/lock.js)
window.StonksLock.ready.then(() => {
  "use strict";

  const PERIODS = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"];
  const RANGES = ["auto", 1, 2, 3, 5, 10, 20, 50];
  const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "DKK", "SEK", "NOK", "PLN", "JPY", "CAD", "AUD", "HKD", "CNY"];
  const SCHEMES = {
    // finviz-like stops; midpoint is a neutral gray, poles carry the sign
    classic: ["#f63538", "#bf4045", "#8b444e", "#414554", "#35764e", "#2f9e4f", "#30cc5a"],
    cvd:     ["#e5484d", "#b0434b", "#7a444f", "#414554", "#3a5a8c", "#3a72c4", "#3d8ff0"],
  };
  const TYPE_LABEL = {
    EQUITY: "Stocks", ETF: "ETFs", MUTUALFUND: "Funds", INDEX: "Indices", CRYPTOCURRENCY: "Crypto",
    FUTURE: "Futures", CURRENCY: "FX", MANUAL: "Manual",
  };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    view: "markets",
    settings: {},
    boards: [],
    boardId: null,
    heat: null,         // last heatmap payload
    port: null,         // last portfolio payload
    zoom: { markets: null, portfolio: null },
    filter: "",
    sort: { key: "value", dir: -1 },
    timer: null,
    loading: false,
  };

  // ------------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const init = { headers: {}, ...opts };
    if (opts.body !== undefined && typeof opts.body !== "string") {
      init.body = JSON.stringify(opts.body);
      init.headers["Content-Type"] = "application/json";
    }
    const r = await fetch(path, init);
    if (r.status === 401) { window.StonksLock.lost(); throw new Error("Locked"); }   // the session ended
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail.map((x) => `${(x.loc || []).slice(-1)[0] || ""}: ${x.msg}`).join("; ") : JSON.stringify(j.detail); } catch {}
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }
  const saveSettings = (patch) => {
    Object.assign(state.settings, patch);
    return api("/api/settings", { method: "PUT", body: patch }).catch(console.error);
  };

  // ------------------------------------------------------------------ formatting
  const base = () => state.settings.base_currency || "EUR";
  const fmtPct = (v, d = 2) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
  const fmtMoney = (v, ccy = base(), compact = false) => {
    if (v == null || !isFinite(v)) return "—";
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: ccy, notation: compact ? "compact" : "standard",
      maximumFractionDigits: 2, minimumFractionDigits: compact ? 0 : 2,
    }).format(v);
  };
  const fmtSigned = (v, ccy) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + fmtMoney(Math.abs(v), ccy));
  const fmtMoney0 = fmtMoney, fmtSigned0 = fmtSigned;            // renderKpis wraps them for restricted mode
  const fmtNum = (v, d = 4) => (v == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(v));
  const fmtPrice = (v, ccy) => {
    if (v == null) return "—";
    const d = v >= 1000 ? 2 : v >= 1 ? 2 : 6;
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: d }).format(v); }
    catch { return `${fmtNum(v, d)} ${ccy}`; }
  };
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  // holding period from a purchase date (YYYY-MM-DD), calendar-accurate: "12d", "3m 5d", "1y 4m"
  const todayMid = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
  const heldDays = (iso) => (iso ? Math.round((todayMid() - new Date(`${iso}T00:00:00`)) / 86400000) : null);
  function fmtHeld(iso) {
    if (!iso) return null;
    const a = new Date(`${iso}T00:00:00`), b = todayMid();
    let y = b.getFullYear() - a.getFullYear(), m = b.getMonth() - a.getMonth(), d = b.getDate() - a.getDate();
    if (d < 0) { m--; d += new Date(b.getFullYear(), b.getMonth(), 0).getDate(); }
    if (m < 0) { y--; m += 12; }
    if (y > 0) return m ? `${y}y ${m}m` : `${y}y`;
    if (m > 0) return d ? `${m}m ${d}d` : `${m}m`;
    const n = heldDays(iso);
    return n <= 0 ? "today" : `${n}d`;
  }
  const fmtDate = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T00:00:00`)) : "");
  const heldCell = (iso, prefix = "") => (iso
    ? `<td class="num" title="${prefix}Bought ${fmtDate(iso)} · ${heldDays(iso)} days">${fmtHeld(iso)}<div class="sub">${prefix}${fmtDate(iso)}</div></td>`
    : `<td class="num"><span class="sub" title="Edit the position to set its purchase date">—</span></td>`);

  // ------------------------------------------------------------------ color
  function niceRange(values) {
    const abs = values.filter((v) => v != null && isFinite(v)).map(Math.abs).sort((a, b) => a - b);
    if (!abs.length) return 3;
    const p = abs[Math.floor(abs.length * 0.85)] || abs[abs.length - 1];
    return RANGES.slice(1).find((r) => r >= p) || 50;
  }
  function makeColor(range) {
    const stops = SCHEMES[state.settings.color_scheme] || SCHEMES.classic;
    const r = range;
    const s = d3.scaleLinear().domain([-r, -2 * r / 3, -r / 3, 0, r / 3, 2 * r / 3, r]).range(stops)
      .interpolate(d3.interpolateLab).clamp(true);
    return (v) => (v == null || !isFinite(v) ? null : s(v));
  }
  function currentRange(values) {
    const sel = state.settings.color_range;
    return sel && sel !== "auto" ? +sel : niceRange(values);
  }
  function renderLegend(el, range, color, label) {
    const steps = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((k) => k * range);
    el.innerHTML = `<span class="lbl">${esc(label)}</span>` + steps.map((v) =>
      `<span class="sw" style="background:${color(v)}">${v === 0 ? "0%" : (v > 0 ? "+" : "−") + (+Math.abs(v).toFixed(1)) + "%"}</span>`).join("");
  }

  // ------------------------------------------------------------------ treemap
  /**
   * opts: tiles, groupOf(t), sizeOf(t), valueOf(t) -> pct, labelOf(t), zoom, onZoom(g), tooltip(t) -> html, color
   */
  function renderTreemap(el, opts) {
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    let tiles = opts.tiles;
    if (!tiles.length) {
      el.innerHTML = `<div class="empty">${opts.emptyHtml || "Nothing here yet."}</div>`;
      return;
    }
    const grouped = d3.groups(tiles, opts.groupOf);
    let groups = grouped.map(([name, items]) => ({ name, children: items.map((t) => ({ tile: t })) }));
    if (opts.zoom) groups = groups.filter((g) => g.name === opts.zoom);
    const showHead = groups.length > 1;

    const root = d3.hierarchy({ children: groups })
      .sum((d) => (d.tile ? Math.max(opts.sizeOf(d.tile) || 0, 0) : 0))
      .sort((a, b) => b.value - a.value);
    d3.treemap()
      .tile(d3.treemapSquarify.ratio(1.2))
      .size([W, H])
      .paddingTop((d) => (d.depth === 1 && showHead ? 18 : 0))
      .paddingInner((d) => (d.depth === 0 ? 3 : 1))
      .round(true)(root);

    const frag = document.createDocumentFragment();
    if (showHead) {
      for (const g of root.children || []) {
        const gw = g.x1 - g.x0, gh = g.y1 - g.y0;
        if (gw < 4 || gh < 4) continue;
        const div = document.createElement("div");
        div.className = "g";
        div.style.cssText = `left:${g.x0}px;top:${g.y0}px;width:${gw}px;height:${gh}px`;
        const head = document.createElement("div");
        head.className = "g-head";
        head.textContent = gw > 40 ? `${g.data.name} ›` : "";
        head.title = `Zoom into ${g.data.name}`;
        head.addEventListener("click", () => opts.onZoom(g.data.name));
        div.appendChild(head);
        frag.appendChild(div);
      }
    }
    const q = state.filter.trim().toLowerCase();
    const hits = q ? root.leaves().filter((l) => l.data.tile && opts.searchText(l.data.tile).toLowerCase().includes(q)).length : 0;
    for (const leaf of root.leaves()) {
      const t = leaf.data.tile;
      if (!t) continue;
      const w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
      if (w < 1 || h < 1) continue;
      const v = opts.valueOf(t);
      const c = opts.color(v);
      const div = document.createElement("div");
      div.className = "t" + (c ? "" : " nodata");
      div.style.cssText = `left:${leaf.x0}px;top:${leaf.y0}px;width:${w}px;height:${h}px;${c ? `background:${c}` : ""}`;
      const label = opts.labelOf(t);
      const fs = Math.min(w / (Math.max(label.length, 3) * 0.62 + 0.8), h / 2.4, 34);
      if (fs >= 8) {
        const s = document.createElement("div");
        s.className = "s";
        s.style.fontSize = `${fs}px`;
        s.textContent = label;
        div.appendChild(s);
        if (h > fs * 2.3) {
          const cc = document.createElement("div");
          cc.className = "c";
          cc.style.fontSize = `${Math.max(fs * 0.72, 8)}px`;
          cc.textContent = c ? fmtPct(v) : "n/a";
          div.appendChild(cc);
        }
      }
      if (hits && opts.searchText(t).toLowerCase().includes(q)) div.classList.add("hit");
      div.addEventListener("mouseenter", (e) => showTip(opts.tooltip(t), e));
      div.addEventListener("mousemove", moveTip);
      div.addEventListener("mouseleave", hideTip);
      div.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = opts.openSymbol?.(t);
        if (sym) { hideTip(); sheet.open(sym, opts.sheetHint?.(t) || {}); } else showTip(opts.tooltip(t), e);
      });
      frag.appendChild(div);
    }
    el.innerHTML = "";
    el.classList.toggle("filtering", hits > 0);
    el.appendChild(frag);
    return { hits, query: q };
  }

  // ------------------------------------------------------------------ tooltip
  const tip = $("#tooltip");
  function showTip(html, e) { tip.innerHTML = html; tip.hidden = false; moveTip(e); }
  function moveTip(e) {
    const pad = 14, r = tip.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener("click", hideTip);

  function sparkSvg(values, color) {
    if (!values || values.length < 2) return "";
    const W = 296, H = 36;
    const x = d3.scaleLinear().domain([0, values.length - 1]).range([1, W - 1]);
    const y = d3.scaleLinear().domain(d3.extent(values)).nice().range([H - 2, 2]);
    const line = d3.line().x((_, i) => x(i)).y((v) => y(v))(values);
    const area = d3.area().x((_, i) => x(i)).y0(H).y1((v) => y(v))(values);
    return `<svg class="tt-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" fill="${color}" opacity=".14"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function periodGrid(changes, color, selected) {
    return `<div class="tt-grid">${PERIODS.map((p) => `<span>${p}</span>`).join("")}${PERIODS.map((p) => {
      const v = changes?.[p];
      const c = color(v);
      return `<em class="${p === selected ? "sel" : ""}" style="background:${c || "#2a2e39"}">${v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1)}</em>`;
    }).join("")}</div>`;
  }

  // ------------------------------------------------------------------ generic group key
  function autoGroup(t, mode) {
    const type = TYPE_LABEL[t.quote_type] || t.quote_type || "Other";
    switch (mode) {
      case "none": return "";
      case "sector": return t.sector || (t.quote_type === "EQUITY" ? "Other" : type);
      case "industry": return t.industry || t.sector || type;
      case "type": return type;
      case "account": return t.account || "No account";
      case "group_name": return t.group_name || "Ungrouped";
      default: return t.group_name || t.sector || type; // custom
    }
  }

  // ================================================================== MARKET HOURS (static/hours.js)
  const hours = window.StonksHours({
    api, esc, state, saveSettings, fmtPct, fmtPrice, cls, makeColor, showTip, moveTip, hideTip,
    stamp: (ts) => stamp(ts), $, $$,
  });

  // ================================================================== MARKETS
  const mMap = $("#m-map");
  async function loadBoards() {
    state.boards = await api("/api/boards");
    if (!state.boards.find((b) => b.id === state.boardId)) state.boardId = state.boards[0]?.id ?? null;
    renderChips();
  }
  function renderChips() {
    $("#board-chips").innerHTML = state.boards.map((b) =>
      `<button class="chip ${b.id === state.boardId ? "active" : ""}" data-id="${b.id}" role="tab">${esc(b.name)}</button>`).join("");
  }
  $("#board-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.boardId = +b.dataset.id;
    state.zoom.markets = null;
    state.filter = ""; $("#m-filter").value = "";
    state.heat = null;
    try { localStorage.setItem("stonks.board", String(state.boardId)); } catch {}
    renderChips();
    loadMarkets();
  });
  const board = () => state.boards.find((b) => b.id === state.boardId);

  async function loadMarkets(silent = false) {
    if (state.boardId == null) {
      mMap.innerHTML = `<div class="empty">No boards. Click “+ Board” to create one.</div>`;
      return;
    }
    if (!silent && !state.heat) mMap.innerHTML = `<div class="loading">Fetching quotes…</div>`;
    const id = state.boardId;
    const data = await api(`/api/boards/${id}/heatmap?base=${base()}`);
    if (id !== state.boardId) return;
    state.heat = data;
    $("#demo-badge").hidden = data.provider !== "mock";
    const cfg = data.board.config || {};
    $("#m-size").value = cfg.size_mode || "cap";
    $("#m-group").value = cfg.group_mode || "sector";
    drawMarkets();
    stamp(data.as_of);
  }

  function drawMarkets() {
    const d = state.heat;
    if (!d) return;
    const period = state.settings.period || "1D";
    const sizeMode = $("#m-size").value, groupMode = $("#m-group").value;
    const vals = d.tiles.map((t) => t.changes?.[period]);
    const range = currentRange(vals);
    const color = makeColor(range);
    const caps = d.tiles.map((t) => t.market_cap_base).filter((v) => v > 0).sort(d3.ascending);
    const medCap = caps.length ? d3.median(caps) : 1;
    const sizeOf = (t) => {
      if (sizeMode === "equal") return 1;
      if (sizeMode === "weight") return t.weight ?? 1;
      const c = t.market_cap_base > 0 ? t.market_cap_base : medCap;
      return sizeMode === "cap_sqrt" ? Math.sqrt(c) : c;
    };
    const useName = state.settings.tile_label === "name";
    const res = renderTreemap(mMap, {
      tiles: d.tiles,
      groupOf: (t) => autoGroup(t, groupMode),
      sizeOf, color,
      valueOf: (t) => (t.ok ? t.changes?.[period] : null),
      labelOf: (t) => (useName ? t.label || t.name || t.symbol : t.symbol.replace(/^\^/, "")),
      searchText: (t) => `${t.symbol} ${t.label || ""} ${t.name || ""} ${t.sector || ""} ${t.group_name || ""}`,
      zoom: state.zoom.markets,
      onZoom: (g) => { state.zoom.markets = g; drawMarkets(); },
      emptyHtml: `This board is empty. Use <b>Edit board</b> to add symbols.`,
      tooltip: (t) => marketTip(t, period, color),
      openSymbol: (t) => t.symbol,
      sheetHint: (t) => ({ name: t.label || t.name, price: t.ok ? t.price : null, currency: t.currency, quote_type: t.quote_type }),
    });
    renderCrumbs("#m-crumbs", "markets", drawMarkets);
    if (res && res.query && !res.hits) {
      $("#m-crumbs").insertAdjacentHTML("beforeend", `<span class="nomatch">Nothing on this board matches “${esc(state.filter.trim())}”</span>`);
    }
    renderLegend($("#m-legend"), range, color, `${period} change`);
    const ok = vals.filter((v) => v != null);
    const up = ok.filter((v) => v > 0).length, down = ok.filter((v) => v < 0).length;
    $("#m-breadth").innerHTML = ok.length
      ? `<span><b class="up">▲ ${up}</b> up</span><span><b class="down">▼ ${down}</b> down</span><span>median <b class="${cls(d3.median(ok))}">${fmtPct(d3.median(ok))}</b></span>`
      : "";
  }

  function marketTip(t, period, color) {
    const v = t.changes?.[period];
    const sc = v == null ? "#8b92a1" : v >= 0 ? (SCHEMES[state.settings.color_scheme] || SCHEMES.classic)[6] : (SCHEMES[state.settings.color_scheme] || SCHEMES.classic)[0];
    if (!t.ok) return `<div class="tt-head"><span class="tt-sym">${esc(t.symbol)}</span></div><div class="tt-name">No data from provider — check the ticker.</div>`;
    const rows = [];
    if (t.market_cap_base) rows.push(["Market cap / AUM", fmtMoney(t.market_cap_base, base(), true)]);
    if (t.sector) rows.push(["Sector", esc(t.sector)]);
    if (t.industry) rows.push(["Industry", esc(t.industry)]);
    if (t.exchange) rows.push(["Exchange", esc(t.exchange)]);
    if (t.last_date) rows.push(["Last bar", t.last_date]);
    return `<div class="tt-head"><span class="tt-sym">${esc(t.symbol)}</span><span class="tt-type">${esc(TYPE_LABEL[t.quote_type] || t.quote_type || "")}</span></div>
      <div class="tt-name">${esc(t.label || t.name)}</div>
      <div class="tt-price"><b>${fmtPrice(t.price, t.currency)}</b><span class="${cls(v)}">${fmtPct(v)} · ${period}</span></div>
      ${sparkSvg(t.spark, sc)}
      ${periodGrid(t.changes, color, period)}
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  function renderCrumbs(sel, view, redraw) {
    const el = $(sel);
    const z = state.zoom[view];
    if (!z) { el.innerHTML = ""; return; }
    el.innerHTML = `<button>All</button><span>›</span><span class="cur">${esc(z)}</span><span class="hint">(Esc to go back)</span>`;
    el.querySelector("button").onclick = () => { state.zoom[view] = null; redraw(); };
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
      if (state.zoom[state.view]) { state.zoom[state.view] = null; redraw(); }
    }
  });

  $("#m-size").addEventListener("change", (e) => saveBoardConfig({ size_mode: e.target.value }));
  $("#m-group").addEventListener("change", (e) => { state.zoom.markets = null; saveBoardConfig({ group_mode: e.target.value }); });
  function saveBoardConfig(cfg) {
    const b = board();
    if (!b) return;
    Object.assign(b.config, cfg);
    if (state.heat) Object.assign(state.heat.board.config, cfg);
    drawMarkets();
    api(`/api/boards/${b.id}`, { method: "PATCH", body: { config: cfg } }).catch(console.error);
  }
  $("#m-filter").addEventListener("input", (e) => { state.filter = e.target.value; drawMarkets(); });

  // ================================================================== PORTFOLIO
  const pMap = $("#p-map");
  async function loadPortfolio(silent = false) {
    if (!silent && !state.port) pMap.innerHTML = `<div class="loading">Fetching quotes…</div>`;
    state.port = await api(`/api/portfolio?base=${base()}`);
    $("#demo-badge").hidden = state.port.provider !== "mock";
    drawPortfolio();
    loadMoves();
    pf.onPortfolio();
    sheet.refresh();
    pre.load(false);
    stamp(state.port.as_of);
  }

  // daily-move stats change slowly: refresh at most every 5 minutes (today's move is shown live from the quotes)
  // …but at once when a holding isn't in it yet (a new buy), and every minute while Yahoo had no history for one
  let movesAt = 0;
  state.movesMiss = {};
  async function loadMoves() {
    const held = (state.port?.positions || []).filter((p) => p.symbol && p.quote_type !== "MANUAL").map((p) => p.symbol);
    const age = Date.now() - movesAt;
    const unknown = held.some((s) => !state.moves?.[s] && !state.movesMiss[s]);
    const retry = held.some((s) => state.movesMiss[s]) && age > 60e3;
    if (state.moves && age < 5 * 60e3 && !unknown && !retry) return;
    movesAt = Date.now();
    try {
      const r = await api("/api/moves");
      state.moves = r.symbols || {}; state.movesMiss = r.missing || {};
      drawPortfolio();
    } catch (e) { console.warn(e); movesAt = 0; }
  }
  function noMoves(p) {
    const x = state.movesMiss?.[p.symbol];
    if (!x) return `<td class="num"><span class="sub" title="Loading the last year of daily prices…">…</span></td>`;
    const tip = `Yahoo hasn't returned a year of daily prices for ${p.symbol} (${x.closes} closes${x.first ? ` since ${x.first}` : ""}). Retrying every minute.`;
    return `<td class="num"><span class="sub warn-t" title="${esc(tip)}">no history</span></td>`;
  }

  function pView() {
    return {
      color: state.settings.p_color || "pnl",
      size: state.settings.p_size || "value",
      group: state.settings.p_group || "account",
      combine: state.settings.p_combine ?? true,
    };
  }

  // ---- combine lots: several buys of the same asset shown as one position (display only, nothing is merged in the DB)
  function combineLots(list, groupMode) {
    const buckets = new Map();
    for (const p of list) {
      const key = [
        (p.symbol || `manual:${p.display_name || p.id}`).toUpperCase(),
        groupMode === "account" ? p.account || "" : "",
        groupMode === "group_name" ? p.group_name || "" : "",
      ].join("|");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }
    return [...buckets.entries()].map(([key, lots]) => (lots.length === 1 ? lots[0] : mergeLots(key, lots)));
  }
  function mergeLots(key, lots) {
    const f = lots[0];
    const sum = (k) => (lots.some((l) => l[k] == null) ? null : lots.reduce((a, l) => a + l[k], 0));
    const uniq = (k) => [...new Set(lots.map((l) => l[k]).filter(Boolean))];
    const qty = lots.reduce((a, l) => a + l.quantity, 0);
    const sameCcy = lots.every((l) => l.currency === f.currency);
    const cost = sum("cost"), value = sum("value"), pnl = sum("pnl");
    const accounts = uniq("account"), groups = uniq("group_name");
    const dates = uniq("bought_at").sort();
    return {
      ...f,
      id: null,
      mkey: key,
      lots,
      quantity: qty,
      // weighted average in the lots' own currency; base currency if the lots were paid in different ones
      avg_cost: sameCcy ? lots.reduce((a, l) => a + l.quantity * l.avg_cost, 0) / qty : (cost != null ? cost / qty : null),
      currency: sameCcy ? f.currency : base(),
      ok: lots.every((l) => l.ok),
      value, cost, pnl,
      pnl_pct: cost ? (pnl / cost) * 100 : null,
      day_pnl: sum("day_pnl"),
      ...(() => {
        const withB = lots.filter((l) => l.bench_value != null && l.cost);
        if (!withB.length) return {};
        const c = withB.reduce((a, l) => a + l.cost, 0), bv = withB.reduce((a, l) => a + l.bench_value, 0);
        const vv = withB.reduce((a, l) => a + l.value, 0);
        return { bench_value: bv, vs_bench: ((vv - bv) / c) * 100, bench_ret: (bv / c - 1) * 100 };
      })(),
      account: accounts.length > 1 ? `${accounts.length} accounts` : accounts[0] || null,
      group_name: groups.length > 1 ? `${groups.length} groups` : groups[0] || null,
      bought_at: dates[0] || null,       // held since the first buy
      notes: null,
    };
  }
  const shownPositions = (d, v) => (v.combine ? combineLots(d.positions, v.group) : d.positions);

  function drawPortfolio() {
    const d = state.port;
    if (!d) return;
    const v = pView();
    $("#p-color").value = v.color; $("#p-size").value = v.size; $("#p-group").value = v.group;
    $("#p-combine").checked = v.combine;
    const positions = shownPositions(d, v);
    const period = state.settings.period || "1D";
    $$('.period-seg[data-scope="portfolio"]').forEach((s) => s.classList.toggle("disabled", v.color !== "period"));
    const valueOf = (p) => (!p.ok ? null : v.color === "pnl" ? p.pnl_pct : v.color === "bench" ? p.vs_bench ?? null : p.changes?.[period]);
    const vals = positions.map(valueOf);
    const range = currentRange(vals);
    const color = makeColor(range);
    const useName = state.settings.tile_label === "name";
    renderKpis(d.totals);
    // Heatmap or "P&L over time" (static/pnlhist.js) above the table
    const hist = state.settings.p_mapview === "pnl";
    $$("#p-mapview button").forEach((b) => b.classList.toggle("active", b.dataset.v === (hist ? "pnl" : "map")));
    $$("#p-sub-holdings .p-maponly").forEach((e) => { e.hidden = hist; });
    for (const id of ["#p-map", "#p-legend", "#p-crumbs"]) $(id).hidden = hist;
    $("#p-pnlh").hidden = !hist;
    renderMobileList(d, positions);
    if (hist) { pnlHist.show(d.totals); renderTable(d, positions); return; }
    renderTreemap(pMap, {
      tiles: positions,
      groupOf: (p) => autoGroup(p, v.group),
      sizeOf: (p) => (v.size === "equal" ? 1 : v.size === "cost" ? p.cost || 0 : p.value || p.cost || 0),
      color, valueOf,
      labelOf: (p) => (useName ? p.display_name || p.symbol : p.symbol || p.display_name || "?").replace(/^\^/, ""),
      searchText: (p) => `${p.symbol} ${p.display_name}`,
      zoom: state.zoom.portfolio,
      onZoom: (g) => { state.zoom.portfolio = g; drawPortfolio(); },
      emptyHtml: `No positions yet.<br><br><button class="btn primary" onclick="document.getElementById('add-position').click()">+ Add your first position</button>`,
      tooltip: (p) => portfolioTip(p, period, color, v.color),
      openSymbol: (p) => (p.symbol && p.quote_type !== "MANUAL" ? p.symbol : null),
    });
    renderCrumbs("#p-crumbs", "portfolio", drawPortfolio);
    renderLegend($("#p-legend"), range, color, v.color === "pnl" ? "Total P&L" : v.color === "bench" ? `vs ${d.benchmark?.symbol || "index"} (pp)` : `${period} change`);
    renderTable(d, positions);
  }

  // ---- restricted mode (the eye button): the amounts in the summary boxes show as dashes, until pressed again.
  // Remembered in this browser only; percentages and counts stay visible.
  try { state.private = localStorage.getItem("stonks.private") === "1"; } catch { state.private = false; }
  const HIDDEN = "––––––";
  function privBtn() {
    const btn = $("#priv-btn");
    btn.setAttribute("aria-pressed", String(!!state.private));
    btn.classList.toggle("on", !!state.private);
    btn.title = state.private ? "Restricted mode: amounts hidden. Click to show them" : "Hide the amounts in the summary boxes";
    btn.innerHTML = state.private
      ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
  privBtn();
  $("#priv-btn").addEventListener("click", () => {
    state.private = !state.private;
    try { localStorage.setItem("stonks.private", state.private ? "1" : "0"); } catch {}
    privBtn();
    if (state.port) renderKpis(state.port.totals);
  });

  function renderKpis(t) {
    const b = base();
    const hide = !!state.private;
    const fmtMoney = (v, c) => (hide ? HIDDEN : fmtMoney0(v, c));
    const fmtSigned = (v, c) => (hide ? HIDDEN : fmtSigned0(v, c));
    $("#kpis").classList.toggle("private", hide);
    $("#kpis").innerHTML = [
      ["Market value", fmtMoney(t.value, b), `${t.count} position${t.count === 1 ? "" : "s"}${t.missing ? ` · <span class="down">${t.missing} without price</span>` : ""}`],
      ["Invested", fmtMoney(t.cost, b), "cost basis at current FX"],
      ["Unrealized P&L", `<span class="${cls(t.pnl)}">${fmtSigned(t.pnl, b)}</span>`, `<span class="${cls(t.pnl)}">${fmtPct(t.pnl_pct)}</span>`],
      ["Today", `<span class="${cls(t.day_pnl)}">${fmtSigned(t.day_pnl, b)}</span>`, `<span class="${cls(t.day_pnl)}">${fmtPct(t.day_pct)}</span>`],
      ["Realized + dividends", `<span class="${cls((t.realized || 0) + (t.dividends || 0))}">${fmtSigned((t.realized || 0) + (t.dividends || 0), b)}</span>`,
        `sold ${fmtSigned(t.realized || 0, b)} · div. ${fmtSigned(t.dividends || 0, b)}${t.fees ? ` · fees ${fmtMoney(t.fees, b)}` : ""}`],
      ["Vs index", t.vs_bench == null ? "—" : `<span class="${cls(t.vs_bench)}">${t.vs_bench > 0 ? "+" : t.vs_bench < 0 ? "−" : ""}${Math.abs(t.vs_bench).toFixed(2)} pp</span>`,
        t.vs_bench == null ? `${esc(state.port?.benchmark?.symbol || "")} unavailable` : `index on same dates: ${fmtMoney(t.bench_value, b)}`],
    ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  }

  function portfolioTip(p, period, color, mode) {
    const b = base();
    const total = state.port.totals.value || 0;
    const sc = (SCHEMES[state.settings.color_scheme] || SCHEMES.classic)[(p.changes?.["1M"] ?? 0) >= 0 ? 6 : 0];
    const rows = [
      ["Quantity", fmtNum(p.quantity)],
      ["Avg. cost", fmtPrice(p.avg_cost, p.currency)],
      ["Market value", fmtMoney(p.value, b)],
      ["Invested", fmtMoney(p.cost, b)],
      ["P&L", `<span class="${cls(p.pnl)}">${fmtSigned(p.pnl, b)} (${fmtPct(p.pnl_pct)})</span>`],
      ["Today", `<span class="${cls(p.day_pnl)}">${fmtSigned(p.day_pnl, b)}</span>`],
      ["Weight", total && p.value ? fmtPct(p.value / total * 100, 1).replace("+", "") : "—"],
    ];
    const mv = state.moves?.[p.symbol];
    if (mv?.week) rows.push(["This week", `<span class="up">${pc(mv.week.best.ret)}</span> best · <span class="down">${pc(mv.week.worst.ret)}</span> worst day <span class="sub">· week ${pc(mv.week.change)}</span>`]);
    if (mv) rows.push(["Typical day", `±${(mv.median_abs * 100).toFixed(1)}% <span class="sub">· 90%: ${pc(mv.q.p5)} … ${pc(mv.q.p95)}</span>`]);
    if (p.vs_bench != null) rows.push([`Vs ${esc(state.port.benchmark?.symbol || "index")}`, `<span class="${cls(p.vs_bench)}">${fmtPP(p.vs_bench)}</span> <span class="sub">idx ${fmtPct(p.bench_ret, 1)}</span>`]);
    if (p.bought_at) rows.push([p.lots ? "Held (first buy)" : "Held", `${fmtHeld(p.bought_at)} <span class="sub">· ${fmtDate(p.bought_at)}</span>`]);
    if (p.account) rows.push([p.lots && p.account.endsWith("accounts") ? "Accounts" : "Account",
      esc(p.lots && p.account.endsWith("accounts") ? [...new Set(p.lots.map((l) => l.account))].join(", ") : p.account)]);
    if (p.notes) rows.push(["Notes", esc(p.notes)]);
    if (p.lots) {
      rows.push([`${p.lots.length} lots`, ""]);
      for (const l of p.lots) {
        rows.push([`<span class="lot">${fmtNum(l.quantity)} @ ${fmtPrice(l.avg_cost, l.currency)}</span>${l.bought_at ? ` <span class="sub">${fmtHeld(l.bought_at)}</span>` : ""}`,
          `<span class="${cls(l.pnl_pct)}">${fmtPct(l.pnl_pct)}</span>${l.account && p.account?.endsWith("accounts") ? ` <span class="sub">${esc(l.account)}</span>` : ""}`]);
      }
    }
    const head = mode === "pnl" ? `${fmtPct(p.pnl_pct)} total` : `${fmtPct(p.changes?.[period])} · ${period}`;
    return `<div class="tt-head"><span class="tt-sym">${esc(p.symbol || p.display_name)}</span><span class="tt-type">${esc(TYPE_LABEL[p.quote_type] || p.quote_type || "")}</span></div>
      <div class="tt-name">${esc(p.display_name)}</div>
      ${p.ok ? `<div class="tt-price"><b>${fmtPrice(p.price, p.price_currency)}</b><span class="${cls(mode === "pnl" ? p.pnl_pct : p.changes?.[period])}">${head}</span></div>` : `<div class="down">No price available</div>`}
      ${sparkSvg(p.spark, sc)}
      ${p.changes && Object.keys(p.changes).length ? periodGrid(p.changes, color, mode === "period" ? period : null) : ""}
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  const COLS = [
    { key: "display_name", label: "Asset" },
    { key: "account", label: "Account" },
    { key: "held", label: "Held", num: true },
    { key: "quantity", label: "Qty", num: true },
    { key: "avg_cost", label: "Avg cost", num: true },
    { key: "price", label: "Price", num: true },
    { key: "day", label: "1D", num: true },
    { key: "wk", label: "This week", num: true, title: "Best and worst day of the last 7 days, and the change over the week" },
    { key: "typ", label: "Typical day", num: true, title: "How much it usually moves in a day (last year): half of the days move less than this; 90% of days fall in the range below" },
    { key: "value", label: "Value", num: true },
    { key: "pnl", label: "P&L", num: true },
    { key: "pnl_pct", label: "P&L %", num: true },
    { key: "vs_bench", label: "Vs index", num: true },
    { key: "weight", label: "Weight", num: true },
  ];
  const fmtPP = (v) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} pp`);
  const vsCell = (p) => (p.vs_bench == null
    ? `<td class="num"><span class="sub">—</span></td>`
    : `<td class="num ${cls(p.vs_bench)}" title="Index over the same dates: ${fmtPct(p.bench_ret)}"><span class="${tkCls(p.symbol)}">${fmtPP(p.vs_bench)}</span><div class="sub">idx ${fmtPct(p.bench_ret, 1)}</div></td>`);
  // ---- daily moves: this week's best/worst day and the usual size of a day's move (from /api/moves)
  const pc = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`);
  const dShort = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(new Date(iso + "T00:00:00")) : "");
  function dayCell(p) {
    const m = state.moves?.[p.symbol];
    const r = p.day;
    let unusual = "";
    if (m && r != null) {
      const v = r / 100;
      if (v > m.q.p95 || v < m.q.p5) {
        const big = v > m.q.p99 || v < m.q.p1;
        unusual = `<div class="sub warn-t" title="${big ? "Bigger than 99% of the days in the last year" : "Outside the range of 90% of the days in the last year"} (90% of days: ${pc(m.q.p5)} … ${pc(m.q.p95)}; 98%: ${pc(m.q.p1)} … ${pc(m.q.p99)})">${big ? "rare move" : "unusual"}</div>`;
      }
    }
    return `<td class="num ${cls(r)}"><span class="${tkCls(p.symbol)}">${fmtPct(r)}</span>${unusual}</td>`;
  }
  function weekCell(p) {
    if (!state.moves?.[p.symbol] && p.quote_type !== "MANUAL") return noMoves(p);
    const w = state.moves?.[p.symbol]?.week;
    if (!w) return `<td class="num"><span class="sub">—</span></td>`;
    const tip = `Last 7 days (${w.days} sessions)\nBest day: ${pc(w.best.ret)} on ${fmtDate(w.best.date)}\nWorst day: ${pc(w.worst.ret)} on ${fmtDate(w.worst.date)}\nWeek: ${pc(w.change)} · range ${fmtPrice(w.range.lo, p.price_currency)} – ${fmtPrice(w.range.hi, p.price_currency)}`;
    return `<td class="num wkcell" title="${esc(tip)}"><span class="up">${pc(w.best.ret)}</span> <span class="sub">${dShort(w.best.date)}</span><br>
      <span class="down">${pc(w.worst.ret)}</span> <span class="sub">${dShort(w.worst.date)}</span><div class="sub ${cls(w.change)}">week ${pc(w.change)}</div></td>`;
  }
  function typCell(p) {
    const m = state.moves?.[p.symbol];
    if (!m && p.quote_type !== "MANUAL") return noMoves(p);
    if (!m) return `<td class="num"><span class="sub">—</span></td>`;
    const q = m.q, dy = m.days;
    const tip = `Last year, ${m.n} sessions (moves in the asset's own currency)\n`
      + `Half of the days move less than ±${(m.median_abs * 100).toFixed(1)}%\n`
      + `50% of days: ${pc(q.p25)} to ${pc(q.p75)}\n90% of days: ${pc(q.p5)} to ${pc(q.p95)}\n98% of days: ${pc(q.p1)} to ${pc(q.p99)}\n`
      + `Days up more than 3%: ${dy.up3} · down more than 3%: ${dy.dn3}\nDays up more than 5%: ${dy.up5} · down more than 5%: ${dy.dn5}\n`
      + `Best day: ${pc(m.year_best.ret)} (${fmtDate(m.year_best.date)}) · worst day: ${pc(m.year_worst.ret)} (${fmtDate(m.year_worst.date)})\n`
      + `Up days: ${Math.round(m.up_share * 100)}%`;
    return `<td class="num typcell" title="${esc(tip)}">±${(m.median_abs * 100).toFixed(1)}%<div class="sub">90%: ${pc(q.p5)} … ${pc(q.p95)}</div>
      <div class="sub">±3%+: ${dy.up3 + dy.dn3} d/yr</div></td>`;
  }

  function renderTable(d, positions = d.positions) {
    const b = base();
    const total = d.totals.value || 0;
    const mv = state.moves || {};
    const rows = positions.map((p) => ({ ...p, day: p.changes?.["1D"], held: heldDays(p.bought_at), weight: total && p.value ? p.value / total * 100 : null,
      wk: mv[p.symbol]?.week?.change ?? null, typ: mv[p.symbol]?.median_abs ?? null }));
    const { key, dir } = state.sort;
    rows.sort((a, c) => {
      const x = a[key], y = c[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    const t = $("#p-table");
    t.tHead.innerHTML = `<tr>${COLS.map((c) => `<th class="sortable ${c.num ? "num" : ""}" data-k="${c.key}"${c.title ? ` title="${esc(c.title)}"` : ""}>${c.label}${c.key === key ? `<span class="arr">${dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}<th></th></tr>`;
    const open = state.expanded || (state.expanded = new Set());
    const lotRow = (l) => `<tr class="lot-row" data-id="${l.id}">
      <td class="asset"><span class="sub">↳ lot</span></td>
      <td>${esc(l.account || "")}${l.group_name ? `<div class="sub">${esc(l.group_name)}</div>` : ""}</td>
      ${heldCell(l.bought_at)}
      <td class="num">${fmtNum(l.quantity)}</td>
      <td class="num">${fmtPrice(l.avg_cost, l.currency)}</td>
      <td></td><td></td><td></td><td></td>
      <td class="num">${fmtMoney(l.value, b)}</td>
      <td class="num ${cls(l.pnl)}">${fmtSigned(l.pnl, b)}</td>
      <td class="num ${cls(l.pnl_pct)}">${fmtPct(l.pnl_pct)}</td>
      ${vsCell(l)}
      <td class="num">${total && l.value ? (l.value / total * 100).toFixed(1) + "%" : "—"}</td>
      <td><div class="row-actions"><button class="sell" title="Sell from this account">Sell</button><button class="edit" title="Edit lot">Edit</button><button class="del" title="Delete lot">Delete</button></div></td></tr>`;
    t.tBodies[0].innerHTML = rows.map((p) => (p.lots ? `<tr class="merged ${open.has(p.mkey) ? "open" : ""}" data-mkey="${esc(p.mkey)}">` : `<tr data-id="${p.id}">`) + `
      <td class="asset">${p.lots ? `<button class="exp" title="Show lots">${open.has(p.mkey) ? "▾" : "▸"}</button>` : ""}<b>${esc(p.symbol || "—")}</b>${p.quote_type === "MANUAL" ? '<span class="pill">manual</span>' : ""}${p.lots ? `<span class="pill">${p.lots.length} lots</span>` : ""}${p.price_source ? `<span class="pill" title="Yahoo's prices for ${esc(p.symbol)} are short or stale, so prices, charts and alerts use ${esc(p.price_source)}, another listing of the same fund (same currency and price).">via ${esc(p.price_source)}</span>` : ""}<div class="sub">${esc(p.display_name)}</div></td>
      <td>${esc(p.account || "")}${p.group_name ? `<div class="sub">${esc(p.group_name)}</div>` : ""}</td>
      ${heldCell(p.bought_at, p.lots ? "since " : "")}
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${fmtPrice(p.avg_cost, p.currency)}</td>
      <td class="num">${p.ok ? `<span ${tickAttr(p.symbol)}>${fmtPrice(p.price, p.price_currency)}</span>` : '<span class="down">n/a</span>'}${p.symbol ? `<div>${extBadge(p.symbol, p.price_currency, p)}</div>` : ""}</td>
      ${dayCell(p)}${weekCell(p)}${typCell(p)}
      <td class="num"><span class="${tkCls(p.symbol)}">${fmtMoney(p.value, b)}</span></td>
      <td class="num ${cls(p.pnl)}"><span class="${tkCls(p.symbol)}">${fmtSigned(p.pnl, b)}</span></td>
      <td class="num ${cls(p.pnl_pct)}"><span class="${tkCls(p.symbol)}">${fmtPct(p.pnl_pct)}</span></td>
      ${vsCell(p)}
      <td class="num">${p.weight == null ? "—" : p.weight.toFixed(1) + "%"}</td>
      <td>${p.lots ? `<div class="row-actions">${p.symbol && p.quote_type !== "MANUAL" ? `<button class="chart-btn" data-sym="${esc(p.symbol)}" title="Technical analysis">Chart</button>` : ""}<button class="sell" title="Record a sale">Sell</button><button class="exp-btn">${open.has(p.mkey) ? "Hide lots" : "Lots"}</button></div>`
        : `<div class="row-actions">${p.symbol && p.quote_type !== "MANUAL" ? `<button class="chart-btn" data-sym="${esc(p.symbol)}" title="Technical analysis">Chart</button>` : ""}<button class="sell" title="Record a sale">Sell</button><button class="edit" title="Edit">Edit</button><button class="del" title="Delete">Delete</button></div>`}</td>
    </tr>` + (p.lots && open.has(p.mkey) ? p.lots.map(lotRow).join("") : "")).join("");
    const tt = d.totals;
    t.tFoot.innerHTML = rows.length ? `<tr><td>Total</td><td></td><td></td><td></td><td></td><td></td>
      <td class="num ${cls(tt.day_pct)}">${fmtPct(tt.day_pct)}</td><td></td><td></td><td class="num">${fmtMoney(tt.value, b)}</td>
      <td class="num ${cls(tt.pnl)}">${fmtSigned(tt.pnl, b)}</td><td class="num ${cls(tt.pnl_pct)}">${fmtPct(tt.pnl_pct)}</td>
      <td class="num ${cls(tt.vs_bench)}">${tt.vs_bench == null ? "—" : fmtPP(tt.vs_bench)}</td><td class="num">100%</td><td></td></tr>` : "";
  }
  // real-time: a price that just changed flashes green / red; hover says when the last trade came in
  // the cells computed from the price (value, P&L, 1D, vs index) flash with it
  // A ticker Trade Republic prices already includes pre-market and after-hours (Lang & Schwarz trades 07:30–23:00),
  // so it gets a "TR" tag instead of Yahoo's pre / after / indicative badge
  function trPriced(sym, p) {
    const k = state.ticks?.[sym];
    return (k?.src === "TR" && Date.now() - k.at < 120e3) || p?.live_src === "TR";
  }
  function extBadge(sym, ccy, p) {
    if (!trPriced(sym, p)) return pre.badge(sym, ccy);
    const k = state.ticks?.[sym], v = k?.venue && k.venue !== "LSX" ? k.venue : "Lang & Schwarz";
    return `<span class="pm-badge tr-tag" title="Price and today's change from Trade Republic (${esc(v)}), measured against that venue's previous close, as in the TR app">TR</span>`;
  }
  // Trade Republic ticks (Lang & Schwarz, static/trpanel.js) count as real-time even with Yahoo's stream off
  const tkOn = (sym) => !!sym && (live.rt || (state.ticks?.[sym]?.src === "TR" && Date.now() - state.ticks[sym].at < 120e3));
  function tkCls(sym) {
    const k = tkOn(sym) ? state.ticks?.[sym] : null;
    return k && k.moved && Date.now() - k.at < 1500 ? (k.dir > 0 ? "tk tk-up" : k.dir < 0 ? "tk tk-dn" : "") : "";
  }
  function tickAttr(sym) {
    if (!tkOn(sym)) return "";
    const k = state.ticks?.[sym];
    const fresh = k && k.moved && Date.now() - k.at < 1500;
    const px = (v) => (v == null ? "—" : v.toLocaleString(undefined, { maximumSignificantDigits: 7 }));
    const venue = k?.venue === "LSX" || !k?.venue ? "Lang & Schwarz" : k.venue;
    const tip = k?.src === "TR" ? `${venue} via Trade Republic, ${new Date(k.t).toLocaleTimeString()}: last price${k.bid != null && k.ask != null ? ` (bid ${px(k.bid)}, ask ${px(k.ask)})` : ""}${k.pre ? `, today vs ${px(k.pre)} (previous close there)` : ""}${k.eur ? `, ${px(k.eur)} € converted` : ""}`
      : k ? `Last real-time trade ${new Date(k.t).toLocaleTimeString()}` : "No real-time trade received yet (market closed, thin trading, or not covered by Yahoo's feed): the price refreshes every 15 s";
    return `class="tk ${fresh ? (k.dir > 0 ? "tk-up" : k.dir < 0 ? "tk-dn" : "") : ""} ${k && Date.now() - k.at < 120e3 ? "tk-live" : ""}" title="${esc(tip)}"`;
  }

  // phones: holdings as a list (name, units, value, return); tap one for its sheet (static/sheet.js)
  const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  function renderMobileList(d, rows) {
    const b = base(), t = d.totals, el = $("#p-mlist");
    const list = rows.slice().sort((a, c) => (c.value || 0) - (a.value || 0));
    const arrow = (v) => (v > 0 ? "▲" : v < 0 ? "▼" : "");
    el.innerHTML = list.length ? list.map((p) => {
      const sym = p.symbol || "", man = !p.symbol || p.quote_type === "MANUAL";
      return `<button class="ml-row" data-sym="${esc(sym)}" ${man ? "disabled" : ""}>
        <span class="ml-logo" style="background:hsl(${hueOf(sym || p.display_name || "?")} 45% 38%)">${esc((sym || p.display_name || "?").replace(/^\^/, "").replace(/[^A-Z0-9]/gi, "").slice(0, 2).toUpperCase())}</span>
        <span class="ml-main"><b>${esc(p.display_name || sym)}</b><span>${fmtNum(p.quantity)} · ${esc(sym)}${p.lots ? ` · ${p.lots.length} lots` : ""}</span></span>
        <span class="ml-num"><b ${tickAttr(sym)}>${p.ok ? fmtMoney(p.value, b) : "n/a"}</b><span class="${cls(p.pnl_pct)}">${arrow(p.pnl_pct)} ${p.pnl_pct == null ? "—" : Math.abs(p.pnl_pct).toFixed(2) + " %"}</span>
          <span class="ml-day ${cls(p.changes?.["1D"])}">today ${fmtPct(p.changes?.["1D"])}</span>${sym ? extBadge(sym, p.price_currency, p) : ""}</span></button>`;
    }).join("") + `<div class="ml-total"><span>Total · ${list.length} positions</span><b>${fmtMoney(t.value, b)}</b><span class="${cls(t.pnl)}">${fmtSigned(t.pnl, b)} (${fmtPct(t.pnl_pct)})</span></div>`
      : '<div class="empty">No positions yet.</div>';
  }
  $("#p-mlist").addEventListener("click", (e) => {
    const r = e.target.closest(".ml-row[data-sym]");
    if (r && r.dataset.sym) sheet.open(r.dataset.sym);
  });
  $("#p-table").addEventListener("click", async (e) => {
    const sym = e.target.closest("td.asset > b");
    if (sym && !e.target.closest(".lot-row")) {
      const s = sym.textContent.trim();
      if (s && s !== "—") { sheet.open(s); e.stopPropagation(); return; }
    }
    const th = e.target.closest("th.sortable");
    if (th) {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "display_name" || k === "account" ? 1 : -1) };
      return renderTable(state.port, shownPositions(state.port, pView()));
    }
    const chartBtn = e.target.closest("button.chart-btn");
    if (chartBtn) { openChart(chartBtn.dataset.sym); e.stopPropagation(); return; }
    const sellBtn = e.target.closest(".sell");
    if (sellBtn) {
      const row = sellBtn.closest("tr");
      const shown = shownPositions(state.port, pView());
      const p = row.dataset.mkey ? shown.find((x) => x.mkey === row.dataset.mkey)
        : state.port.positions.find((x) => x.id === +row.dataset.id);
      if (p) pf.openTx("SELL", { symbol: p.symbol, account: p.lots ? (p.lots.every((l) => l.account === p.lots[0].account) ? p.lots[0].account : "") : p.account });
      e.stopPropagation();
      return;
    }
    const mr = e.target.closest("tr[data-mkey]");
    if (mr) {
      const k = mr.dataset.mkey, open = state.expanded || (state.expanded = new Set());
      open.has(k) ? open.delete(k) : open.add(k);
      return drawPortfolio();
    }
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const pos = state.port.positions.find((p) => p.id === +tr.dataset.id);
    if (e.target.closest(".edit")) openPosition(pos);
    if (e.target.closest(".del") && confirm(`Delete this buy of ${pos.symbol || pos.display_name}?`)) {
      try { await api(`/api/positions/${pos.id}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
      loadPortfolio(true);
    }
  });
  $("#p-combine").addEventListener("change", (e) => { saveSettings({ p_combine: e.target.checked }); drawPortfolio(); });
  for (const [id, key] of [["#p-color", "p_color"], ["#p-size", "p_size"], ["#p-group", "p_group"]]) {
    $(id).addEventListener("change", (e) => {
      if (key === "p_group") state.zoom.portfolio = null;
      saveSettings({ [key]: e.target.value });
      drawPortfolio();
    });
  }

  // ================================================================== shared controls
  function setupPeriodSegs() {
    $$(".period-seg").forEach((seg) => {
      seg.innerHTML = PERIODS.map((p) => `<button data-v="${p}">${p}</button>`).join("");
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        saveSettings({ period: b.dataset.v });
        syncControls();
        redraw();
      });
    });
    $$(".range-sel").forEach((sel) => {
      sel.innerHTML = RANGES.map((r) => `<option value="${r}">${r === "auto" ? "Auto" : "±" + r + "%"}</option>`).join("");
      sel.addEventListener("change", (e) => { saveSettings({ color_range: e.target.value }); syncControls(); redraw(); });
    });
  }
  function syncControls() {
    const s = state.settings;
    $$(".period-seg button").forEach((b) => b.classList.toggle("active", b.dataset.v === (s.period || "1D")));
    $$("#base-seg button").forEach((b) => b.classList.toggle("active", b.dataset.v === base()));
    $$(".range-sel").forEach((sel) => (sel.value = String(s.color_range ?? "auto")));
  }
  $("#base-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === base()) return;
    saveSettings({ base_currency: b.dataset.v });
    syncControls();
    reload();
  });

  function redraw() {
    if (state.view === "hours") return hours.draw();
    if (state.view === "ta") return;
    state.view === "markets" ? drawMarkets() : drawPortfolio();
  }
  async function reload(silent = false) {
    liveConnect();                                         // follow what this view shows (no-op if unchanged)
    if (state.loading) { state.pending = true; return; }   // e.g. tab switched mid-load: run again after
    state.loading = true;
    state.pending = false;
    $("#refresh-btn").classList.add("spin");
    try {
      if (state.view === "markets") await loadMarkets(silent);
      else if (state.view === "hours") { divs.load(false); pre.load(false); await hours.load(silent); }
      else if (state.view === "ta") await ta.refresh(silent);
      else await loadPortfolio(silent);
    } catch (err) {
      console.error(err);
      $("#status").textContent = `Error: ${err.message}`;
      const map = state.view === "markets" ? mMap : state.view === "hours" ? $("#h-board") : pMap;
      const have = state.view === "markets" ? state.heat : state.view === "hours" ? hours.loaded() : state.port;
      if (!have) map.innerHTML = `<div class="empty">Could not load data: ${esc(err.message)}</div>`;
    } finally {
      state.loading = false;
      $("#refresh-btn").classList.remove("spin");
      if (state.pending) { state.pending = false; reload(true); }
    }
  }
  function stamp(ts, quiet = false) {
    if (ts) live.lastTs = ts;
    const t = live.lastTs ? new Date(live.lastTs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    const r = +state.settings.refresh_seconds;
    const el = $("#status");
    const feed = live.rt ? feedState() : null;
    el.textContent = live.on() ? `Updated ${t} · ${live.rt ? feed.text : `live ${live.secs}s`}` : `Updated ${t}${r ? ` · auto ${r >= 60 ? r / 60 + "m" : r + "s"}` : ""}`;
    el.classList.toggle("feed-warn", !!(live.on() && feed && feed.warn));
    el.classList.toggle("rt", live.on() && live.rt);
    el.title = live.on() ? (live.rt ? `Real-time: prices stream from Yahoo as trades happen and are pushed to this page (about once a second); totals and charts refresh every 15 s. Change it in Settings → Live prices.\n${feed.detail}`
      : "Live: the Pi pushes each refresh to this page as it happens (Server-Sent Events). Change the rate in Settings → Live prices.")
      : live.es ? "Live connection lost: reconnecting; meanwhile the page polls on its own" : "";
    if (!quiet) workerBadge();
  }

  // ---- live updates: the Pi refreshes what this page shows every N seconds and pushes "new data" events
  // (Server-Sent Events, /api/events). The page reloads only when prices actually moved; the clock updates
  // either way. If the stream drops, the browser reconnects by itself and the page falls back to polling.
  const live = { es: null, watch: null, ok: false, rt: false, secs: 15, lastTs: 0, t: null, on() { return this.ok && !!this.watch; } };
  function liveWatch() {
    const b = base(), open = sheet?.isOpen() ? sheet.symbol() : null;
    const w = state.view === "portfolio" ? [`port:${b}`, `pre:${b}`]
      : state.view === "markets" && state.boardId != null ? [`heat:${state.boardId}:${b}`]
      : state.view === "hours" ? [`divs:${b}`, `pre:${b}`]
      : state.view === "ta" && ta.symbol() ? [`sym:${ta.symbol()}`] : [];
    if (open) w.push(`sym:${open}`);                       // the ticker sheet streams its own price too
    return w.join(",");
  }
  function liveConnect(force = false) {
    if (typeof EventSource === "undefined" || document.hidden || !state.settings) return;
    const w = liveWatch();
    if (!force && live.es && live.watch === w) return;
    live.es?.close();
    live.ok = false;
    live.watch = w;
    const es = new EventSource(`/api/events?watch=${encodeURIComponent(w)}`);
    live.es = es;
    es.addEventListener("hello", (e) => {
      const d = JSON.parse(e.data);
      live.ok = true; live.secs = d.live_seconds; live.rt = !!d.realtime;
      schedule(); stamp(0, true);
    });
    es.addEventListener("ticks", (e) => onTicks(JSON.parse(e.data).ticks));
    es.addEventListener("update", (e) => {
      const d = JSON.parse(e.data);
      if (d.key.startsWith("divs:")) { if (state.view === "hours" && d.changed) divs.load(true); return; }
      if (d.key.startsWith("pre:")) { if (d.changed) pre.load(true); return; }
      if (!live.watch.split(",").includes(d.key)) return;
      badgeFresh(d.at);
      if (d.changed) liveReload(); else stamp(d.at, true);   // same prices: just the time
    });
    es.addEventListener("clear", () => liveReload());          // an edit here or in another tab
    es.onerror = () => { if (live.ok) { live.ok = false; schedule(); stamp(0, true); } };
  }
  // ---- real-time ticks: patch prices in place (about once a second); tables right away, maps every few seconds
  const tickDraw = { fast: 0, slow: 0, t: null };
  state.ticks = {};                                     // symbol -> {t: trade time ms, at: received, dir}
  function onTicks(list) {
    if (!list?.length) return;
    const by = Object.fromEntries(list.map((t) => [t.s, t]));
    for (const t of list) {
      const prev = state.ticks[t.s];
      state.ticks[t.s] = { t: t.t, at: Date.now(), p: t.p, dir: prev && t.p !== prev.p ? Math.sign(t.p - prev.p) : prev?.dir || 0, moved: !prev || t.p !== prev.p,
        src: t.src, bid: t.bid, ask: t.ask, eur: t.eur, venue: t.venue, pre: t.pre };
    }
    badgeFresh(Date.now() / 1000 + badge.skew);
    stamp(Date.now() / 1000, true);
    if (state.view === "ta") ta.tick(list);
    sheet.tick(by);
    let changed = false;
    if (state.view === "portfolio" && state.port) changed = patchPortfolio(state.port, by);
    if (state.view === "markets" && state.heat) changed = patchHeat(state.heat, by);
    if (changed) drawTicks();
  }
  function patchPortfolio(d, by) {
    const fx = d.fx || {}, T = d.totals;
    let changed = false;
    for (const r of d.positions) {
      const t = by[r.symbol], rate = fx[r.price_currency];
      if (!t || !r.ok || r.quote_type === "MANUAL" || !rate || t.p === r.price) continue;
      if (t.pre) r._prev = t.pre;                                   // TR: its venue's previous close
      else if (r._prev == null) { const ch = r.changes?.["1D"]; r._prev = ch != null ? r.price / (1 + ch / 100) : 0; }
      r.price = t.p;
      r.value = r.quantity * t.p * rate;
      r.pnl = r.value - r.cost;
      r.pnl_pct = r.cost ? (r.value / r.cost - 1) * 100 : null;
      if (r._prev) { r.day_pnl = r.quantity * (t.p - r._prev) * rate; r.changes = { ...r.changes, "1D": (t.p / r._prev - 1) * 100 }; }
      if (r.bench_value != null && r.cost) r.vs_bench = (r.value - r.bench_value) / r.cost * 100;   // the index part doesn't move
      changed = true;
    }
    if (!changed) return false;
    const ok = d.positions.filter((r) => r.ok);
    const oldPnl = T.pnl;
    T.value = ok.reduce((a, r) => a + r.value, 0);
    T.pnl = T.value - T.cost;
    T.pnl_pct = T.cost ? T.pnl / T.cost * 100 : null;
    T.day_pnl = ok.reduce((a, r) => a + (r.day_pnl || 0), 0);
    T.day_pct = T.value - T.day_pnl ? T.day_pnl / (T.value - T.day_pnl) * 100 : null;
    if (T.total_return != null) T.total_return += T.pnl - oldPnl;
    const wb = ok.filter((r) => r.bench_value != null && r.cost);
    if (wb.length && T.vs_bench != null) {
      const c = wb.reduce((a, r) => a + r.cost, 0);
      T.vs_bench = (wb.reduce((a, r) => a + r.value, 0) - wb.reduce((a, r) => a + r.bench_value, 0)) / c * 100;
    }
    return true;
  }
  function patchHeat(d, by) {
    let changed = false;
    for (const x of d.tiles) {
      const t = by[x.symbol];
      if (!t || !x.ok || t.p === x.price) continue;
      x.price = t.p;
      if (t.pre) x.prev_close = t.pre;
      if (x.prev_close) x.changes = { ...x.changes, "1D": (t.p / x.prev_close - 1) * 100 };
      changed = true;
    }
    return changed;
  }
  function drawTicks() {
    const now = Date.now();
    if (state.view === "markets") {                              // the heatmap is one drawing: every 2 s at most
      if (now - tickDraw.slow > 2000) { tickDraw.slow = now; drawMarkets(); }
      return;
    }
    const d = state.port;
    if (now - tickDraw.slow > 5000) { tickDraw.slow = now; tickDraw.fast = now; drawPortfolio(); return; }
    if (now - tickDraw.fast < 900) return;
    tickDraw.fast = now;
    const rows = shownPositions(d, pView());
    renderKpis(d.totals); renderMobileList(d, rows); renderTable(d, rows);
  }
  function liveReload() {                                       // several events in a row → one reload
    clearTimeout(live.t);
    live.t = setTimeout(() => reload(true), 250);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { live.es?.close(); live.es = null; live.ok = false; clearInterval(state.timer); }
    else { schedule(); reload(true); }                          // back on the tab: catch up, reconnect
  });
  // the real-time feed as the Pi reports it (/api/worker → live.stream)
  let feedInfo = null;
  function feedState() {
    const f = feedInfo;
    if (!f) return { text: "real-time", warn: false, detail: "" };
    const now = Date.now() / 1000 + badge.skew;
    const per = Object.entries(f.per_symbol || {});
    const fresh = per.filter(([, v]) => v.last && now - v.last < 120);
    const detail = [`Feed ${f.connected ? "connected" : "not connected"}${f.error ? ` — ${f.error}` : ""} · ${f.messages} messages`,
      `Trading now (a trade in the last 2 min): ${fresh.map(([s]) => s).join(", ") || "none"}`,
      `Quiet: ${per.filter(([, v]) => !(v.last && now - v.last < 120)).map(([s, v]) => `${s}${v.last ? ` (last ${Math.round((now - v.last) / 60)} min ago)` : " (no trades yet)"}`).join(", ") || "none"}`].join("\n");
    if (!f.connected) return { text: "real-time feed offline", warn: true, detail };
    if (!fresh.length) return { text: "real-time · no trades", warn: false, detail };
    return { text: `real-time · ${fresh.length}/${per.length} trading`, warn: false, detail };
  }

  // Pi background refresh: is the worker keeping prices and alerts current without this page? (app/worker.py)
  // The badge says when the Pi last refreshed prices: the background job (every minute) or the live refresh
  // of what this page shows (every live_seconds). It counts up every second and jumps back to 0 on each push.
  const badge = { fresh: null, skew: 0, running: false, state: "ok" };
  function badgeAgo(t) {
    if (!t) return "never";
    const s = Math.max(0, Math.round(Date.now() / 1000 + badge.skew - t));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  }
  function badgeText() {
    const el = $("#wk-badge");
    if (el.hidden) return;
    el.textContent = !badge.running ? "Pi refresh off" : `Pi ${badge.fresh ? badgeAgo(badge.fresh) : "starting"}`;
  }
  setInterval(badgeText, 1000);
  setInterval(() => { if (!document.hidden && state.settings) workerBadge(); }, 60e3);   // health (errors, stuck jobs)
  setInterval(() => { if (!document.hidden && live.rt && live.on()) workerBadge().then(() => stamp(0, true)); }, 15e3);   // feed state
  function badgeFresh(at) {                                    // a live push: the Pi just refreshed
    if (at && (!badge.fresh || at > badge.fresh)) { badge.fresh = at; badgeText(); }
  }
  async function workerBadge() {
    const el = $("#wk-badge");
    let w;
    try { w = await api("/api/worker"); } catch { el.hidden = true; return; }
    badge.skew = w.now - Date.now() / 1000;                   // Pi clock vs this device
    feedInfo = w.live?.stream || null;
    badge.running = w.running;
    badge.fresh = Math.max(badge.fresh || 0, w.fresh_at || 0) || null;
    const j = Object.fromEntries((w.jobs || []).map((x) => [x.name, x]));
    const p = j.portfolio, bad = (w.jobs || []).filter((x) => x.stuck || (x.last_error && x.enabled));
    const ago = (t) => { if (!t) return "never"; const s = Math.round(w.now - t); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
    const next = (x) => (x.next_in < 90 ? `${Math.round(x.next_in)}s` : `${Math.round(x.next_in / 60)} min`);
    const state = !w.running ? "bad" : bad.length || p?.late ? "warn" : "ok";
    el.hidden = false;
    el.className = `wk-badge wk-${state}`;
    badgeText();
    const lv = w.live || {};
    el.title = `Last price refresh on the Pi. ${lv.clients ? `Live: what open pages show is refreshed every ${lv.seconds}s and pushed to them` : "No page open: background schedule only"}; ${w.busy ? "markets busy: prices every minute" : "quiet hours: slower schedule"}.\n`
      + (w.jobs || []).filter((x) => x.name !== "live" && x.name !== "summary")
        .map((x) => `${x.label}: ${x.enabled ? (x.running_for != null ? `running ${Math.round(x.running_for)}s${x.stuck ? " (stuck)" : ""}` : `${ago(x.last_ok)}, next in ${next(x)}`) : "off"}${x.last_error ? ` · error: ${x.last_error}` : ""}`).join("\n");
  }
  function schedule() {
    clearInterval(state.timer);
    // live views get pushed updates; polling stays for the others and as a fallback when the stream is down
    const pushed = live.on() && (state.view === "portfolio" || state.view === "markets" || (state.view === "ta" && live.rt));
    const r = pushed ? 0 : +state.settings.refresh_seconds;
    if (r > 0) state.timer = setInterval(() => { if (!document.hidden) reload(true); }, r * 1000);
  }
  $("#refresh-btn").addEventListener("click", () => reload(true));

  // tabs
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  function switchView(v) {
    state.view = v;
    setTimeout(schedule, 0);
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    $("#view-markets").hidden = v !== "markets";
    $("#view-portfolio").hidden = v !== "portfolio";
    $("#view-hours").hidden = v !== "hours";
    $("#view-ta").hidden = v !== "ta";
    try { localStorage.setItem("stonks.view", v); } catch {}
    hideTip();
    if (v === "ta") { ta.show(); return; }
    if (v === "hours") {
      if (hours.loaded()) hours.draw();
      reload(hours.loaded());
      return;
    }
    const cached = v === "markets" ? state.heat : state.port;
    if (cached && cached.base === base()) redraw();
    reload(!!cached);
  }

  let lastSize = "";
  const ro = new ResizeObserver(() => {
    const m = state.view === "markets" ? mMap : state.view === "hours" ? $("#h-board") : pMap;
    const k = `${state.view}:${m.clientWidth}x${m.clientHeight}`;
    if (k !== lastSize) { lastSize = k; redraw(); }
  });
  ro.observe(mMap); ro.observe(pMap); ro.observe($("#h-board"));

  // ================================================================== symbol search widget
  function attachSearch(input, onPick) {
    const list = input.parentElement.querySelector(".suggest");
    let timer, items = [], idx = -1;
    const close = () => { list.hidden = true; idx = -1; };
    const render = () => {
      list.innerHTML = items.map((it, i) => `<li data-i="${i}" class="${i === idx ? "on" : ""}${it.no_prices ? " noprice" : ""}"><span><b>${esc(it.symbol)}</b> ${esc(it.name)}</span><small>${esc(it.type || "")} · ${esc(it.exchange || "")}${it.no_prices ? " · no prices on Yahoo" : ""}</small></li>`).join("");
      list.hidden = !items.length;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 1) { items = []; return close(); }
      timer = setTimeout(async () => {
        try { items = await api(`/api/search?q=${encodeURIComponent(q)}&limit=8`); } catch { items = []; }
        idx = -1;
        if (input.value.trim() === q && document.activeElement === input) render();
      }, 250);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { idx = Math.min(idx + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter" && idx >= 0) { e.preventDefault(); pick(items[idx]); }
      else if (e.key === "Escape") { close(); e.stopPropagation(); e.preventDefault(); }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); pick(items[+li.dataset.i]); }
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    // Yahoo lists many European funds under their ISIN on Stuttgart (IE00BNRQM384.SG) without any prices:
    // swap such a pick for a listing of the same fund that has them (Xetra first), and say so
    async function pick(it) {
      input.value = it.symbol; close();
      if (ISIN_SYM.test(it.symbol.toUpperCase())) {
        try {
          const r = await api(`/api/resolve?symbol=${encodeURIComponent(it.symbol)}`);
          if (r.resolved && r.symbol) { it = { ...it, symbol: r.symbol, name: r.name || it.name, resolvedFrom: r.from, note: r.reason }; input.value = r.symbol; }
          else if (!r.symbol) it = { ...it, note: r.reason };
        } catch { /* keep the pick as it is */ }
      }
      onPick(it);
    }
  }
  const ISIN_SYM = /^[A-Z]{2}[A-Z0-9]{9}[0-9](\.[A-Z]{1,3})?$/;

  // ================================================================== board editor
  const dlgBoard = $("#dlg-board");
  let editingBoard = null;
  $("#add-board").addEventListener("click", async () => {
    const name = prompt("New board name", "My watchlist");
    if (!name) return;
    const b = await api("/api/boards", { method: "POST", body: { name, config: { size_mode: "cap", group_mode: "sector" } } });
    await loadBoards();
    state.boardId = b.id; state.heat = null; renderChips();
    try { localStorage.setItem("stonks.board", String(b.id)); } catch {}
    loadMarkets();
    openBoardEditor();
  });
  $("#edit-board").addEventListener("click", openBoardEditor);

  async function openBoardEditor() {
    await loadBoards();
    editingBoard = board();
    if (!editingBoard) return;
    $("#b-name").value = editingBoard.name;
    $("#b-size").value = editingBoard.config.size_mode || "cap";
    $("#b-group").value = editingBoard.config.group_mode || "sector";
    renderBoardItems();
    dlgBoard.showModal();
  }
  function renderBoardItems() {
    const items = editingBoard.items;
    const groups = [...new Set(items.map((i) => i.group_name).filter(Boolean))];
    $("#b-groups").innerHTML = groups.map((g) => `<option value="${esc(g)}">`).join("");
    $("#b-items tbody").innerHTML = items.map((it) => `<tr data-id="${it.id}">
      <td><b>${esc(it.symbol)}</b></td>
      <td><input data-f="label" value="${esc(it.label || "")}" placeholder="—"></td>
      <td><input data-f="group_name" list="b-groups" value="${esc(it.group_name || "")}" placeholder="auto"></td>
      <td class="num"><input data-f="weight" type="number" min="0" step="any" value="${it.weight ?? ""}" placeholder="1"></td>
      <td><div class="row-actions"><button class="del" title="Remove">Remove</button></div></td></tr>`).join("")
      || `<tr><td colspan="5" class="hint">No symbols yet — add some above.</td></tr>`;
  }
  $("#b-items").addEventListener("change", async (e) => {
    const inp = e.target.closest("input[data-f]");
    if (!inp) return;
    const id = +inp.closest("tr").dataset.id, f = inp.dataset.f;
    let v = inp.value.trim();
    v = f === "weight" ? (v === "" ? null : +v) : (v || null);
    await api(`/api/items/${id}`, { method: "PATCH", body: { [f]: v } });
    const it = editingBoard.items.find((i) => i.id === id);
    if (it) it[f] = v;
    if (f === "group_name") renderBoardItems();
  });
  $("#b-items").addEventListener("click", async (e) => {
    if (!e.target.closest(".del")) return;
    const id = +e.target.closest("tr").dataset.id;
    await api(`/api/items/${id}`, { method: "DELETE" });
    editingBoard.items = editingBoard.items.filter((i) => i.id !== id);
    renderBoardItems();
  });
  attachSearch($("#b-add-symbol"), (it) => { if (!$("#b-add-label").value) $("#b-add-label").placeholder = it.name; });
  async function addBoardItem() {
    const symbol = $("#b-add-symbol").value.trim().toUpperCase();
    if (!symbol) return;
    if (editingBoard.items.some((i) => i.symbol === symbol)) { $("#b-add-symbol").select(); return; }
    const body = { symbol, label: $("#b-add-label").value.trim() || null, group_name: $("#b-add-group").value.trim() || null };
    const r = await api(`/api/boards/${editingBoard.id}/items`, { method: "POST", body });
    editingBoard.items.push({ id: r.id, ...body, weight: null });
    $("#b-add-symbol").value = ""; $("#b-add-label").value = ""; $("#b-add-label").placeholder = "optional";
    renderBoardItems();
    $("#b-add-symbol").focus();
  }
  $("#b-add-btn").addEventListener("click", addBoardItem);
  $("#b-add-symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $(".suggest", dlgBoard).hidden) { e.preventDefault(); addBoardItem(); }
  });
  $("#b-name").addEventListener("change", (e) => api(`/api/boards/${editingBoard.id}`, { method: "PATCH", body: { name: e.target.value.trim() || "Untitled" } }));
  $("#b-size").addEventListener("change", (e) => api(`/api/boards/${editingBoard.id}`, { method: "PATCH", body: { config: { size_mode: e.target.value } } }));
  $("#b-group").addEventListener("change", (e) => api(`/api/boards/${editingBoard.id}`, { method: "PATCH", body: { config: { group_mode: e.target.value } } }));
  async function moveBoard(delta) {
    const list = state.boards;
    const i = list.findIndex((b) => b.id === editingBoard.id), j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((b, k) => api(`/api/boards/${b.id}`, { method: "PATCH", body: { position: k } })));
    renderChips();
  }
  $("#b-up").addEventListener("click", () => moveBoard(-1));
  $("#b-down").addEventListener("click", () => moveBoard(1));
  $("#b-delete").addEventListener("click", async () => {
    if (!confirm(`Delete board “${editingBoard.name}”?`)) return;
    await api(`/api/boards/${editingBoard.id}`, { method: "DELETE" });
    dlgBoard.close();
  });
  $("#b-done").addEventListener("click", () => dlgBoard.close());
  dlgBoard.addEventListener("close", async () => {
    await loadBoards();
    state.heat = null;
    state.zoom.markets = null;
    loadMarkets();
  });

  // ================================================================== position editor
  const dlgPos = $("#dlg-position");
  const posForm = $("#pos-form");
  let editingPos = null;
  posForm.currency.innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join("");
  $("#pos-manual").addEventListener("change", (e) => { $("#pos-manual-wrap").hidden = !e.target.checked; });
  attachSearch(posForm.symbol, (it) => {
    if (!posForm.name.value) posForm.name.placeholder = it.name;
    previewQuote(it.symbol, true);
  });
  posForm.symbol.addEventListener("change", () => previewQuote(posForm.symbol.value.trim(), !editingPos));
  async function previewQuote(sym, setCurrency) {
    const box = $("#pos-quote");
    if (!sym) { box.textContent = ""; return; }
    box.textContent = "Looking up…";
    try {
      const q = await api(`/api/quote/${encodeURIComponent(sym.toUpperCase())}`);
      if (!q.ok) { box.innerHTML = `<span class="down">No price data for ${esc(sym)}.</span> Check the ticker or use a manual price.`; return; }
      box.innerHTML = `${esc(q.name)} · last <b>${fmtPrice(q.price, q.currency)}</b> <span class="${cls(q.changes["1D"])}">${fmtPct(q.changes["1D"])}</span>`;
      if (setCurrency && CURRENCIES.includes(q.currency)) posForm.currency.value = q.currency;
    } catch (e) { box.textContent = e.message; }
  }
  $("#add-position").addEventListener("click", () => openPosition(null));
  function openPosition(p, prefill = null) {
    editingPos = p;
    posForm.reset();
    $("#pos-error").hidden = true;
    $("#pos-quote").textContent = "";
    posForm.name.placeholder = "optional";
    $("#pos-title").textContent = p ? `Edit buy · ${p.symbol || p.display_name || p.name}` : "Record a buy";
    $("#pos-delete").hidden = !p;
    const all = state.port?.positions || [];
    $("#acct-list").innerHTML = [...new Set(all.map((x) => x.account).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("");
    $("#pgroup-list").innerHTML = [...new Set(all.map((x) => x.group_name).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("");
    posForm.currency.value = base();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    posForm.bought_at.max = iso(new Date());
    posForm.bought_at.value = p ? "" : iso(new Date());
    posForm.fees.dataset.manual = p && p.fees != null ? "1" : "";
    if (p) {
      for (const k of ["symbol", "name", "quantity", "avg_cost", "currency", "account", "group_name", "manual_price", "notes", "bought_at", "fees"]) {
        const v = k === "quantity" && p.orig_quantity != null ? p.orig_quantity : p[k];
        if (v != null) posForm[k].value = v;
      }
      if (!CURRENCIES.includes(p.currency)) {
        posForm.currency.insertAdjacentHTML("beforeend", `<option>${esc(p.currency)}</option>`);
        posForm.currency.value = p.currency;
      }
    }
    const manual = p ? p.manual_price != null : false;
    $("#pos-manual").checked = manual;
    $("#pos-manual-wrap").hidden = !manual;
    if (!p && prefill) {
      for (const k of ["symbol", "quantity", "avg_cost", "account", "group_name"]) {
        if (prefill[k] != null && prefill[k] !== "") posForm[k].value = prefill[k];
      }
      if (prefill.currency && CURRENCIES.includes(prefill.currency)) posForm.currency.value = prefill.currency;
    }
    dlgPos.showModal();
    if (p?.symbol && !manual) previewQuote(p.symbol, false);
    else if (prefill?.symbol) previewQuote(prefill.symbol, !prefill.currency);
  }
  $("#pos-save").addEventListener("click", async () => {
    const f = posForm;
    const num = (x) => (x.value.trim() === "" ? null : +x.value);
    const body = {
      symbol: f.symbol.value.trim().toUpperCase() || null,
      name: f.name.value.trim() || null,
      quantity: num(f.quantity),
      avg_cost: num(f.avg_cost),
      currency: f.currency.value,
      account: f.account.value.trim() || null,
      group_name: f.group_name.value.trim() || null,
      manual_price: $("#pos-manual").checked ? num(f.manual_price) : null,
      notes: f.notes.value.trim() || null,
      bought_at: f.bought_at.value || null,
      fees: num(f.fees),
    };
    const err = $("#pos-error");
    if (!body.quantity || body.avg_cost == null) { err.textContent = "Quantity and average cost are required."; err.hidden = false; return; }
    if (!body.symbol && body.manual_price == null) { err.textContent = "Enter a symbol, or tick manual price and give one."; err.hidden = false; return; }
    if (body.manual_price != null && !body.name && !body.symbol) { err.textContent = "Give the manual asset a name."; err.hidden = false; return; }
    try {
      if (editingPos) await api(`/api/positions/${editingPos.id}`, { method: "PATCH", body });
      else await api("/api/positions", { method: "POST", body });
      dlgPos.close();
      loadPortfolio(true);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $("#pos-delete").addEventListener("click", async () => {
    if (!editingPos || !confirm(`Delete this buy of ${editingPos.symbol || editingPos.display_name || editingPos.name}?`)) return;
    try { await api(`/api/positions/${editingPos.id}`, { method: "DELETE" }); } catch (err) {
      $("#pos-error").textContent = err.message; $("#pos-error").hidden = false; return;
    }
    dlgPos.close();
    loadPortfolio(true);
  });

  // ================================================================== settings
  const dlgSet = $("#dlg-settings");
  $("#settings-btn").addEventListener("click", () => {
    $("#s-scheme").value = state.settings.color_scheme || "classic";
    $("#s-label").value = state.settings.tile_label || "symbol";
    $("#s-refresh").value = String(state.settings.refresh_seconds ?? 60);
    $("#s-live").value = String(state.settings.live_seconds ?? 15);
    const a = window.StonksLock.status();
    $("#s-idle").value = String(a?.idle_minutes ?? 10);
    $("#s-security").hidden = !a?.enabled;
    $("#s-pin-msg").hidden = true;
    dlgSet.showModal();
  });
  // ---- dashboard lock (static/lock.js, app/auth.py)
  $("#lock-btn").addEventListener("click", () => window.StonksLock.lockNow());
  $("#s-lock-now").addEventListener("click", () => window.StonksLock.lockNow());
  $("#s-idle").addEventListener("change", async (e) => {
    const v = Math.max(1, Math.min(240, Math.round(+e.target.value || 10)));
    e.target.value = v;
    try { Object.assign(window.StonksLock.status(), await api("/api/auth/config", { method: "PUT", body: { idle_minutes: v } })); } catch (err) { alert(err.message); }
  });
  $("#s-pin-change").addEventListener("click", async () => {
    const m = $("#s-pin-msg"), cur = $("#s-pin-cur").value, nw = $("#s-pin-new").value;
    const say = (t, bad = true) => { m.textContent = t; m.className = bad ? "error" : "hint"; m.hidden = false; };
    if (!/^\d{4,8}$/.test(nw)) return say("The new PIN must be 4–8 digits.");
    if (nw !== $("#s-pin-new2").value) return say("The two new PINs don't match.");
    try {
      await api("/api/auth/pin", { method: "POST", body: { pin: cur, new_pin: nw } });
      say("PIN changed. Other browsers have to enter the new one.", false);
    } catch (err) { say(err.message); }
    for (const id of ["#s-pin-cur", "#s-pin-new", "#s-pin-new2"]) $(id).value = "";
  });
  $("#s-scheme").addEventListener("change", (e) => { saveSettings({ color_scheme: e.target.value }); redraw(); });
  $("#s-label").addEventListener("change", (e) => { saveSettings({ tile_label: e.target.value }); redraw(); });
  $("#s-refresh").addEventListener("change", (e) => { saveSettings({ refresh_seconds: +e.target.value }); schedule(); });
  $("#s-live").addEventListener("change", async (e) => {
    await saveSettings({ live_seconds: +e.target.value });
    if (+e.target.value > 0) liveConnect(true); else { live.es?.close(); live.es = null; live.ok = false; schedule(); stamp(0, true); }
  });
  $("#s-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm("Replace current boards and positions with this backup?")) return;
    try {
      await api("/api/import", { method: "POST", body: JSON.parse(await file.text()) });
      state.settings = await api("/api/settings");
      state.heat = state.port = null;
      await loadBoards();
      syncControls(); schedule(); reload();
      dlgSet.close();
    } catch (err) { alert(`Import failed: ${err.message}`); }
    e.target.value = "";
  });

  // ================================================================== portfolio extras (static/portfolio.js)
  const pf = window.StonksPortfolio({
    api, esc, state, saveSettings, base, fmtPct, fmtPP, fmtMoney, fmtSigned, fmtNum, fmtPrice, fmtDate, fmtHeld, cls,
    showTip, moveTip, hideTip, autoGroup, shownPositions, pView, attachSearch, openPosition, loadPortfolio,
    CURRENCIES, TYPE_LABEL, $, $$,
  });

  // ================================================================== US pre-market / after-hours (static/premarket.js)
  const pre = window.StonksPremarket({ api, esc, state, base, fmtMoney, fmtPrice, fmtSigned, fmtPct, cls, $, openSheet: (s) => sheet.open(s) });
  pre.onChange(() => {
    if (state.view !== "portfolio" || !state.port) return;
    renderMobileList(state.port, shownPositions(state.port, pView()));
    renderTable(state.port, shownPositions(state.port, pView()));
    sheet.refreshExt();
  });

  // ================================================================== Trade Republic live prices (static/trpanel.js)
  const trp = window.StonksTR({ api, esc, $, state });

  // ================================================================== symbol sheet (static/sheet.js)
  const sheet = window.StonksSheet({ ext: (s) => pre.row(s), extBadge: (s, c) => extBadge(s, c, state.port?.positions?.find((x) => x.symbol === s)), api, state, base, saveSettings, fmtMoney, fmtPrice, fmtSigned, fmtPct, fmtNum, fmtDate, fmtHeld, cls,
    positionFor: (sym) => (state.port ? shownPositions(state.port, { ...pView(), combine: true, group: "none" }).find((p) => p.symbol === sym) : null),
    openTx: (...a) => pf.openTx(...a), openPosition: (...a) => openPosition(...a), openChart: (s) => openChart(s), $,
    onOpenChange: () => liveConnect() });

  // ================================================================== dividends in Market hours (static/dividends.js)
  const divs = window.StonksDividends({ api, esc, state, base, fmtMoney, fmtPrice, fmtNum, fmtDate, fmtPct,
    openTx: (...a) => pf.openTx(...a), $ });
  $("#h-go-divs").addEventListener("click", () => $("#h-divs-h").scrollIntoView({ behavior: "smooth", block: "start" }));

  // ================================================================== P&L history in Holdings (static/pnlhist.js)
  const pnlHist = window.StonksPnlHist({ api, esc, state, saveSettings, base, fmtMoney, fmtSigned, fmtPct, fmtDate, cls, $ });
  $("#p-mapview").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    saveSettings({ p_mapview: b.dataset.v });
    drawPortfolio();
  });

  // ================================================================== technical analysis (static/ta.js)
  const ta = window.StonksTA({ api, esc, state, saveSettings, base, fmtDate, attachSearch, $, $$, onSymbol: () => liveConnect() });
  function openChart(sym) {
    state.settings.ta = { ...(state.settings.ta || {}), symbol: sym };
    switchView("ta");
    window.scrollTo(0, 0);
  }
  window.addEventListener("stonks:chart", (e) => openChart(e.detail));

  // ================================================================== boot
  (async function boot() {
    setupPeriodSegs();
    if (matchMedia("(max-width: 720px)").matches) $("#ta-indbox").open = false;   // phones: chart first
    try {
      state.settings = await api("/api/settings");
      await loadBoards();
      try {
        const saved = +localStorage.getItem("stonks.board");
        if (state.boards.some((b) => b.id === saved)) { state.boardId = saved; renderChips(); }
      } catch {}
    } catch (e) {
      mMap.innerHTML = `<div class="empty">Backend unreachable: ${esc(e.message)}</div>`;
      return;
    }
    syncControls();
    schedule();
    let v = "markets";
    try { v = localStorage.getItem("stonks.view") || "markets"; } catch {}
    if (location.hash === "#portfolio") v = "portfolio";
    if (location.hash.startsWith("#ta")) { v = "ta"; const q = decodeURIComponent(location.hash.split("/")[1] || ""); if (q) state.settings.ta = { ...(state.settings.ta || {}), symbol: q.toUpperCase() }; }
    switchView(v);
  })();
});
