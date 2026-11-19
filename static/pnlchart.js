/* stonks-dash — portfolio summary as a live P&L (profit and loss) chart: today's P&L through the day (or the last
 * 5 sessions), with the key totals and the holdings that moved it most. Alternative to the summary boxes. */
window.StonksPnl = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtMoney, fmtSigned, fmtPct, cls, $ } = ctx;
  let data = null, at = 0, loading = false, forKey = "";
  const range = () => (state.settings.p_pnl_range === "5d" ? "5d" : "1d");
  const tf = (d, opts) => new Intl.DateTimeFormat(undefined, opts).format(d);

  async function fetchData(force) {
    const key = `${range()}|${base()}`;
    if (loading || (!force && data && key === forKey && Date.now() - at < 60e3)) return;
    loading = true;
    try {
      data = await api(`/api/portfolio/intraday?range=${range()}&base=${encodeURIComponent(base())}`);
      at = Date.now(); forKey = key;
    } catch (e) { console.warn("intraday P&L", e); }
    finally { loading = false; }
    render(state.port?.totals);
  }

  function render(t) {
    const el = $("#kpis");
    if (!t) return;
    el.classList.add("pnl-mode");
    const b = base(), r = range();
    // keep the chart's last point in step with the live totals between fetches (1d only: same definition)
    const pts = (data && data.range === r && data.base === b ? data.points : []).map(([ts, v]) => ({ t: new Date(ts), v }));
    if (r === "1d" && pts.length) pts[pts.length - 1] = { t: new Date(), v: t.day_pnl };
    const now = r === "1d" ? t.day_pnl : data?.now, pct = r === "1d" ? t.day_pct : data?.pct;
    const realized = (t.realized || 0) + (t.dividends || 0);
    const movers = (data && data.range === r ? data.movers : []).slice(0, 6);
    const mx = Math.max(1e-9, ...movers.map((m) => Math.abs(m.pnl)));
    el.innerHTML = `<div class="pnl-card">
      <div class="pnl-side">
        <div class="k">${r === "1d" ? "Today" : "Last 5 sessions"}</div>
        <div class="pnl-big ${cls(now)}">${now == null ? "—" : fmtSigned(now, b)}</div>
        <div class="${cls(now)}">${pct == null ? "" : fmtPct(pct)}${r === "5d" ? ' <span class="sub" title="Change in value of the positions you hold now; buys and sells during these days are not taken into account">· current holdings</span>' : ""}</div>
        <dl class="pnl-stats">
          <dt>Market value</dt><dd>${fmtMoney(t.value, b)}</dd>
          <dt>Unrealized P&amp;L</dt><dd class="${cls(t.pnl)}">${fmtSigned(t.pnl, b)} <span class="sub">${fmtPct(t.pnl_pct)}</span></dd>
          <dt>Realized + dividends</dt><dd class="${cls(realized)}">${fmtSigned(realized, b)}</dd>
          <dt>Vs index</dt><dd class="${cls(t.vs_bench)}">${t.vs_bench == null ? "—" : `${t.vs_bench > 0 ? "+" : t.vs_bench < 0 ? "−" : ""}${Math.abs(t.vs_bench).toFixed(2)} pp`}</dd>
        </dl>
      </div>
      <div class="pnl-main">
        <div class="pnl-head"><span class="seg" id="pnl-range"><button data-v="1d" class="${r === "1d" ? "active" : ""}">1D</button><button data-v="5d" class="${r === "5d" ? "active" : ""}">5D</button></span>
          <span class="sub">${r === "1d" ? "P&amp;L since each asset's previous close" : "P&amp;L of today's holdings over the last 5 sessions"} · ${data ? `updated ${tf(new Date(data.as_of * 1000), { hour: "2-digit", minute: "2-digit" })}` : "loading…"}</span></div>
        <div class="pnl-chart" id="pnl-chart">${pts.length ? "" : `<div class="hint">${data ? "No intraday prices yet today." : "Loading intraday prices…"}</div>`}<div class="pnl-tip" hidden></div></div>
      </div>
      <div class="pnl-movers">
        <div class="k">Biggest movers</div>
        ${movers.map((m) => `<div class="pnl-mv" title="${esc(m.name || m.symbol)}${m.live ? "" : " — market not open yet today: shows its last session"}">
          <span class="pnl-sym">${esc(m.symbol)}${m.live ? "" : ' <span class="sub">closed</span>'}</span>
          <span class="pnl-bar"><i class="${m.pnl >= 0 ? "pnl-pos" : "pnl-neg"}" style="width:${(Math.abs(m.pnl) / mx) * 100}%"></i></span>
          <span class="pnl-num ${cls(m.pnl)}">${fmtSigned(m.pnl, b)}</span></div>`).join("") || '<div class="hint">—</div>'}
      </div></div>`;
    if (pts.length) draw(pts, r, b, t);
  }

  function draw(pts, r, b, t) {
    const box = $("#pnl-chart"), d3 = window.d3;
    const W = Math.max(260, box.clientWidth || 600), H = 168, M = { l: 22, r: 64, t: 8, b: 20 };
    if (pts.length === 1) pts = [{ t: new Date(pts[0].t.getTime() - 60e3), v: 0 }, ...pts];
    const X = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([M.l, W - M.r]);
    const lo = Math.min(0, d3.min(pts, (p) => p.v)), hi = Math.max(0, d3.max(pts, (p) => p.v));
    const pad = (hi - lo) * 0.12 || Math.abs(hi || lo || 1) * 0.1 || 1;
    const Y = d3.scaleLinear().domain([lo - pad, hi + pad]).range([H - M.b, M.t]);
    const sv = d3.select(box).append("svg").attr("width", W).attr("height", H).attr("class", "ta-svg");
    const uid = `pnl${Math.random().toString(36).slice(2, 7)}`, defs = sv.append("defs");
    defs.append("clipPath").attr("id", `${uid}u`).append("rect").attr("x", 0).attr("y", 0).attr("width", W).attr("height", Math.max(0, Y(0)));
    defs.append("clipPath").attr("id", `${uid}d`).append("rect").attr("x", 0).attr("y", Y(0)).attr("width", W).attr("height", Math.max(0, H - Y(0)));
    const fmtAx = (v) => fmtSigned(v, b).replace(/<[^>]+>/g, "");
    sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y).ticks(4).tickFormat(fmtAx)).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    const xt = r === "1d" ? d3.timeFormat("%H:%M") : (d) => tf(d, { weekday: "short", day: "numeric" });
    sv.append("g").attr("transform", `translate(0,${H - M.b})`).call(d3.axisBottom(X).ticks(r === "1d" ? Math.max(3, Math.floor(W / 90)) : d3.timeDay.every(1)).tickFormat(xt)).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    const area = d3.area().curve(d3.curveMonotoneX).x((p) => X(p.t)).y0(Y(0)).y1((p) => Y(p.v));
    const line = d3.line().curve(d3.curveMonotoneX).x((p) => X(p.t)).y((p) => Y(p.v));
    for (const [clip, fill, stroke] of [[`${uid}u`, "rgba(48,204,90,.22)", "var(--up)"], [`${uid}d`, "rgba(246,53,56,.22)", "var(--down)"]]) {
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", fill).attr("d", area);
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", "none").attr("stroke", stroke).attr("stroke-width", 1.8).attr("d", line);
    }
    sv.append("line").attr("x1", M.l).attr("x2", W - M.r).attr("y1", Y(0)).attr("y2", Y(0)).attr("stroke", "rgba(255,255,255,.35)").attr("stroke-dasharray", "4 4");
    // day separators on the 5-session view
    if (r === "5d") {
      const days = d3.timeDays(d3.timeDay.ceil(pts[0].t), pts[pts.length - 1].t);
      sv.append("g").selectAll("line").data(days).join("line").attr("x1", X).attr("x2", X).attr("y1", M.t).attr("y2", H - M.b).attr("stroke", "rgba(255,255,255,.07)");
    }
    const last = pts[pts.length - 1], up = last.v >= 0;
    sv.append("circle").attr("class", "pnl-live").attr("cx", X(last.t)).attr("cy", Y(last.v)).attr("r", 4).attr("fill", up ? "var(--up)" : "var(--down)");
    const lb = sv.append("g").attr("transform", `translate(${W - M.r + 1},${Y(last.v)})`);
    lb.append("rect").attr("y", -9).attr("width", M.r - 2).attr("height", 18).attr("rx", 3).attr("fill", up ? "#1f8f3f" : "#b4282b");
    lb.append("text").attr("x", 4).attr("y", 4).attr("font-size", 10.5).attr("fill", "#fff").text(fmtAx(last.v));
    // hover read-out
    const tip = box.querySelector(".pnl-tip"), hl = sv.append("line").attr("y1", M.t).attr("y2", H - M.b).attr("stroke", "rgba(255,255,255,.35)").style("display", "none");
    const dot = sv.append("circle").attr("r", 3.5).attr("fill", "var(--text)").style("display", "none");
    const basis = r === "1d" ? (t.value - t.day_pnl) : null;
    sv.append("rect").attr("x", M.l).attr("y", M.t).attr("width", W - M.r - M.l).attr("height", H - M.t - M.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const [mx] = d3.pointer(e), i = d3.bisector((p) => p.t).center(pts, X.invert(mx)), p = pts[i], x = X(p.t);
        hl.attr("x1", x).attr("x2", x).style("display", null); dot.attr("cx", x).attr("cy", Y(p.v)).style("display", null);
        tip.innerHTML = `<b>${tf(p.t, r === "1d" ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b> · <span class="${cls(p.v)}">${fmtSigned(p.v, b)}</span>${basis ? ` <span class="sub">${fmtPct((p.v / basis) * 100)}</span>` : ""}`;
        tip.hidden = false; tip.style.left = `${Math.min(x + 10, W - 180)}px`;
      })
      .on("mouseleave", () => { hl.style("display", "none"); dot.style("display", "none"); tip.hidden = true; });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("#pnl-range button");
    if (!b) return;
    saveSettings({ p_pnl_range: b.dataset.v });
    render(state.port?.totals);
    fetchData(true);
  });
  // re-draw on resize (the chart is sized to its box)
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if ($("#kpis").classList.contains("pnl-mode")) render(state.port?.totals); }, 200); });

  return { render: (t) => { render(t); fetchData(false); } };
};
