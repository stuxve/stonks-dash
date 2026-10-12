/* stonks-dash — Risk tab: volatility, drawdowns, how holdings move together, concentration, stress tests
 * and the earnings calendar. Numbers are computed on TODAY's holdings and weights replayed over past prices
 * (the "mix"), so they describe the portfolio you have now, not the one you had then. */
window.StonksRisk = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtMoney, fmtSigned, fmtDate, cls, showTip, moveTip, hideTip, targets, $, $$ } = ctx;

  const S = () => state.settings.risk || (state.settings.risk = {});
  const save = (patch) => saveSettings({ risk: { ...S(), ...patch } });
  const years = () => +(S().years || 3);
  const earnDays = () => +(S().earn_days || 7);
  let data = null, loading = false, earn = null, earnAt = 0;

  const pct = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`);
  const pctAbs = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
  const num = (v, d = 2) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
  const days = (n) => (n == null ? "" : n >= 365 ? `${(n / 365).toFixed(1)} years` : n >= 60 ? `${Math.round(n / 30.4)} months` : `${n} days`);
  const kpi = (k, v, d = "", title = "") => `<div class="kpi" ${title ? `title="${esc(title)}"` : ""}><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const CLS = { equity: "Stocks / equity funds", crypto: "Crypto", bond: "Bonds", gold: "Gold / commodities", other: "Manual / cash-like" };

  // ------------------------------------------------------------------ loading
  async function load(silent) {
    if (loading) return;
    loading = true;
    if (!silent || !data) $("#rk-kpis").innerHTML = `<div class="loading">Replaying ${years()} years of prices…</div>`;
    try {
      data = await api(`/api/risk?base=${base()}&years=${years()}`);
      draw();
    } catch (e) { $("#rk-kpis").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    finally { loading = false; }
    loadEarnings(true).then(drawEarnings);
  }
  async function loadEarnings(force) {
    if (!force && earn && Date.now() - earnAt < 30 * 60e3) return earn;
    try { earn = await api("/api/earnings"); earnAt = Date.now(); } catch (e) { console.warn(e); }
    return earn;
  }
  function badge() {
    const el = $("#rk-badge");
    if (!el) return;
    if (!earn || Date.now() - earnAt > 30 * 60e3) { earnAt = Date.now(); loadEarnings(true).then(badge); }
    const n = (earn?.items || []).filter((x) => x.days != null && x.days >= 0 && x.days <= earnDays()).length;
    el.textContent = n;
    el.hidden = !n;
    el.title = n ? `${n} holding${n > 1 ? "s" : ""} report${n > 1 ? "" : "s"} earnings in the next ${earnDays()} days` : "";
  }

  // ------------------------------------------------------------------ drawing
  function draw() {
    const d = data;
    $$("#rk-years button").forEach((x) => x.classList.toggle("active", +x.dataset.v === years()));
    if (!d || d.empty) { $("#rk-kpis").innerHTML = `<div class="empty">No priced holdings yet.</div>`; return; }
    const b = base(), mix = d.mix || {}, bn = d.bench || {}, dd = mix.dd;
    const bname = esc(d.benchmark?.name || d.benchmark?.symbol || "index");
    $("#rk-note").textContent = `Today's holdings and weights replayed over ${d.years} year${d.years > 1 ? "s" : ""} of prices (since ${fmtDate(d.start)}), in ${b}. Benchmark: ${d.benchmark?.symbol || "—"}.`;
    const conc = d.concentration || {};
    const ddTxt = dd ? `${fmtDate(dd.peak)} → ${fmtDate(dd.trough)} · ${dd.recovered ? `recovered ${fmtDate(dd.recovered)}, ${days(dd.days_total)} in all` : `not recovered yet (${days(dd.days_total)})`}` : "";
    $("#rk-kpis").innerHTML = [
      kpi("Volatility", `${pctAbs(mix.vol)}<small>/yr</small>`, `${bname}: ${pctAbs(bn.vol)} · a typical year moves about ±${pctAbs(mix.vol, 0)}`,
        "Annualised standard deviation of daily returns. Roughly two years in three end within ± this much of the average."),
      kpi("Max drawdown", `<span class="down">${pct(dd?.max)}</span>`, ddTxt, "Deepest fall from a peak to a later low, and how long until the previous peak was regained."),
      kpi("From the last peak", dd?.current < -0.0005 ? `<span class="down">${pct(dd.current)}</span>` : `<span class="up">at a high</span>`,
        dd?.current_since ? `peak on ${fmtDate(dd.current_since)}` : `${bname}: ${pct(bn.dd?.current)}`),
      kpi("Worst month", `<span class="down">${pct(mix.worst_month?.ret)}</span>`, mix.worst_month ? `${fmtDate(mix.worst_month.start)} → ${fmtDate(mix.worst_month.end)} · ${bname}: ${pct(bn.worst_month?.ret)}` : "",
        "Worst 21-trading-day stretch."),
      kpi(`Beta vs ${bname}`, num(mix.beta), mix.corr != null ? `correlation ${num(mix.corr)} · ${mix.beta != null ? `index −10% ≈ you ${pct(-0.1 * mix.beta)}` : ""}` : "",
        "How much the portfolio moves when the index moves 1%. Correlation (−1…1) is how closely it follows it."),
      kpi("Concentration", `${(conc.top5 || 0).toFixed(0)}%<small> top 5</small>`,
        `largest ${(conc.top1 || 0).toFixed(0)}% · like ${(conc.effective_n || 0).toFixed(1)} equal holdings${d.lookthrough ? ` · top 5 companies (incl. inside funds) ${d.lookthrough.top5.toFixed(0)}%` : ""}`,
        "Effective holdings = 1 / sum of squared weights: 10 equal holdings → 10; one at 90% → about 1.2."),
      d.actual?.dd ? kpi("Your actual max drawdown", `<span class="down">${pct(d.actual.dd.max)}</span>`,
        `real portfolio since ${fmtDate(d.actual.since)}, contributions removed · ${fmtDate(d.actual.dd.peak)} → ${fmtDate(d.actual.dd.trough)}`,
        "Time-weighted: what the portfolio you actually held lost, not counting money you added.") : "",
    ].join("");
    drawUnderwater();
    drawHoldings();
    drawCorr();
    drawConc();
    drawStress();
    drawScenarios();
  }

  function drawUnderwater() {
    const el = $("#rk-dd");
    const c = data.mix?.dd?.curve, bc = data.bench?.dd?.curve;
    if (!c) { el.innerHTML = ""; return; }
    const pts = c.dates.map((d, i) => ({ date: new Date(d), v: c.dd[i] }));
    const bmap = new Map(bc ? bc.dates.map((d, i) => [d, bc.dd[i]]) : []);
    const bpts = bc ? bc.dates.map((d, i) => ({ date: new Date(d), v: bc.dd[i] })) : [];
    const W = el.clientWidth || 900, H = 220, m = { t: 10, r: 16, b: 26, l: 52 };
    const lo = Math.min(d3.min(pts, (p) => p.v), bpts.length ? d3.min(bpts, (p) => p.v) : 0, -0.05);
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.date)).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([lo * 1.08, 0]).nice(4).range([H - m.b, m.t]);
    const area = d3.area().x((p) => x(p.date)).y0(y(0)).y1((p) => y(p.v))(pts);
    const bl = bpts.length ? d3.line().x((p) => x(p.date)).y((p) => y(p.v))(bpts) : "";
    const yt = y.ticks(4), xt = x.ticks(Math.max(2, Math.floor(W / 110)));
    const df = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
    el.innerHTML = `<svg class="lc" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Drawdown from the previous peak">
      <g class="grid">${yt.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="yaxis">${yt.map((t) => `<text x="${m.l - 8}" y="${y(t)}" dy="0.32em">${Math.round(t * 100)}%</text>`).join("")}</g>
      <g class="xaxis">${xt.map((t) => `<text x="${x(t)}" y="${H - 6}">${df.format(t)}</text>`).join("")}</g>
      <path class="dd-area" d="${area}"/>${bl ? `<path class="ln s-bench" d="${bl}"/>` : ""}
      <line class="xh" y1="${m.t}" y2="${H - m.b}" hidden/><circle class="dot dd-dot" r="4" hidden/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></svg>`;
    $("#rk-legend").innerHTML = `<span class="lk s-dd"><i class="sq"></i>Your mix, % below its previous peak</span>${bl ? `<span class="lk s-bench"><i></i>${esc(data.benchmark.symbol)}</span>` : ""}`;
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), dot = svg.querySelector(".dd-dot");
    const bis = d3.bisector((p) => p.date).center;
    const dfl = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
    svg.querySelector(".hit").addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const p = pts[bis(pts, x.invert(((e.clientX - r.left) / r.width) * W))];
      const X = x(p.date);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.hidden = false;
      dot.setAttribute("cx", X); dot.setAttribute("cy", y(p.v)); dot.hidden = false;
      const iso = p.date.toISOString().slice(0, 10), bv = bmap.get(iso);
      showTip(`<div class="tt-name">${dfl.format(p.date)}</div><dl class="tt-series"><dt>Your mix</dt><dd><b class="${cls(p.v)}">${pct(p.v)}</b></dd>
        ${bv != null ? `<dt>${esc(data.benchmark.symbol)}</dt><dd>${pct(bv)}</dd>` : ""}</dl>`, e);
    });
    svg.querySelector(".hit").addEventListener("pointerleave", () => { xh.hidden = true; dot.hidden = true; hideTip(); });
  }

  function drawHoldings() {
    const hs = data.holdings || [];
    const maxShare = Math.max(1, ...hs.map((h) => Math.max(h.weight, h.risk_share)));
    const t = $("#rk-hold");
    t.tHead.innerHTML = `<tr><th>Holding</th><th class="num">Weight</th><th class="rkbar" title="Share of the money vs share of the portfolio's ups and downs (variance)">Money vs risk</th>
      <th class="num" title="Annualised volatility">Volatility</th><th class="num" title="Move when the index moves 1%">Beta</th>
      <th class="num" title="−1…1: how closely it follows the index">Corr. index</th><th class="num" title="−1…1: how closely it follows the rest of your portfolio. Low or negative = it diversifies.">Corr. rest</th>
      <th class="num">Max drawdown</th><th class="num">From peak</th><th class="num" title="Part of the holding exposed to currencies other than ${base()}">FX exposure</th></tr>`;
    t.tBodies[0].innerHTML = hs.map((h) => {
      const heavy = h.risk_share > h.weight * 1.5 && h.risk_share > 5;
      return `<tr>
      <td class="asset"><b>${esc(h.symbol || h.name)}</b><span class="pill">${esc(CLS[h.class] || h.class)}</span><div class="sub">${esc(h.name || "")}${h.flat ? " · no price history, carried flat" : h.history_from && h.history_from > data.start ? ` · data since ${fmtDate(h.history_from)}` : ""}</div></td>
      <td class="num">${h.weight.toFixed(1)}%</td>
      <td class="rkbar"><div class="rk2" title="${h.weight.toFixed(1)}% of the money, ${h.risk_share.toFixed(1)}% of the risk"><i class="w" style="width:${(h.weight / maxShare * 100).toFixed(1)}%"></i><i class="r ${heavy ? "hot" : ""}" style="width:${(Math.max(0, h.risk_share) / maxShare * 100).toFixed(1)}%"></i></div>
        <div class="sub">${h.risk_share.toFixed(1)}% of risk${heavy ? ` · <span class="warn-t">${(h.risk_share / Math.max(h.weight, 0.01)).toFixed(1)}× its weight</span>` : ""}</div></td>
      <td class="num">${pctAbs(h.vol, 0)}</td><td class="num">${num(h.beta)}</td>
      <td class="num">${num(h.corr_index)}</td><td class="num ${h.corr_rest != null && h.corr_rest < 0.3 ? "up" : ""}">${num(h.corr_rest)}</td>
      <td class="num down">${pct(h.max_dd, 0)}</td><td class="num ${cls(h.dd_now)}">${h.dd_now != null && h.dd_now > -0.0005 ? "at high" : pct(h.dd_now, 0)}</td>
      <td class="num">${Math.round((h.fx_share || 0) * 100)}%</td></tr>`;
    }).join("");
    const heavy = hs.filter((h) => h.risk_share > h.weight * 1.5 && h.risk_share > 5).sort((a, c) => c.risk_share - a.risk_share)[0];
    const div = hs.filter((h) => !h.flat && h.corr_rest != null && h.corr_rest < 0.3 && h.weight > 1).map((h) => h.symbol);
    $("#rk-insight").innerHTML = [
      heavy ? `<b>${esc(heavy.symbol)}</b> is ${heavy.weight.toFixed(1)}% of your money but ${heavy.risk_share.toFixed(0)}% of the portfolio's swings.` : "",
      div.length ? `Diversifying (correlation with the rest below 0.3): ${div.map(esc).join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  function drawCorr() {
    const c = data.corr, el = $("#rk-corr");
    if (!c || c.keys.length < 2) { el.innerHTML = `<p class="hint">Needs at least two holdings with price history.</p>`; return; }
    const col = (v) => {
      if (v == null) return "transparent";
      const a = Math.min(1, Math.abs(v));
      return v >= 0 ? `rgba(229,72,77,${(a * 0.85).toFixed(3)})` : `rgba(57,135,229,${(a * 0.85).toFixed(3)})`;
    };
    el.innerHTML = `<div class="corr" style="grid-template-columns: 90px repeat(${c.keys.length}, minmax(34px, 1fr))">
      <div></div>${c.keys.map((k) => `<div class="ch" title="${esc(k)}">${esc(k.replace(/\.[A-Z]+$/, "").replace(/-EUR|-USD/, ""))}</div>`).join("")}
      ${c.keys.map((k, i) => `<div class="rh">${esc(k)}</div>${c.m[i].map((v, j) => `<div class="cc" style="background:${i === j ? "var(--panel-2)" : col(v)}" title="${esc(k)} · ${esc(c.keys[j])}: ${v == null ? "not enough data" : v.toFixed(2)}">${i === j ? "" : v == null ? "" : v.toFixed(1)}</div>`).join("")}`).join("")}
    </div><p class="hint">1 = always move together, 0 = unrelated, −1 = opposite. Red cells add little diversification; blue ones offset each other.</p>`;
  }

  function drawConc() {
    const hs = (data.holdings || []).slice(0, 5), lk = data.lookthrough, b = base();
    const bar = (p) => `<div class="cbar"><i style="width:${Math.min(100, p).toFixed(1)}%"></i></div>`;
    $("#rk-conc").innerHTML = `
      <table class="grid"><thead><tr><th>Top holdings</th><th class="num">Weight</th><th></th></tr></thead><tbody>
      ${hs.map((h) => `<tr><td><b>${esc(h.symbol || h.name)}</b></td><td class="num">${h.weight.toFixed(1)}%</td><td style="width:40%">${bar(h.weight)}</td></tr>`).join("")}
      </tbody></table>
      ${lk ? `<table class="grid"><thead><tr><th>Top companies, looking inside funds</th><th class="num">Weight</th><th></th></tr></thead><tbody>
      ${lk.top.slice(0, 6).map((c) => `<tr><td><b>${esc(c.name)}</b><div class="sub">${c.direct ? "held directly" : ""}${c.direct && c.via.length ? " + " : ""}${c.via.length ? `via ${c.via.map(esc).join(", ")}` : ""}</div></td><td class="num">${c.pct.toFixed(1)}%</td><td style="width:40%">${bar(c.pct)}</td></tr>`).join("")}
      </tbody></table>` : ""}
      <p class="hint">Total ${fmtMoney(data.total, b)}. ${(data.concentration?.effective_n || 0) < 5 ? "Fewer than 5 effective holdings: one bad position moves the whole portfolio." : ""}</p>`;
  }

  // ---- stress test: user shocks, applied with each holding's beta and currency exposure
  const PRESETS = [
    { k: "corr", label: "Correction", v: { stocks: -10, crypto: -25, bonds: 0, gold: 0, fx: 0 } },
    { k: "bear", label: "Bear market", v: { stocks: -20, crypto: -50, bonds: 2, gold: 5, fx: 0 } },
    { k: "crash", label: "Crash", v: { stocks: -35, crypto: -70, bonds: 5, gold: 10, fx: -5 } },
    { k: "usd", label: "Weak dollar", v: { stocks: 0, crypto: 0, bonds: 0, gold: 0, fx: -10 } },
  ];
  const shocks = () => ({ ...PRESETS[1].v, ...(S().stress || {}) });
  function drawStress() {
    const sh = shocks(), b = base(), useBeta = S().use_beta ?? true;
    for (const k of Object.keys(sh)) { const el = $(`#rk-s-${k}`); if (el && document.activeElement !== el) el.value = sh[k]; }
    $("#rk-s-beta").checked = useBeta;
    $("#rk-s-fx-l").textContent = `Foreign currencies vs ${b} (%)`;
    const rows = (data.holdings || []).map((h) => {
      let mv = 0, how = "";
      if (h.class === "crypto") { mv = sh.crypto / 100; how = "crypto"; }
      else if (h.class === "bond") { mv = sh.bonds / 100; how = "bonds"; }
      else if (h.class === "gold") { mv = sh.gold / 100; how = "gold"; }
      else if (h.class === "equity") {
        const be = useBeta && h.beta != null ? Math.max(0, Math.min(3, h.beta)) : 1;
        mv = be * sh.stocks / 100; how = useBeta && h.beta != null ? `β ${h.beta.toFixed(2)} × stocks` : "stocks";
      }
      const fx = (h.fx_share || 0) * sh.fx / 100;
      const tot = (1 + mv) * (1 + fx) - 1;
      return { h, mv, fx, tot, pl: h.value * tot, how };
    });
    const pl = rows.reduce((a, r) => a + r.pl, 0);
    const worst = rows.slice().sort((a, c) => a.pl - c.pl).slice(0, 8);
    $("#rk-stress-out").innerHTML = `
      <div class="stress-res"><div><div class="k">Your portfolio</div><div class="big ${cls(pl)}">${fmtSigned(pl, b)}</div>
        <div class="sub ${cls(pl)}">${pct(pl / data.total)} · from ${fmtMoney(data.total, b)} to ${fmtMoney(data.total + pl, b)}</div></div>
        <p class="hint">Each stock or equity fund moves by its beta × the stock-market move${useBeta ? "" : " (beta off: all move with the market)"}, then by the currency move on the part not in ${b}. Shocks are applied together; real crises are messier.</p></div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>Holding</th><th>Driven by</th><th class="num">Asset move</th><th class="num">Currency</th><th class="num">Total</th><th class="num">${b}</th></tr></thead><tbody>
      ${worst.map((r) => `<tr><td><b>${esc(r.h.symbol || r.h.name)}</b> <span class="sub">${r.h.weight.toFixed(1)}%</span></td><td class="sub">${esc(r.how)}</td>
        <td class="num ${cls(r.mv)}">${pct(r.mv)}</td><td class="num ${cls(r.fx)}">${r.fx ? pct(r.fx) : "—"}</td><td class="num ${cls(r.tot)}">${pct(r.tot)}</td>
        <td class="num ${cls(r.pl)}">${fmtSigned(r.pl, b)}</td></tr>`).join("")}</tbody></table></div>`;
    $$("#rk-presets button").forEach((x) => {
      const p = PRESETS.find((q) => q.k === x.dataset.k);
      x.classList.toggle("active", p && Object.keys(p.v).every((k) => +p.v[k] === +sh[k]));
    });
  }

  function drawScenarios() {
    const b = base(), sc = data.scenarios || [];
    const name = (k) => { const h = (data.holdings || []).find((x) => x.key === k); return h?.symbol || h?.name || k; };
    $("#rk-scen").innerHTML = `<thead><tr><th>Crisis</th><th>Dates</th><th class="num">Your portfolio today</th><th class="num">${esc(data.benchmark?.symbol || "Index")}</th><th>Hit hardest</th><th></th></tr></thead><tbody>
      ${sc.map((s) => `<tr><td><b>${esc(s.label)}</b></td><td class="sub">${fmtDate(s.start)} → ${fmtDate(s.end)}</td>
        <td class="num ${cls(s.portfolio)}"><b>${pct(s.portfolio)}</b><div class="sub">${fmtSigned(s.loss, b)}</div></td>
        <td class="num ${cls(s.bench)}">${pct(s.bench)}</td>
        <td>${s.worst ? `${esc(name(s.worst.key))} <span class="${cls(s.worst.ret)}">${pct(s.worst.ret, 0)}</span>${s.worst.est ? ' <span class="sub">est.</span>' : ""}` : "—"}</td>
        <td class="sub">${s.estimated_weight > 0.5 ? `${s.estimated_weight.toFixed(0)}% of the portfolio estimated (bought or listed later: β × index, or BTC for crypto)` : ""}${s.missing.length ? ` · no data: ${s.missing.map(name).map(esc).join(", ")}` : ""}</td></tr>`).join("")}
      </tbody>`;
  }

  function drawEarnings() {
    const t = $("#rk-earn");
    if (!t) return;
    const items = earn?.items || [];
    $("#rk-earn-days").value = earnDays();
    if (!items.length) { t.innerHTML = `<tbody><tr><td class="hint">No stocks among your holdings (ETFs and crypto don't report earnings).</td></tr></tbody>`; badge(); return; }
    const dist = targets?.stopDistance ? targets.stopDistance() : {};
    const df = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
    t.innerHTML = `<thead><tr><th>Date</th><th>Stock</th><th class="num">EPS expected</th><th>Last reports (surprise)</th>
      <th class="num" title="Average size of the biggest close-to-close move on the report day or the next session, last 8 reports">Typical move</th>
      <th class="num" title="Distance from today's price to your stop (Sell targets)">Your stop</th><th></th></tr></thead><tbody>
      ${items.map((x) => {
        const soon = x.days != null && x.days >= 0 && x.days <= earnDays();
        const sd = dist[x.symbol];
        const risky = x.typical_move != null && sd != null && Math.abs(sd) <= x.typical_move * 1.2;
        return `<tr class="${soon ? "earn-soon" : ""}">
        <td>${x.next ? `<b>${df.format(new Date(x.next + "T00:00:00"))}</b>${x.next_to ? ` – ${df.format(new Date(x.next_to + "T00:00:00"))}` : ""}<div class="sub">${x.days === 0 ? "today" : x.days === 1 ? "tomorrow" : x.days < 0 ? "reported" : `in ${x.days} days`}${x.next_to ? " · estimated window" : ""}</div>` : '<span class="muted-t">not announced</span>'}</td>
        <td><b>${esc(x.symbol)}</b><div class="sub">${esc(x.name)}</div></td>
        <td class="num">${x.eps_est != null ? x.eps_est.toFixed(2) : "—"}</td>
        <td>${(x.history || []).map((h) => `<span class="pill ${h.surprise > 0 ? "ok-s" : h.surprise < 0 ? "bad-s" : ""}" title="${fmtDate(h.date)}: EPS ${h.eps ?? "—"} vs ${h.eps_est ?? "—"} expected">${h.surprise != null ? `${h.surprise > 0 ? "+" : ""}${h.surprise.toFixed(0)}%` : "—"}</span>`).join("") || "—"}</td>
        <td class="num" title="${esc((x.moves || []).map((m) => `${fmtDate(m.date)}: ${m.move > 0 ? "+" : ""}${m.move.toFixed(1)}%`).join("\n"))}">${x.typical_move != null ? `±${x.typical_move.toFixed(1)}%` : "—"}</td>
        <td class="num ${risky ? "warn-t" : ""}">${sd == null ? "—" : sd >= 0 ? '<span class="down">already hit</span>' : `${sd.toFixed(1)}%`}${risky && sd < 0 ? '<div class="sub warn-t">inside a typical earnings move</div>' : ""}</td>
        <td>${soon ? `<span class="st st-warn">Soon</span>` : ""}</td></tr>`;
      }).join("")}</tbody>`;
    badge();
  }

  // ------------------------------------------------------------------ events
  $("#rk-years").addEventListener("click", (e) => {
    const bt = e.target.closest("button"); if (!bt) return;
    save({ years: +bt.dataset.v }); load(false);
  });
  $("#rk-presets").addEventListener("click", (e) => {
    const bt = e.target.closest("button"); if (!bt) return;
    const p = PRESETS.find((q) => q.k === bt.dataset.k);
    if (p) { save({ stress: { ...p.v } }); if (data) drawStress(); }
  });
  for (const k of ["stocks", "crypto", "bonds", "gold", "fx"]) {
    $(`#rk-s-${k}`).addEventListener("input", (e) => {
      const v = e.target.value === "" ? 0 : +e.target.value;
      if (!isFinite(v) || v <= -100) return;
      save({ stress: { ...shocks(), [k]: v } }); if (data) drawStress();
    });
  }
  $("#rk-s-beta").addEventListener("change", (e) => { save({ use_beta: e.target.checked }); if (data) drawStress(); });
  $("#rk-earn-days").addEventListener("change", (e) => { const v = +e.target.value; if (v >= 1 && v <= 60) { save({ earn_days: v }); drawEarnings(); } });
  let rw = 0;
  new ResizeObserver(() => { const w = $("#rk-dd").clientWidth; if (w && w !== rw && data) { rw = w; drawUnderwater(); } }).observe($("#rk-dd"));

  function refresh(silent) {
    if (!state.port) return;
    if (!data || !silent || Date.now() - (data.as_of || 0) * 1000 > 10 * 60e3 || data.base !== base()) load(silent);
    else { draw(); drawEarnings(); }
  }
  return { refresh, badge, earnings: () => earn, loadEarnings };
};
