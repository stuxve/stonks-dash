/* stonks-dash — Holdings: P&L (profit and loss) since your first buy, as an alternative to the heatmap.
 * Unrealized P&L = value of what you held each day − its cost (the "Unrealized P&L" figure, day by day).
 * Total = value − net money put in (adds realized gains, dividends and currency effects). */
window.StonksPnlHist = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtMoney, fmtSigned, fmtPct, fmtDate, cls, $ } = ctx;
  let perf = null, at = 0, key = "", loading = false;
  const mode = () => (state.settings.p_hist_mode === "total" ? "total" : "unrealized");
  const unit = () => (state.settings.p_hist_unit === "pct" ? "pct" : "money");
  const rng = () => state.settings.p_hist_range || "All";

  async function load(force) {
    const k = base();
    if (loading || (!force && perf && k === key && Date.now() - at < 5 * 60e3)) return;
    loading = true;
    try { perf = await api(`/api/performance?base=${encodeURIComponent(k)}`); at = Date.now(); key = k; }
    catch (e) { $("#p-pnlh").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    finally { loading = false; }
    render(state.port?.totals);
  }

  function series(t) {
    if (!perf || !perf.dates?.length) return [];
    const pts = perf.dates.map((d, i) => {
      const v = perf.value[i], c = perf.cost?.[i], inv = perf.invested[i];
      const pnl = mode() === "total" ? (v != null && inv != null ? v - inv : null) : (v != null && c != null ? v - c : null);
      const basis = mode() === "total" ? inv : c;
      return { t: new Date(d + "T00:00:00"), d, pnl, basis, value: v, cost: c, invested: inv };
    }).filter((p) => p.pnl != null);
    // live last point: the Unrealized P&L box (refreshed every minute)
    if (t && pts.length && mode() === "unrealized") { const l = pts[pts.length - 1]; l.pnl = t.pnl; l.value = t.value; l.cost = t.cost; l.basis = t.cost; }
    return pts.map((p) => ({ ...p, y: unit() === "pct" ? (p.basis > 0 ? (p.pnl / p.basis) * 100 : null) : p.pnl })).filter((p) => p.y != null);
  }

  function cut(pts) {
    const r = rng();
    if (r === "All" || !pts.length) return pts;
    const end = pts[pts.length - 1].t, from = new Date(end);
    if (r === "YTD") from.setMonth(0, 1); else from.setMonth(from.getMonth() - { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 }[r]);
    const out = pts.filter((p) => p.t >= from);
    return out.length >= 2 ? out : pts.slice(-2);
  }

  function render(t) {
    const el = $("#p-pnlh");
    if (!el || el.hidden) return;
    const b = base(), all = series(t), pts = cut(all), M = mode(), U = unit();
    const fmtY = (v) => (U === "pct" ? fmtPct(v) : fmtSigned(v, b));
    const head = `<div class="pnlh-head">
        <span class="seg" id="pnlh-mode"><button data-v="unrealized" class="${M === "unrealized" ? "active" : ""}" title="Value of what you held each day minus what it cost — the Unrealized P&L figure over time">Unrealized P&amp;L</button><button data-v="total" class="${M === "total" ? "active" : ""}" title="Value minus the net money you put in: adds realized gains, dividends and currency effects">Total incl. realized</button></span>
        <span class="seg" id="pnlh-unit"><button data-v="money" class="${U === "money" ? "active" : ""}">${esc(b)}</button><button data-v="pct" class="${U === "pct" ? "active" : ""}">%</button></span>
        <span class="seg" id="pnlh-range">${["1M", "3M", "6M", "YTD", "1Y", "All"].map((r) => `<button data-v="${r}" class="${r === rng() ? "active" : ""}">${r}</button>`).join("")}</span>
        <span class="grow"></span>${pts.length ? summary(pts, all, fmtY, b) : ""}</div>`;
    if (!perf) { el.innerHTML = head + '<div class="loading">Rebuilding your P&amp;L history…</div>'; return; }
    if (pts.length < 2) { el.innerHTML = head + '<div class="empty">Not enough history yet.</div>'; return; }
    el.innerHTML = head + '<div class="pnlh-chart" id="pnlh-chart"><div class="pnlh-tip" hidden></div></div>';
    draw(pts, fmtY, b);
  }

  function summary(pts, all, fmtY, b) {
    const last = pts[pts.length - 1], first = pts[0];
    const hi = pts.reduce((m, p) => (p.y > m.y ? p : m), pts[0]), lo = pts.reduce((m, p) => (p.y < m.y ? p : m), pts[0]);
    const ch = last.y - first.y;
    return `<span class="pnlh-sum">now <b class="${cls(last.y)}">${fmtY(last.y)}</b>
      ${rng() !== "All" ? ` · <span class="${cls(ch)}">${unit() === "pct" ? `${ch > 0 ? "+" : ch < 0 ? "−" : ""}${Math.abs(ch).toFixed(2)} pp` : fmtSigned(ch, b)}</span> in ${esc(rng())}` : ""}
      · best <span class="up">${fmtY(hi.y)}</span> <span class="sub">${esc(fmtDate(hi.d))}</span>
      · worst <span class="down">${fmtY(lo.y)}</span> <span class="sub">${esc(fmtDate(lo.d))}</span></span>`;
  }

  function draw(pts, fmtY, b) {
    const box = $("#pnlh-chart"), d3 = window.d3;
    const W = Math.max(300, box.clientWidth || 900), H = Math.max(300, Math.min(520, Math.round(window.innerHeight * 0.5))), Mg = { l: 10, r: 84, t: 10, b: 24 };
    const X = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([Mg.l, W - Mg.r]);
    const lo = Math.min(0, d3.min(pts, (p) => p.y)), hi = Math.max(0, d3.max(pts, (p) => p.y)), pad = (hi - lo) * 0.08 || 1;
    const Y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice().range([H - Mg.b, Mg.t]);
    const sv = d3.select(box).append("svg").attr("width", W).attr("height", H).attr("class", "pnlh-svg");
    const uid = `ph${Math.random().toString(36).slice(2, 7)}`, defs = sv.append("defs");
    defs.append("clipPath").attr("id", `${uid}u`).append("rect").attr("width", W).attr("height", Math.max(0, Y(0)));
    defs.append("clipPath").attr("id", `${uid}d`).append("rect").attr("y", Y(0)).attr("width", W).attr("height", Math.max(0, H - Y(0)));
    const strip = (s) => String(s).replace(/<[^>]+>/g, "");
    // short axis labels: +€20K, −5%
    const cmp = new Intl.NumberFormat(undefined, { style: "currency", currency: b, notation: "compact", maximumFractionDigits: 1 });
    const tickFmt = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + (unit() === "pct" ? `${Math.abs(v)}%` : cmp.format(Math.abs(v)));
    sv.append("g").selectAll("line").data(Y.ticks(6)).join("line").attr("x1", Mg.l).attr("x2", W - Mg.r).attr("y1", Y).attr("y2", Y).attr("stroke", "rgba(255,255,255,.05)");
    sv.append("g").attr("transform", `translate(${W - Mg.r},0)`).call(d3.axisRight(Y).ticks(6).tickFormat(tickFmt)).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("g").attr("transform", `translate(0,${H - Mg.b})`).call(d3.axisBottom(X).ticks(Math.max(3, Math.floor(W / 150)))).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    const area = d3.area().curve(d3.curveMonotoneX).x((p) => X(p.t)).y0(Y(0)).y1((p) => Y(p.y));
    const line = d3.line().curve(d3.curveMonotoneX).x((p) => X(p.t)).y((p) => Y(p.y));
    for (const [clip, fill, stroke] of [[`${uid}u`, "rgba(48,204,90,.22)", "var(--up)"], [`${uid}d`, "rgba(246,53,56,.22)", "var(--down)"]]) {
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", fill).attr("d", area);
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", "none").attr("stroke", stroke).attr("stroke-width", 1.8).attr("d", line);
    }
    sv.append("line").attr("x1", Mg.l).attr("x2", W - Mg.r).attr("y1", Y(0)).attr("y2", Y(0)).attr("stroke", "rgba(255,255,255,.35)").attr("stroke-dasharray", "4 4");
    const last = pts[pts.length - 1], up = last.y >= 0;
    sv.selectAll(".tick text").filter((v) => typeof v === "number" && Math.abs(Y(v) - Y(last.y)) < 13).attr("opacity", 0);   // under the live tag
    const g = sv.append("g").attr("transform", `translate(${W - Mg.r + 1},${Y(last.y)})`);
    g.append("rect").attr("y", -9).attr("width", Mg.r - 2).attr("height", 18).attr("rx", 3).attr("fill", up ? "#1f8f3f" : "#b4282b");
    g.append("text").attr("x", 4).attr("y", 4).attr("font-size", 10.5).attr("fill", "#fff").text(strip(fmtY(last.y)));
    sv.append("circle").attr("cx", X(last.t)).attr("cy", Y(last.y)).attr("r", 3.5).attr("fill", up ? "var(--up)" : "var(--down)");
    // hover read-out
    const tip = box.querySelector(".pnlh-tip"), hl = sv.append("line").attr("y1", Mg.t).attr("y2", H - Mg.b).attr("stroke", "rgba(255,255,255,.35)").style("display", "none");
    const dot = sv.append("circle").attr("r", 3.5).attr("fill", "var(--text)").style("display", "none");
    sv.append("rect").attr("x", Mg.l).attr("y", Mg.t).attr("width", W - Mg.r - Mg.l).attr("height", H - Mg.t - Mg.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const [mx] = d3.pointer(e), p = pts[d3.bisector((q) => q.t).center(pts, X.invert(mx))], x = X(p.t);
        hl.attr("x1", x).attr("x2", x).style("display", null); dot.attr("cx", x).attr("cy", Y(p.y)).style("display", null);
        const pct = p.basis > 0 ? (p.pnl / p.basis) * 100 : null;
        tip.innerHTML = `<b>${esc(fmtDate(p.d))}</b><br>${mode() === "total" ? "Total P&amp;L" : "Unrealized P&amp;L"} <b class="${cls(p.pnl)}">${fmtSigned(p.pnl, b)}</b>${pct != null ? ` <span class="${cls(pct)}">${fmtPct(pct)}</span>` : ""}
          <br><span class="sub">value</span> ${fmtMoney(p.value, b)} · <span class="sub">${mode() === "total" ? "net invested" : "cost"}</span> ${fmtMoney(p.basis, b)}`;
        tip.hidden = false; tip.style.left = `${Math.min(x + 12, W - 250)}px`;
      })
      .on("mouseleave", () => { hl.style("display", "none"); dot.style("display", "none"); tip.hidden = true; });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("#pnlh-mode button, #pnlh-unit button, #pnlh-range button");
    if (!b) return;
    const k = b.parentElement.id === "pnlh-mode" ? "p_hist_mode" : b.parentElement.id === "pnlh-unit" ? "p_hist_unit" : "p_hist_range";
    saveSettings({ [k]: b.dataset.v });
    render(state.port?.totals);
  });
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => render(state.port?.totals), 200); });
  return { show: (t) => { render(t); load(false); }, reload: () => load(true) };
};
