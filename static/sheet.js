/* stonks-dash — symbol sheet: tap a holding or a heatmap tile to see one ticker the way phone broker apps do:
 * big price, change over the chosen range (1D 1W 1M 1Y Max), a line chart you scrub with a finger (the price and
 * date follow the finger, the rest of the line greys out), your position as swipeable cards, key stats, and
 * Buy / Sell / Analysis buttons. A bottom sheet on phones, a centred panel on desktop.
 * Also exports window.StonksLine (the scrubbable line chart) for other charts. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ scrubbable line chart
  // d: {points: [[ms, value]], ref, last, intraday, range}; opts: {fmt(v), color?, markers: [ms], avg, onScrub(p|null), height}
  window.StonksLine = function (box, d, opts = {}) {
    const NS = "http://www.w3.org/2000/svg";
    const pts = d.points.map(([t, v]) => ({ t, v }));
    const n = pts.length;
    box.innerHTML = "";
    if (n < 2) { box.innerHTML = '<div class="empty">Not enough data for this range.</div>'; return null; }
    const W = Math.max(260, box.clientWidth || 360);
    const H = opts.height || (matchMedia("(max-width: 720px)").matches ? 230 : 260);
    const M = { l: 2, r: 62, t: 24, b: 22 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const up = d.last >= d.ref;
    const col = opts.color || (up ? "var(--up)" : "var(--down)");
    const vals = pts.map((p) => p.v).concat([d.ref]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (opts.avg != null && opts.avg > lo - (hi - lo) * 0.6 && opts.avg < hi + (hi - lo) * 0.6) { lo = Math.min(lo, opts.avg); hi = Math.max(hi, opts.avg); }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad; hi += pad;
    const X = (i) => M.l + (i / (n - 1)) * iw;                  // by index: no overnight / weekend gaps
    const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * ih;
    const uid = `ln${Math.random().toString(36).slice(2, 8)}`;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${X(n - 1).toFixed(1)},${M.t + ih}L${X(0).toFixed(1)},${M.t + ih}Z`;
    const ticks = Array.from({ length: 4 }, (_, k) => lo + pad + ((hi - lo - 2 * pad) * k) / 3);
    const fmt = opts.fmt || ((v) => v.toFixed(2));
    const xFmt = xFormatter(d);
    const xIdx = [0, 0.25, 0.5, 0.75].map((f) => Math.round(f * (n - 1)));
    const mk = (opts.markers || []).map((ms) => {
      if (ms < pts[0].t || ms > pts[n - 1].t) return null;
      let i = 0;
      while (i < n - 1 && pts[i + 1].t <= ms) i++;
      return i;
    }).filter((i) => i != null);
    box.innerHTML = `<svg class="ln-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart">
      <defs><linearGradient id="${uid}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient>
        <clipPath id="${uid}l"><rect class="cl" x="0" y="0" width="${W}" height="${H}"/></clipPath>
        <clipPath id="${uid}r"><rect class="cr" x="${W}" y="0" width="${W}" height="${H}"/></clipPath></defs>
      ${ticks.map((t) => `<text class="ln-y" x="${W - 2}" y="${Y(t)}" dy=".32em">${esc((opts.axisFmt || fmt)(t))}</text>`).join("")}
      <line class="ln-ref" x1="${M.l}" x2="${M.l + iw}" y1="${Y(d.ref)}" y2="${Y(d.ref)}"/>
      ${opts.avg != null && opts.avg > lo && opts.avg < hi ? `<line class="ln-avg" x1="${M.l}" x2="${M.l + iw}" y1="${Y(opts.avg)}" y2="${Y(opts.avg)}"/><text class="ln-avgt" x="${M.l + 4}" y="${Y(opts.avg) - 4}">your avg ${esc(fmt(opts.avg))}</text>` : ""}
      <path d="${area}" fill="url(#${uid}g)" clip-path="url(#${uid}l)"/>
      <path class="ln-main" d="${line}" stroke="${col}" clip-path="url(#${uid}l)"/>
      <path class="ln-rest" d="${line}" clip-path="url(#${uid}r)"/>
      ${mk.map((i) => `<circle class="ln-buy" cx="${X(i)}" cy="${Y(pts[i].v)}" r="3.5"><title>Your buy</title></circle>`).join("")}
      ${xIdx.map((i, k) => `<text class="ln-x" x="${X(i)}" y="${H - 5}" text-anchor="${k ? "middle" : "start"}">${esc(xFmt(pts[i].t, true))}</text>`).join("")}
      <g class="ln-scrub" style="display:none"><text class="ln-date" y="13"></text><circle class="ln-halo" r="15" fill="${col}"/><circle class="ln-dot" r="5.5" fill="${col}"/></g>
      <circle class="ln-end" cx="${X(n - 1)}" cy="${Y(pts[n - 1].v)}" r="3.5" fill="${col}"/>
      <rect class="ln-hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
    </svg>`;
    const svg = box.querySelector("svg"), g = svg.querySelector(".ln-scrub"), dt = g.querySelector(".ln-date");
    const cl = svg.querySelector(".cl"), cr = svg.querySelector(".cr"), end = svg.querySelector(".ln-end");
    const hit = svg.querySelector(".ln-hit");
    function show(i) {
      const x = X(i), y = Y(pts[i].v);
      cl.setAttribute("width", x); cr.setAttribute("x", x);
      g.style.display = ""; end.style.display = "none";
      g.querySelector(".ln-dot").setAttribute("cx", x); g.querySelector(".ln-dot").setAttribute("cy", y);
      g.querySelector(".ln-halo").setAttribute("cx", x); g.querySelector(".ln-halo").setAttribute("cy", y);
      dt.textContent = xFmt(pts[i].t, false);
      const tw = dt.getComputedTextLength ? dt.getComputedTextLength() : 80;
      dt.setAttribute("x", Math.min(Math.max(x - tw / 2, 2), W - tw - 2));
      opts.onScrub?.(pts[i], i);
    }
    function reset() {
      cl.setAttribute("width", W); cr.setAttribute("x", W);
      g.style.display = "none"; end.style.display = "";
      opts.onScrub?.(null);
    }
    const idxAt = (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(((x - M.l) / iw) * (n - 1))));
    };
    // finger: horizontal drags scrub (touch-action: pan-y keeps vertical page scrolling); mouse: hover
    let down = false;
    hit.addEventListener("pointerdown", (e) => { down = true; try { hit.setPointerCapture(e.pointerId); } catch { /* */ } show(idxAt(e)); });
    hit.addEventListener("pointermove", (e) => { if (down || e.pointerType === "mouse") show(idxAt(e)); });
    const stop = (e) => { down = false; if (e.pointerType !== "mouse" || e.type === "pointerleave") reset(); };
    hit.addEventListener("pointerup", stop);
    hit.addEventListener("pointercancel", stop);
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") reset(); });
    return { reset };
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function xFormatter(d) {
    const f = (o) => new Intl.DateTimeFormat(undefined, o);
    const r = d.range;
    if (d.intraday && r === "1D") { const a = f({ hour: "2-digit", minute: "2-digit" }); return (ms) => a.format(ms); }
    if (d.intraday) {
      const ax = f(r === "1W" ? { weekday: "short", day: "numeric" } : { day: "numeric", month: "short" });
      const full = f({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return (ms, axis) => (axis ? ax : full).format(ms);
    }
    const ax = f(r === "MAX" ? { year: "numeric" } : r === "1Y" ? { month: "short" } : { day: "numeric", month: "short" });
    const full = f({ day: "numeric", month: "short", year: "numeric" });
    return (ms, axis) => (axis ? ax : full).format(ms);
  }

  // ------------------------------------------------------------------ the sheet
  window.StonksSheet = function (ctx) {
    const { api, state, base, saveSettings, fmtMoney, fmtPrice, fmtSigned, fmtPct, fmtNum, fmtDate, fmtHeld, cls,
      positionFor, openTx, openPosition, openChart, $ } = ctx;
    const dlg = $("#dlg-sheet"), body = $("#sheet-body");
    const RANGES = [["1D", "1D"], ["1W", "1W"], ["1M", "1M"], ["1Y", "1Y"], ["MAX", "Max"]];
    const cache = new Map(), vcache = new Map();
    let cur = null, chart = null, seq = 0;
    const rng = () => state.settings.sheet_range || "1D";
    const SINCE = { "1D": "today", "1W": "past week", "1M": "past month", "1Y": "past year", MAX: "all time" };

    function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
    const initials = (sym) => sym.replace(/^\^/, "").replace(/[^A-Z0-9]/gi, "").slice(0, 2).toUpperCase();

    function open(symbol, hint = {}) {
      if (!symbol) return;
      cur = { symbol: symbol.toUpperCase(), hint };
      render();
      if (!dlg.open) dlg.showModal();
      body.scrollTop = 0;
      refreshExt();
      load();
      ctx.onOpenChange?.();
    }
    dlg.addEventListener("close", () => { scrubbing = false; ctx.onOpenChange?.(); });
    // real-time ticks (Settings → Live prices → Real-time): move the price and the end of the 1D line
    let scrubbing = false, tickDrawn = 0;
    function tick(by) {
      if (!dlg.open || !cur?.data) return;
      const t = by[cur.symbol];
      if (!t) return;
      const d = cur.data;
      d.price = t.p; d.last = t.p;
      if (d.range === "1D" && d.intraday && d.points.length) {
        const lastPt = d.points[d.points.length - 1];
        if (t.t - lastPt[0] >= 5 * 60e3) d.points.push([t.t, t.p]); else lastPt[1] = t.p;
      }
      if (scrubbing) return;
      if (Date.now() - tickDrawn > 2000) { tickDrawn = Date.now(); draw(); }
      else { const el = $("#sh-px"); if (el) el.textContent = fmtPrice(t.p, d.currency); }
    }
    // US pre-market / after-hours line under the price (static/premarket.js)
    function refreshExt() {
      const el = dlg.open || cur ? $("#sh-ext") : null;
      if (!el || !cur) return;
      const r = ctx.ext?.(cur.symbol);
      el.innerHTML = r && r.price != null ? `${r.kind === "est" ? `<span title="Its exchange is closed: estimated from ${esc((r.drivers || []).slice(0, 3).map((d) => d.label).join(", "))} since its last close">Indicative now</span>` : r.kind === "pre" ? "Pre-market" : "After-hours"} <b>${esc(fmtPrice(r.price, r.currency))}</b>
        <span class="${cls(r.change_pct)}">${r.change_pct > 0 ? "▲" : r.change_pct < 0 ? "▼" : ""} ${Math.abs(r.change_pct).toFixed(2)} %</span>${r.time ? ` · ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(r.time * 1000)}` : ""}` : "";
    }
    async function load() {
      const my = ++seq, sym = cur.symbol, r = rng(), k = `${sym}|${r}`;
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < (r === "1D" ? 60e3 : r === "1W" ? 120e3 : 15 * 60e3)) { cur.data = hit.data; draw(); }
      else {
        $("#sh-chart").innerHTML = '<div class="loading">Loading chart…</div>';
        try { const d = await api(`/api/chart?symbol=${encodeURIComponent(sym)}&range=${r}`); cache.set(k, { at: Date.now(), data: d }); if (my !== seq) return; cur.data = d; draw(); }
        catch (e) { if (my === seq) $("#sh-chart").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
      }
      stats();
    }

    function render() {
      const sym = cur.symbol, p = positionFor(sym), name = p?.display_name || cur.hint.name || sym;
      body.innerHTML = `
        <div class="sh-top"><div class="sh-logo" style="background:hsl(${hue(sym)} 45% 38%)">${esc(initials(sym))}</div>
          <button class="sh-x" aria-label="Close">✕</button></div>
        <div class="sh-name">${esc(name)} <span>${esc(sym)}</span></div>
        <div class="sh-price"><b id="sh-px">${p?.ok ? esc(fmtPrice(p.price, p.price_currency)) : cur.hint.price != null ? esc(fmtPrice(cur.hint.price, cur.hint.currency)) : "—"}</b><span id="sh-ch"></span></div>
        <div class="sh-when" id="sh-when">&nbsp;</div>
        <div class="sh-ext" id="sh-ext"></div>
        <div class="sh-ranges" role="tablist">${RANGES.map(([v, l]) => `<button data-r="${v}" class="${v === rng() ? "active" : ""}">${l}</button>`).join("")}</div>
        <div class="sh-chart" id="sh-chart"></div>
        ${p ? cards(p) : ""}
        <h4 class="sh-h">Key stats</h4><dl class="sh-stats" id="sh-stats"></dl>
        <div class="sh-actions">${p ? `<button class="btn" data-a="buy">Buy more</button><button class="btn" data-a="sell">Sell</button>` : ["INDEX", "CURRENCY", "FUTURE"].includes(cur.hint.quote_type) ? "" : `<button class="btn" data-a="buy">Record a buy</button>`}<button class="btn primary" data-a="ta">Analysis</button></div>`;
    }

    function cards(p) {
      const b = base(), t = state.port?.totals || {};
      const c = (k, v, sub = "", tone = "") => `<div class="sh-card"><div class="k">${k}</div><div class="v ${tone}">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
      const avg = avgBuy(p);
      return `<div class="sh-cards">
        ${c("Position", fmtMoney(p.value, b), `${fmtNum(p.quantity)} units`)}
        ${c("Return", `${p.pnl_pct > 0 ? "▲" : p.pnl_pct < 0 ? "▼" : ""} ${fmtPct(Math.abs(p.pnl_pct ?? 0)).replace(/^[+−]/, "")}`, fmtSigned(p.pnl, b), cls(p.pnl))}
        ${c("Today", fmtSigned(p.day_pnl, b), fmtPct(p.changes?.["1D"]), cls(p.day_pnl))}
        ${c("Avg buy price", avg != null ? fmtPrice(avg, p.price_currency) : "—", `cost ${fmtMoney(p.cost, b)}`)}
        ${c("Held", p.bought_at ? esc(fmtHeld(p.bought_at)) : "—", p.bought_at ? `${p.lots ? "since " : ""}${esc(fmtDate(p.bought_at))}` : "")}
        ${c("Weight", t.value && p.value ? `${(p.value / t.value * 100).toFixed(1)}%` : "—", "of your portfolio")}
      </div>`;
    }
    // average buy price in the quote currency (for the dashed line): cost converted with today's FX
    function avgBuy(p) {
      const fx = state.port?.fx || {};
      const r = fx[p.currency] && fx[p.price_currency] ? fx[p.currency] / fx[p.price_currency] : 1;
      return p.avg_cost != null ? p.avg_cost * r : null;
    }

    function draw() {
      const d = cur.data, p = positionFor(cur.symbol);
      const ccy = d.currency;
      const head = (v, ch, pct, when) => {
        $("#sh-px").textContent = fmtPrice(v, ccy);
        const el = $("#sh-ch");
        el.className = cls(ch);
        el.textContent = pct == null ? "" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : ""} ${Math.abs(pct).toFixed(2)} %`;
        el.title = ch == null ? "" : `${fmtSigned(ch, ccy)} ${d.range === "1D" ? "vs the previous close" : "since the start of the range"}`;
        $("#sh-when").textContent = when;
      };
      const base0 = () => head(d.price ?? d.last, (d.price ?? d.last) - d.ref, ((d.price ?? d.last) / d.ref - 1) * 100,
        `${SINCE[d.range]}${d.range === "1D" ? " · vs previous close" : ""}${d.chart_source ? ` · chart: ${d.chart_source}` : d.source ? ` · prices via ${d.source}` : ""}`);
      base0();
      const markers = p ? (p.lots || [p]).map((l) => (l.bought_at ? new Date(`${l.bought_at}T12:00:00`).getTime() : null)).filter(Boolean) : [];
      const xf = xFormatter(d);
      chart = window.StonksLine($("#sh-chart"), d, {
        fmt: (v) => fmtPrice(v, ccy), axisFmt: (v) => axisPrice(v, ccy), markers, avg: p ? avgBuy(p) : null,
        onScrub: (pt) => { scrubbing = !!pt; return pt ? head(pt.v, pt.v - d.ref, (pt.v / d.ref - 1) * 100, xf(pt.t, false)) : base0(); },
      });
    }

    function axisPrice(v, ccy) {     // shorter labels on the price axis: no cents above 1,000
      try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v); }
      catch { return fmtPrice(v, ccy); }
    }

    async function stats() {
      const sym = cur.symbol, d = cur.data, m = state.moves?.[sym], p = positionFor(sym);
      const rows = [];
      const ccy = d?.currency || p?.price_currency;
      if (d?.prev_close) rows.push(["Previous close", fmtPrice(d.prev_close, ccy)]);
      if (d?.points?.length) {
        const v = d.points.map((x) => x[1]);
        rows.push([`Range (${d.range === "MAX" ? "max" : d.range})`, `${fmtPrice(Math.min(...v), ccy)} – ${fmtPrice(Math.max(...v), ccy)}`]);
      }
      const y = m?.windows?.["1y"];
      if (y) rows.push(["52-week low – high", `${fmtPrice(y.lo, ccy)} – ${fmtPrice(y.hi, ccy)}`, `${y.from_hi != null ? `${(y.from_hi * 100).toFixed(1)}% from the high` : ""}`]);
      if (m) rows.push(["Typical day", `±${(m.median_abs * 100).toFixed(1)}%`, "half of last year's days moved less"]);
      if (d?.sector) rows.push(["Sector", esc(d.sector) + (d.industry ? ` · ${esc(d.industry)}` : "")]);
      const fill = () => { $("#sh-stats").innerHTML = rows.map(([k, v, s]) => `<dt>${k}</dt><dd>${v}${s ? `<span>${esc(s)}</span>` : ""}</dd>`).join(""); };
      fill();
      if (d?.quote_type !== "EQUITY" || !$("#sh-stats")) return;
      let v = vcache.get(sym);
      if (!v) { try { v = await api(`/api/valuation?symbol=${encodeURIComponent(sym)}`); vcache.set(sym, v); } catch { return; } }
      if (cur?.symbol !== sym) return;
      const x = (val, f = 1) => (val == null || !isFinite(val) ? null : `${val.toFixed(f)}×`);
      if (x(v.pe)) rows.push(["Price-to-earnings (P/E)", x(v.pe), "price ÷ last 12 months' earnings per share"]);
      if (x(v.fpe)) rows.push(["Forward P/E", x(v.fpe), "on analysts' next-12-month estimate"]);
      if (x(v.pb)) rows.push(["Price-to-book (P/B)", x(v.pb)]);
      if (v.market_cap) rows.push(["Market cap", fmtMoney(v.market_cap, v.currency || ccy, true)]);
      fill();
    }

    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) return dlg.close();                    // backdrop
      if (e.target.closest(".sh-x")) return dlg.close();
      const r = e.target.closest(".sh-ranges button");
      if (r) {
        saveSettings({ sheet_range: r.dataset.r });
        body.querySelectorAll(".sh-ranges button").forEach((b) => b.classList.toggle("active", b === r));
        load();
        return;
      }
      const a = e.target.closest("[data-a]");
      if (!a) return;
      const sym = cur.symbol, p = positionFor(sym);
      dlg.close();
      if (a.dataset.a === "ta") openChart(sym);
      else if (a.dataset.a === "sell") openTx("SELL", { symbol: sym, account: p?.lots ? (p.lots.every((l) => l.account === p.lots[0].account) ? p.lots[0].account : "") : p?.account });
      else openPosition(null, { symbol: sym });
    });
    // swipe the grab bar / header down to close (phones)
    let y0 = null;
    body.addEventListener("touchstart", (e) => { y0 = body.scrollTop <= 0 && !e.target.closest(".sh-chart, .sh-cards") ? e.touches[0].clientY : null; }, { passive: true });
    body.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      dlg.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    }, { passive: true });
    body.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
      dlg.style.transform = "";
      y0 = null;
      if (dy > 110) dlg.close();
    });
    let rz;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (dlg.open && cur?.data) draw(); }, 200); });
    // live: the portfolio refreshed → refresh the header price when 1D is shown
    function refresh() {
      if (!dlg.open || !cur) return;
      if (rng() === "1D") { cache.delete(`${cur.symbol}|1D`); load(); }
    }
    return { open, refresh, refreshExt, tick, isOpen: () => dlg.open, symbol: () => cur?.symbol };
  };
})();
