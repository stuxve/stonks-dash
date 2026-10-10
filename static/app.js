/* stonks-dash frontend — vanilla JS + d3 treemap */
(() => {
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
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
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
      div.addEventListener("click", (e) => { showTip(opts.tooltip(t), e); e.stopPropagation(); });
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
    stamp(state.port.as_of);
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
    const valueOf = (p) => (!p.ok ? null : v.color === "pnl" ? p.pnl_pct : p.changes?.[period]);
    const vals = positions.map(valueOf);
    const range = currentRange(vals);
    const color = makeColor(range);
    const useName = state.settings.tile_label === "name";
    renderKpis(d.totals);
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
    });
    renderCrumbs("#p-crumbs", "portfolio", drawPortfolio);
    renderLegend($("#p-legend"), range, color, v.color === "pnl" ? "Total P&L" : `${period} change`);
    renderTable(d, positions);
  }

  function renderKpis(t) {
    const b = base();
    $("#kpis").innerHTML = [
      ["Market value", fmtMoney(t.value, b), `${t.count} position${t.count === 1 ? "" : "s"}${t.missing ? ` · <span class="down">${t.missing} without price</span>` : ""}`],
      ["Invested", fmtMoney(t.cost, b), "cost basis at current FX"],
      ["Unrealized P&L", `<span class="${cls(t.pnl)}">${fmtSigned(t.pnl, b)}</span>`, `<span class="${cls(t.pnl)}">${fmtPct(t.pnl_pct)}</span>`],
      ["Today", `<span class="${cls(t.day_pnl)}">${fmtSigned(t.day_pnl, b)}</span>`, `<span class="${cls(t.day_pnl)}">${fmtPct(t.day_pct)}</span>`],
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
    { key: "value", label: "Value", num: true },
    { key: "pnl", label: "P&L", num: true },
    { key: "pnl_pct", label: "P&L %", num: true },
    { key: "weight", label: "Weight", num: true },
  ];
  function renderTable(d, positions = d.positions) {
    const b = base();
    const total = d.totals.value || 0;
    const rows = positions.map((p) => ({ ...p, day: p.changes?.["1D"], held: heldDays(p.bought_at), weight: total && p.value ? p.value / total * 100 : null }));
    const { key, dir } = state.sort;
    rows.sort((a, c) => {
      const x = a[key], y = c[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    const t = $("#p-table");
    t.tHead.innerHTML = `<tr>${COLS.map((c) => `<th class="sortable ${c.num ? "num" : ""}" data-k="${c.key}">${c.label}${c.key === key ? `<span class="arr">${dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}<th></th></tr>`;
    const open = state.expanded || (state.expanded = new Set());
    const lotRow = (l) => `<tr class="lot-row" data-id="${l.id}">
      <td class="asset"><span class="sub">↳ lot</span></td>
      <td>${esc(l.account || "")}${l.group_name ? `<div class="sub">${esc(l.group_name)}</div>` : ""}</td>
      ${heldCell(l.bought_at)}
      <td class="num">${fmtNum(l.quantity)}</td>
      <td class="num">${fmtPrice(l.avg_cost, l.currency)}</td>
      <td></td><td></td>
      <td class="num">${fmtMoney(l.value, b)}</td>
      <td class="num ${cls(l.pnl)}">${fmtSigned(l.pnl, b)}</td>
      <td class="num ${cls(l.pnl_pct)}">${fmtPct(l.pnl_pct)}</td>
      <td class="num">${total && l.value ? (l.value / total * 100).toFixed(1) + "%" : "—"}</td>
      <td><div class="row-actions"><button class="edit" title="Edit lot">Edit</button><button class="del" title="Delete lot">Delete</button></div></td></tr>`;
    t.tBodies[0].innerHTML = rows.map((p) => (p.lots ? `<tr class="merged ${open.has(p.mkey) ? "open" : ""}" data-mkey="${esc(p.mkey)}">` : `<tr data-id="${p.id}">`) + `
      <td class="asset">${p.lots ? `<button class="exp" title="Show lots">${open.has(p.mkey) ? "▾" : "▸"}</button>` : ""}<b>${esc(p.symbol || "—")}</b>${p.quote_type === "MANUAL" ? '<span class="pill">manual</span>' : ""}${p.lots ? `<span class="pill">${p.lots.length} lots</span>` : ""}<div class="sub">${esc(p.display_name)}</div></td>
      <td>${esc(p.account || "")}${p.group_name ? `<div class="sub">${esc(p.group_name)}</div>` : ""}</td>
      ${heldCell(p.bought_at, p.lots ? "since " : "")}
      <td class="num">${fmtNum(p.quantity)}</td>
      <td class="num">${fmtPrice(p.avg_cost, p.currency)}</td>
      <td class="num">${p.ok ? fmtPrice(p.price, p.price_currency) : '<span class="down">n/a</span>'}</td>
      <td class="num ${cls(p.day)}">${fmtPct(p.day)}</td>
      <td class="num">${fmtMoney(p.value, b)}</td>
      <td class="num ${cls(p.pnl)}">${fmtSigned(p.pnl, b)}</td>
      <td class="num ${cls(p.pnl_pct)}">${fmtPct(p.pnl_pct)}</td>
      <td class="num">${p.weight == null ? "—" : p.weight.toFixed(1) + "%"}</td>
      <td>${p.lots ? `<div class="row-actions"><button class="exp-btn">${open.has(p.mkey) ? "Hide lots" : "Lots"}</button></div>`
        : `<div class="row-actions"><button class="edit" title="Edit">Edit</button><button class="del" title="Delete">Delete</button></div>`}</td>
    </tr>` + (p.lots && open.has(p.mkey) ? p.lots.map(lotRow).join("") : "")).join("");
    const tt = d.totals;
    t.tFoot.innerHTML = rows.length ? `<tr><td>Total</td><td></td><td></td><td></td><td></td><td></td>
      <td class="num ${cls(tt.day_pct)}">${fmtPct(tt.day_pct)}</td><td class="num">${fmtMoney(tt.value, b)}</td>
      <td class="num ${cls(tt.pnl)}">${fmtSigned(tt.pnl, b)}</td><td class="num ${cls(tt.pnl_pct)}">${fmtPct(tt.pnl_pct)}</td><td class="num">100%</td><td></td></tr>` : "";
  }
  $("#p-table").addEventListener("click", async (e) => {
    const th = e.target.closest("th.sortable");
    if (th) {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === "display_name" || k === "account" ? 1 : -1) };
      return renderTable(state.port, shownPositions(state.port, pView()));
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
    if (e.target.closest(".del") && confirm(`Delete ${pos.symbol || pos.display_name}?`)) {
      await api(`/api/positions/${pos.id}`, { method: "DELETE" });
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
    state.view === "markets" ? drawMarkets() : drawPortfolio();
  }
  async function reload(silent = false) {
    if (state.loading) { state.pending = true; return; }   // e.g. tab switched mid-load: run again after
    state.loading = true;
    state.pending = false;
    $("#refresh-btn").classList.add("spin");
    try {
      if (state.view === "markets") await loadMarkets(silent);
      else if (state.view === "hours") await hours.load(silent);
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
  function stamp(ts) {
    const t = new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const r = +state.settings.refresh_seconds;
    $("#status").textContent = `Updated ${t}${r ? ` · auto ${r >= 60 ? r / 60 + "m" : r + "s"}` : ""}`;
  }
  function schedule() {
    clearInterval(state.timer);
    const r = +state.settings.refresh_seconds;
    if (r > 0) state.timer = setInterval(() => { if (!document.hidden) reload(true); }, r * 1000);
  }
  $("#refresh-btn").addEventListener("click", () => reload(true));

  // tabs
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  function switchView(v) {
    state.view = v;
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    $("#view-markets").hidden = v !== "markets";
    $("#view-portfolio").hidden = v !== "portfolio";
    $("#view-hours").hidden = v !== "hours";
    try { localStorage.setItem("stonks.view", v); } catch {}
    hideTip();
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
      list.innerHTML = items.map((it, i) => `<li data-i="${i}" class="${i === idx ? "on" : ""}"><span><b>${esc(it.symbol)}</b> ${esc(it.name)}</span><small>${esc(it.type || "")} · ${esc(it.exchange || "")}</small></li>`).join("");
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
    function pick(it) { input.value = it.symbol; close(); onPick(it); }
  }

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
  function openPosition(p) {
    editingPos = p;
    posForm.reset();
    $("#pos-error").hidden = true;
    $("#pos-quote").textContent = "";
    posForm.name.placeholder = "optional";
    $("#pos-title").textContent = p ? `Edit ${p.symbol || p.display_name}` : "Add position";
    $("#pos-delete").hidden = !p;
    const all = state.port?.positions || [];
    $("#acct-list").innerHTML = [...new Set(all.map((x) => x.account).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("");
    $("#pgroup-list").innerHTML = [...new Set(all.map((x) => x.group_name).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("");
    posForm.currency.value = base();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    posForm.bought_at.max = iso(new Date());
    posForm.bought_at.value = p ? "" : iso(new Date());
    if (p) {
      for (const k of ["symbol", "name", "quantity", "avg_cost", "currency", "account", "group_name", "manual_price", "notes", "bought_at"]) {
        if (p[k] != null) posForm[k].value = p[k];
      }
      if (!CURRENCIES.includes(p.currency)) {
        posForm.currency.insertAdjacentHTML("beforeend", `<option>${esc(p.currency)}</option>`);
        posForm.currency.value = p.currency;
      }
    }
    const manual = p ? p.manual_price != null : false;
    $("#pos-manual").checked = manual;
    $("#pos-manual-wrap").hidden = !manual;
    dlgPos.showModal();
    if (p?.symbol && !manual) previewQuote(p.symbol, false);
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
    if (!editingPos || !confirm(`Delete ${editingPos.symbol || editingPos.display_name}?`)) return;
    await api(`/api/positions/${editingPos.id}`, { method: "DELETE" });
    dlgPos.close();
    loadPortfolio(true);
  });

  // ================================================================== settings
  const dlgSet = $("#dlg-settings");
  $("#settings-btn").addEventListener("click", () => {
    $("#s-scheme").value = state.settings.color_scheme || "classic";
    $("#s-label").value = state.settings.tile_label || "symbol";
    $("#s-refresh").value = String(state.settings.refresh_seconds ?? 60);
    dlgSet.showModal();
  });
  $("#s-scheme").addEventListener("change", (e) => { saveSettings({ color_scheme: e.target.value }); redraw(); });
  $("#s-label").addEventListener("change", (e) => { saveSettings({ tile_label: e.target.value }); redraw(); });
  $("#s-refresh").addEventListener("change", (e) => { saveSettings({ refresh_seconds: +e.target.value }); schedule(); });
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

  // ================================================================== boot
  (async function boot() {
    setupPeriodSegs();
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
    switchView(v);
  })();
})();
