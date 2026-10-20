/* stonks-dash — portfolio sub-tabs: sell targets (static/targets.js), performance vs index, allocation targets, transactions ledger, sell/dividend dialog. */
window.StonksPortfolio = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtPct, fmtPP, fmtMoney, fmtSigned, fmtNum, fmtPrice, fmtDate, fmtHeld, cls,
    showTip, moveTip, hideTip, autoGroup, shownPositions, pView, attachSearch, openPosition, loadPortfolio,
    CURRENCIES, TYPE_LABEL, $, $$ } = ctx;

  const SUBS = ["holdings", "targets", "ranges", "risk", "ideas", "performance", "allocation", "exposure", "costs", "taxes", "ledger"];
  const ins = window.StonksInsights(ctx);
  const tgt = window.StonksTargets({ ...ctx, feeFor: ins.feeFor, openTx });
  const tele = window.StonksTelegram(ctx);
  const rk = window.StonksRisk({ ...ctx, targets: tgt });
  const rng = window.StonksRanges(ctx);
  const idea = window.StonksIdeas(ctx);
  let sub = "holdings";
  try { sub = localStorage.getItem("stonks.psub") || "holdings"; } catch {}
  if (!SUBS.includes(sub)) sub = "holdings";
  let perf = null, perfLoading = false, ledgerData = null;
  let range = "ALL";

  // ================================================================== sub navigation
  function showSub(name) {
    sub = name;
    try { localStorage.setItem("stonks.psub", name); } catch {}
    $$("#p-subnav [data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === name));
    SUBS.forEach((s) => { $(`#p-sub-${s}`).hidden = s !== name; });
    hideTip();
    refresh(false);
  }
  $("#p-subnav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sub]");
    if (b) showSub(b.dataset.sub);
  });
  function refresh(silent) {
    if (sub === "performance") loadPerf(silent);
    else if (sub === "allocation") drawAlloc();
    else if (sub === "ledger") loadLedger(silent);
    else if (sub === "targets") { tgt.refresh(silent); tele.refresh(); }
    else if (sub === "risk") rk.refresh(silent);
    else if (sub === "ranges") rng.refresh(silent);
    else if (sub === "ideas") idea.refresh(silent);
    else ins.refresh(sub, silent);
  }
  // called by app.js after every portfolio reload (buy/sell saved, currency switch, auto-refresh)
  function onPortfolio() {
    perf = sub === "performance" ? perf : null;
    ledgerData = sub === "ledger" ? ledgerData : null;
    refresh(true);
    tgt.badge();
    rk.badge();
  }

  // ================================================================== PERFORMANCE
  const benchSel = $("#perf-bench"), benchCustom = $("#perf-bench-custom");
  function syncBenchControl() {
    const cur = (state.settings.benchmark || "IWDA.AS").toUpperCase();
    const known = [...benchSel.options].some((o) => o.value === cur);
    benchSel.value = known ? cur : "__custom";
    benchCustom.hidden = known;
    if (!known) benchCustom.value = cur;
  }
  benchSel.addEventListener("change", () => {
    if (benchSel.value === "__custom") { benchCustom.hidden = false; benchCustom.focus(); return; }
    benchCustom.hidden = true;
    setBenchmark(benchSel.value);
  });
  benchCustom.addEventListener("change", () => benchCustom.value.trim() && setBenchmark(benchCustom.value.trim().toUpperCase()));
  async function setBenchmark(sym) {
    await saveSettings({ benchmark: sym });
    perf = null;
    $("#perf-chart").innerHTML = `<div class="loading">Loading ${esc(sym)} history…</div>`;
    loadPortfolio(true);
  }
  $("#perf-range").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    range = b.dataset.v;
    $$("#perf-range button").forEach((x) => x.classList.toggle("active", x === b));
    drawPerf();
  });

  async function loadPerf(silent) {
    syncBenchControl();
    if (perfLoading) return;
    if (!silent || !perf) $("#perf-chart").innerHTML = `<div class="loading">Loading price history…</div>`;
    perfLoading = true;
    try {
      perf = await api(`/api/performance?base=${base()}`);
      drawPerf();
    } catch (e) {
      $("#perf-chart").innerHTML = `<div class="empty">Could not load history: ${esc(e.message)}</div>`;
    } finally { perfLoading = false; }
  }

  function drawPerf() {
    if (!perf) return;
    const b = base();
    const s = perf.summary;
    const bench = perf.benchmark || {};
    if (!s) {
      $("#perf-kpis").innerHTML = "";
      $("#perf-chart").innerHTML = `<div class="empty">Add buys with a purchase date to compare against the index.</div>`;
      $("#perf-table tbody").innerHTML = "";
      return;
    }
    const years = (Date.now() - Date.parse(s.start)) / (365.25 * 864e5);
    const xirrNote = years < 1 ? "annualised over less than a year — swings a lot" : `since ${fmtDate(s.start)}`;
    const pctOf = (g) => (s.money_in ? (g / s.money_in) * 100 : null);
    const cards = [
      ["Your gain", `<span class="${cls(s.gain)}">${fmtSigned(s.gain, b)}</span>`, `${fmtPct(pctOf(s.gain))} of ${fmtMoney(s.money_in, b)} invested`],
      [`${esc(bench.symbol || "Index")}, same dates`, s.bench_gain == null ? "—" : `<span class="${cls(s.bench_gain)}">${fmtSigned(s.bench_gain, b)}</span>`,
        s.bench_gain == null ? "benchmark history unavailable" : `${fmtPct(pctOf(s.bench_gain))} · would be worth ${fmtMoney(s.bench_now, b)}`],
      ["Difference", s.alpha == null ? "—" : `<span class="${cls(s.alpha)}">${fmtSigned(s.alpha, b)}</span>`,
        s.alpha == null ? "" : s.alpha >= 0 ? "ahead of the index" : "behind the index"],
      ["Your annual return", s.xirr == null ? "—" : `<span class="${cls(s.xirr)}">${fmtPct(s.xirr * 100)}</span>`,
        s.bench_xirr == null ? xirrNote : `index ${fmtPct(s.bench_xirr * 100)} · ${xirrNote}`],
    ];
    $("#perf-kpis").innerHTML = cards.map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
    const notes = [];
    if (perf.missing_history?.length) notes.push(`No price history for ${perf.missing_history.join(", ")} — carried at cost.`);
    if (s.flat_lots?.length) notes.push(`${s.flat_lots.length} manual/unpriced lot(s) carried at cost.`);
    if (perf.fx_approx?.length) notes.push(`No FX history for ${perf.fx_approx.join(", ")}: today's rate used.`);
    const undated = (state.port?.positions || []).filter((p) => !p.bought_at).length;
    if (undated) notes.push(`${undated} buy(s) without a purchase date use the date they were entered.`);
    $("#perf-note").textContent = notes.join(" ");
    drawChart();
    drawPerfTable();
  }

  // ---- line chart: portfolio value, index shadow portfolio, net invested
  const SERIES = [
    { key: "value", label: "Your portfolio", cls: "s-port" },
    { key: "bench", label: "Index (same cash flows)", cls: "s-bench" },
    { key: "invested", label: "Net invested", cls: "s-inv" },
  ];
  function drawChart() {
    const el = $("#perf-chart");
    const b = base();
    const all = perf.dates.map((d, i) => ({ d: new Date(`${d}T00:00:00`), value: perf.value[i], bench: perf.bench[i] ?? null, invested: perf.invested[i] }));
    let from = all[0]?.d;
    const now = new Date();
    if (range === "6M") from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    if (range === "1Y") from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    if (range === "YTD") from = new Date(now.getFullYear(), 0, 1);
    const pts = all.filter((p) => p.d >= from);
    if (pts.length < 2) { el.innerHTML = `<div class="empty">Not enough history in this range yet.</div>`; return; }
    const series = SERIES.filter((s) => s.key !== "bench" || perf.bench.length);
    $("#perf-legend").innerHTML = series.map((s) => `<span class="lk ${s.cls}"><i></i>${s.label}</span>`).join("");

    const W = el.clientWidth || 800, H = 320, m = { t: 12, r: 16, b: 28, l: 64 };
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.d)).range([m.l, W - m.r]);
    const vals = pts.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v != null);
    let [lo, hi] = d3.extent(vals);
    if (lo > 0 && lo < hi * 0.35) lo = 0;
    const pad = (hi - lo) * 0.08 || 1;
    const y = d3.scaleLinear().domain([Math.max(lo - pad, lo >= 0 && lo - pad < 0 ? 0 : lo - pad), hi + pad]).nice(5).range([H - m.b, m.t]);
    const money = new Intl.NumberFormat(undefined, { style: "currency", currency: b, notation: "compact", maximumFractionDigits: 1 });
    const line = (k) => d3.line().defined((p) => p[k] != null).x((p) => x(p.d)).y((p) => y(p[k]))
      .curve(k === "invested" ? d3.curveStepAfter : d3.curveMonotoneX)(pts);
    const xt = x.ticks(Math.max(2, Math.floor(W / 110)));
    const yt = y.ticks(5);
    const dfmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
    el.innerHTML = `<svg class="lc" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Portfolio value versus index">
      <g class="grid">${yt.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="yaxis">${yt.map((t) => `<text x="${m.l - 8}" y="${y(t)}" dy="0.32em">${money.format(t)}</text>`).join("")}</g>
      <g class="xaxis">${xt.map((t) => `<text x="${x(t)}" y="${H - 8}">${dfmt.format(t)}</text>`).join("")}</g>
      ${series.slice().reverse().map((s) => `<path class="ln ${s.cls}" d="${line(s.key)}"/>`).join("")}
      <line class="xh" y1="${m.t}" y2="${H - m.b}" hidden/>
      ${series.map((s) => `<circle class="dot ${s.cls}" r="4" hidden/>`).join("")}
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
    </svg>`;
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), dots = [...svg.querySelectorAll(".dot")];
    const bis = d3.bisector((p) => p.d).center;
    const hit = svg.querySelector(".hit");
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const p = pts[bis(pts, x.invert(px))];
      const X = x(p.d);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.hidden = false;
      series.forEach((s, i) => {
        if (p[s.key] == null) { dots[i].hidden = true; return; }
        dots[i].setAttribute("cx", X); dots[i].setAttribute("cy", y(p[s.key])); dots[i].hidden = false;
      });
      const diff = p.bench != null ? p.value - p.bench : null;
      showTip(`<div class="tt-name">${esc(fmtDate(p.d.toISOString().slice(0, 10)))}</div>
        <dl class="tt-series">${series.map((s) => `<dt><span class="lk ${s.cls}"><i></i>${s.label}</span></dt><dd><b>${fmtMoney(p[s.key], b)}</b></dd>`).join("")}
        ${diff == null ? "" : `<dt>You vs index</dt><dd class="${cls(diff)}">${fmtSigned(diff, b)}</dd>`}</dl>`, e);
    });
    hit.addEventListener("pointerleave", () => { xh.hidden = true; dots.forEach((d) => (d.hidden = true)); hideTip(); });
  }

  function drawPerfTable() {
    const b = base();
    const rows = state.port ? shownPositions(state.port, { ...pView(), combine: true, group: "none" }) : [];
    const list = rows.filter((p) => p.ok).sort((a, c) => (c.vs_bench ?? -1e9) - (a.vs_bench ?? -1e9));
    const t = $("#perf-table");
    t.tHead.innerHTML = `<tr><th>Asset</th><th class="num">Held</th><th class="num">Your return</th><th class="num">Index, same dates</th><th class="num">Difference</th><th class="num">Value</th></tr>`;
    t.tBodies[0].innerHTML = list.map((p) => `<tr>
      <td class="asset"><b>${esc(p.symbol || "—")}</b>${p.lots ? `<span class="pill">${p.lots.length} lots</span>` : ""}<div class="sub">${esc(p.display_name)}</div></td>
      <td class="num">${p.bought_at ? fmtHeld(p.bought_at) : "—"}<div class="sub">${p.bought_at ? fmtDate(p.bought_at) : "date not set"}</div></td>
      <td class="num ${cls(p.pnl_pct)}">${fmtPct(p.pnl_pct)}</td>
      <td class="num ${cls(p.bench_ret)}">${p.bench_ret == null ? "—" : fmtPct(p.bench_ret)}</td>
      <td class="num ${cls(p.vs_bench)}"><b>${fmtPP(p.vs_bench)}</b></td>
      <td class="num">${fmtMoney(p.value, b)}</td></tr>`).join("")
      || `<tr><td colspan="6" class="hint">No priced positions.</td></tr>`;
  }

  // ================================================================== ALLOCATION
  // alloc settings: {dim, basis_pct: "value"|"cost", targets: {dim: {bucket: %}}, planned: {symbol: {name, currency}},
  //                  plan: {goal, monthly, per_month, goal_ccy}}
  const A = () => state.settings.alloc || {};
  const allocDim = () => A().dim || "group_name";
  const allocBasis = () => A().basis_pct || "value";
  const saveAlloc = (patch) => saveSettings({ alloc: { ...A(), ...patch } });
  const allTargets = () => {
    const t = A().targets || {};
    // tolerate an older flat shape {bucket: pct}
    return Object.values(t).some((v) => typeof v === "number") ? { [allocDim()]: t } : t;
  };
  const bucketOf = (p, dim) => (dim === "symbol" ? p.symbol || p.display_name || "?" : autoGroup(p, dim) || "Other");
  const planned = () => A().planned || {};
  const buyOnly = () => A().buy_only ?? true;

  function currentBuckets(dim, basis = allocBasis()) {
    const m = new Map();
    for (const p of state.port?.positions || []) {
      const v = basis === "cost" ? (p.cost ?? 0) : (p.value ?? p.cost ?? 0);
      const k = bucketOf(p, dim);
      const cur = m.get(k) || { value: 0, items: new Map(), accounts: new Map() };
      cur.value += v;
      const name = p.symbol || p.display_name;
      cur.items.set(name, (cur.items.get(name) || 0) + v);
      cur.accounts.set(p.account || "", (cur.accounts.get(p.account || "") || 0) + v);
      m.set(k, cur);
    }
    return m;
  }

  function saveTargets(dim, targets, plannedExtra = null) {
    const clean = Object.fromEntries(Object.entries(targets).filter(([, v]) => v != null && isFinite(v) && v > 0));
    saveAlloc({ dim, targets: { ...allTargets(), [dim]: clean }, planned: { ...planned(), ...(plannedExtra || {}) } });
  }
  const bucketCell = (k, cur) => `<b>${esc(k)}</b>${cur.has(k) ? "" : ' <span class="pill">not held</span>'}${!cur.has(k) && planned()[k]?.name ? `<div class="sub">${esc(planned()[k].name)}</div>` : ""}`;

  function drawAlloc() {
    if (!state.port) return;
    const b = base();
    const dim = allocDim();
    $("#alloc-dim").value = dim;
    $$("#alloc-basis button").forEach((x) => x.classList.toggle("active", x.dataset.v === allocBasis()));
    const basisLbl = allocBasis() === "cost" ? "Invested" : "Value";
    const targets = allTargets()[dim] || {};
    const cur = currentBuckets(dim);
    const total = [...cur.values()].reduce((a, x) => a + x.value, 0);
    const keys = [...new Set([...cur.keys(), ...Object.keys(targets)])]
      .sort((a, c) => (targets[c] || 0) - (targets[a] || 0) || (cur.get(c)?.value || 0) - (cur.get(a)?.value || 0));
    const sumT = Object.values(targets).reduce((a, v) => a + v, 0);
    const sumEl = $("#alloc-sum");
    sumEl.textContent = sumT ? `Targets add up to ${+sumT.toFixed(2)}%${Math.abs(sumT - 100) > 0.01 ? " — should be 100%" : " ✓"}` : "Set a target % for each bucket";
    sumEl.classList.toggle("warn-t", sumT > 0 && Math.abs(sumT - 100) > 0.01);
    const t = $("#alloc-table");
    t.tHead.innerHTML = `<tr><th>Bucket</th><th class="num">${basisLbl}</th><th class="num">Current</th><th class="num">Target</th><th class="num">Drift</th><th class="num">To reach target</th><th class="barcol">Current vs target</th></tr>`;
    $$("#alloc-mode button").forEach((x) => x.classList.toggle("active", (x.dataset.v === "buy") === buyOnly()));
    // buy only: the smallest total at which no targeted bucket is above its target, i.e. you only add money
    // (the most overweight bucket sets it); every other targeted bucket is topped up to its target % of that total
    const totalB = Math.max(total, ...keys.filter((k) => targets[k] > 0).map((k) => (cur.get(k)?.value || 0) / (targets[k] / 100)));
    let buyTotal = 0;
    const maxPct = Math.max(1, ...keys.map((k) => Math.max(total ? (cur.get(k)?.value || 0) / total * 100 : 0, targets[k] || 0)));
    t.tBodies[0].innerHTML = keys.map((k) => {
      const v = cur.get(k)?.value || 0;
      const pc = total ? (v / total) * 100 : 0;
      const tg = targets[k];
      const drift = tg == null ? null : pc - tg;
      const delta = tg == null ? null : buyOnly() ? Math.max(0, (tg / 100) * totalB - v) : (tg / 100) * total - v;
      if (delta > 0) buyTotal += delta;
      const severe = drift != null && Math.abs(drift) >= 5;
      const driftTxt = drift == null ? "—" : Math.abs(drift) < 0.05 ? "on target" : `${fmtPP(drift)} ${drift > 0 ? "over" : "under"}`;
      return `<tr data-k="${esc(k)}">
        <td>${bucketCell(k, cur)}</td>
        <td class="num">${fmtMoney(v, b)}</td>
        <td class="num">${pc.toFixed(1)}%</td>
        <td class="num"><input class="tgt" type="number" min="0" max="100" step="0.5" value="${tg ?? ""}" placeholder="—"> %</td>
        <td class="num ${severe ? "warn-t" : ""}" ${severe ? 'title="More than 5 pp away from target"' : ""}>${severe ? "⚠ " : ""}${driftTxt}</td>
        <td class="num">${delta == null ? "—" : Math.abs(delta) < 0.005 ? (buyOnly() && drift > 0.05 ? `<span class="sub" title="Above target: no new money here; the others catch up">hold</span>` : "on target") : `${delta > 0 ? "buy" : "sell"} ${fmtMoney(Math.abs(delta), b)}`}</td>
        <td class="barcol"><div class="abar"><span class="cur" style="width:${(pc / maxPct) * 100}%"></span>${tg != null ? `<i class="tgt-mark" style="left:${(tg / maxPct) * 100}%" title="target ${tg}%"></i>` : ""}</div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="7" class="hint">No positions yet.</td></tr>`;
    t.tFoot.innerHTML = keys.length ? `<tr><td>Total</td><td class="num">${fmtMoney(total, b)}</td><td class="num">100%</td><td class="num">${+sumT.toFixed(2)}%</td><td></td><td class="num" title="${buyOnly() ? "New money needed to reach every target without selling" : "Total to buy (sales would fund part of it)"}">${buyTotal > 0.005 ? `buy ${fmtMoney(buyTotal, b)}` : ""}</td><td></td></tr>` : "";
    drawPlan();
  }

  $("#alloc-dim").addEventListener("change", (e) => {
    saveAlloc({ dim: e.target.value });
    resetPick();
    drawAlloc();
  });
  $("#alloc-mode").addEventListener("click", (e) => {
    const x = e.target.closest("button"); if (!x) return;
    saveAlloc({ buy_only: x.dataset.v === "buy" });
    drawAlloc();
  });
  $("#alloc-basis").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    saveAlloc({ basis_pct: b.dataset.v });
    drawAlloc();
  });
  $("#alloc-table").addEventListener("change", (e) => {
    const inp = e.target.closest("input.tgt");
    if (!inp) return;
    const dim = allocDim();
    const targets = { ...(allTargets()[dim] || {}) };
    const k = inp.closest("tr").dataset.k;
    const v = inp.value === "" ? null : Math.max(0, Math.min(100, +inp.value));
    if (v == null || v === 0) delete targets[k]; else targets[k] = v;
    saveTargets(dim, targets);
    drawAlloc();
  });

  // ---- contribution plan: reach a goal of money invested at the target %, with as few orders as possible
  const P = () => A().plan || {};
  const planRate = () => {         // stored goal/monthly → current base currency
    const ccy = P().ccy || base();
    return ccy === base() ? 1 : (state.port?.fx?.[ccy] || 1);
  };
  function syncPlanInputs() {
    const r = planRate();
    const g = $("#plan-goal"), m = $("#plan-monthly");
    if (document.activeElement !== g) g.value = P().goal ? +(P().goal * r).toFixed(2) : "";
    if (document.activeElement !== m) m.value = P().monthly ? +(P().monthly * r).toFixed(2) : "";
    $$("#plan-k button").forEach((x) => x.classList.toggle("active", +x.dataset.v === (P().per_month || 1)));
    const pr = $("#proj-ret"), pv = $("#proj-vol"), pt = $("#proj-target");
    if (document.activeElement !== pr) pr.value = P().ret ?? "";
    if (document.activeElement !== pv) pv.value = P().vol ?? "";
    if (document.activeElement !== pt) pt.value = P().target ? +(P().target * r).toFixed(0) : "";
  }
  function savePlan(patch) {
    const r = planRate();
    const cur = { goal: P().goal ? P().goal * r : null, monthly: P().monthly ? P().monthly * r : null, per_month: P().per_month || 1,
      ret: P().ret ?? null, vol: P().vol ?? null, target: P().target ? P().target * r : null };
    saveAlloc({ plan: { ...cur, ...patch, ccy: base() } });
  }
  $("#plan-goal").addEventListener("change", (e) => { savePlan({ goal: +e.target.value || null }); drawPlan(); });
  $("#plan-monthly").addEventListener("change", (e) => { savePlan({ monthly: +e.target.value || null }); drawPlan(); });
  $("#proj-ret").addEventListener("change", (e) => { savePlan({ ret: e.target.value === "" ? null : +e.target.value }); drawMonthlyPlan(); });
  $("#proj-vol").addEventListener("change", (e) => { savePlan({ vol: e.target.value === "" ? null : +e.target.value }); drawMonthlyPlan(); });
  $("#proj-target").addEventListener("change", (e) => { savePlan({ target: +e.target.value || null }); drawMonthlyPlan(); });

  // volatility of the mix the plan builds (targets, by ticker) or of today's portfolio — from 3 years of prices
  const volCache = {};
  function autoVol(targets) {
    const dim = allocDim();
    let wts = {}, what = "your target mix";
    if (dim === "symbol" && Object.keys(targets).length) wts = { ...targets };
    else {
      what = "today's portfolio";
      for (const x of state.port?.positions || []) if (x.symbol && x.value && x.quote_type !== "MANUAL") wts[x.symbol] = (wts[x.symbol] || 0) + x.value;
    }
    const key = `${base()}|${JSON.stringify(Object.entries(wts).sort())}`;
    if (!Object.keys(wts).length) return { vol: null, what };
    const c = volCache[key];
    if (c === undefined) {
      volCache[key] = null;
      api("/api/risk/mix", { method: "POST", body: { weights: wts, base: base() } })
        .then((r) => { volCache[key] = { ...r, what }; if (sub === "allocation") drawMonthlyPlan(); })
        .catch(() => { volCache[key] = { vol: null, what }; });
      return { vol: null, what, loading: true };
    }
    return c || { vol: null, what, loading: true };
  }
  $("#plan-k").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    savePlan({ per_month: +b.dataset.v });
    drawPlan();
  });

  function drawPlan() {
    drawNextOrder();
    drawMonthlyPlan();
  }
  function drawNextOrder() {
    syncPlanInputs();
    const out = $("#plan-out");
    const b = base(), r = planRate();
    const dim = allocDim();
    const targets = allTargets()[dim] || {};
    const goal = (P().goal || 0) * r, monthly = (P().monthly || 0) * r, k = P().per_month || 1;
    const cur = currentBuckets(dim, "cost");
    const current = Object.fromEntries([...cur].map(([key, x]) => [key, x.value]));
    const investedNow = Object.values(current).reduce((a, v) => a + v, 0);
    if (!Object.keys(targets).length) { out.innerHTML = `<p class="hint">Set target % in the table above first.</p>`; return; }
    if (!goal || !monthly) {
      out.innerHTML = `<p class="hint">You have ${fmtMoney(investedNow, b)} invested. Enter a goal and how much you can add each month.</p>`;
      return;
    }
    const p = window.StonksPlanner.nextOrders({ current, targets, goal, monthly, perMonth: k });
    if (p.reached) { out.innerHTML = `<div class="callout">✓ You already have ${fmtMoney(investedNow, b)} invested — above your goal of ${fmtMoney(goal, b)}.</div>`; return; }
    if (p.error) { out.innerHTML = `<p class="hint">Set target % in the table above first.</p>`; return; }
    const acctOf = (bucket) => {
      const a = cur.get(bucket)?.accounts;
      return a && a.size ? [...a.entries()].sort((x, y) => y[1] - x[1])[0][0] : "";
    };
    const top = (bucket) => {
      const items = cur.get(bucket)?.items;
      return items && items.size ? [...items.entries()].sort((x, y) => y[1] - x[1])[0][0] : (planned()[bucket] ? bucket : null);
    };
    out.innerHTML = `<div class="callout plan-now"><b>Next order:</b>
      ${p.orders.map((o) => {
        const sym = top(o.bucket);
        const fee = ins.feeFor(acctOf(o.bucket), o.amount);
        return `<span class="next-order"><b>${esc(o.bucket)}</b>${sym && sym !== o.bucket ? ` <span class="sub">e.g. ${esc(sym)}</span>` : ""}
          <b>${fmtMoney(o.amount, b)}</b>${fee ? ` <span class="sub">fee ≈ ${fmtMoney(fee, b)}</span>` : ""}
          ${sym ? `<button class="btn ghost xs buy-now" data-sym="${esc(sym)}" data-amt="${o.amount}">Buy…</button>` : ""}</span>`;
      }).join(" · ")}</div>`;
  }
  // ---- monthly plan: the full schedule (same inputs as the next order)
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
  let shownMonths = 12;
  function drawMonthlyPlan() {
    const out = $("#mplan-out");
    const b = base(), r = planRate();
    const dim = allocDim();
    const targets = allTargets()[dim] || {};
    const goal = (P().goal || 0) * r, monthly = (P().monthly || 0) * r, k = P().per_month || 1;
    const cur = currentBuckets(dim, "cost");
    const current = Object.fromEntries([...cur].map(([key, x]) => [key, x.value]));
    if (!Object.keys(targets).length || !goal || !monthly) { out.innerHTML = `<p class="hint">Fill in the goal and monthly contribution above.</p>`; return; }
    const p = window.StonksPlanner.plan({ current, targets, goal, monthly, perMonth: k, start: new Date() });
    if (p.reached) { out.innerHTML = `<p class="hint">Goal already reached.</p>`; return; }
    if (p.error) { out.innerHTML = ""; return; }
    const acctOf = (bucket) => {
      const a = cur.get(bucket)?.accounts;
      return a && a.size ? [...a.entries()].sort((x, y) => y[1] - x[1])[0][0] : (state.port?.positions?.[0]?.account || "");
    };
    const top = (bucket) => {
      const items = cur.get(bucket)?.items;
      return items && items.size ? [...items.entries()].sort((x, y) => y[1] - x[1])[0][0] : null;
    };
    const fee = (bucket, amt) => ins.feeFor(acctOf(bucket), amt) || 0;
    const planFees = p.months.reduce((s, m) => s + m.orders.reduce((a, o) => a + fee(o.bucket, o.amount), 0), 0);
    const fed = Object.keys(targets).filter((x) => targets[x] > 0 && (p.final.find((f) => f.bucket === x)?.amount || 0) > (current[x] || 0) + 0.005);
    const naiveFees = p.months.reduce((s, m) => s + fed.reduce((a, x) => a + fee(x, m.amount / Math.max(fed.length, 1)), 0), 0);
    const years = p.months_needed / 12;
    const kpis = [
      ["Goal reached", monthFmt.format(p.goal_date), `${p.months_needed} months${years >= 2 ? ` (${years.toFixed(1)} years)` : ""} · ${fmtMoney(p.need, b)} to add`],
      ["Orders", `${p.orders}`, `${k === 1 ? "one a month" : `up to ${k} a month`} · splitting every month: ${p.naive_orders}`],
      ["Fees", planFees || naiveFees ? fmtMoney(planFees, b) : "—", planFees || naiveFees ? `vs ${fmtMoney(naiveFees, b)} splitting every month${p.truncated ? ` (first ${p.months.length} months)` : ""}` : "set fee rules per account in the Costs tab"],
      ["Off target at the goal", p.truncated ? "—" : `${p.final_drift.toFixed(1)} pp`, p.truncated ? "plan longer than 100 years" : "largest gap between final and target %"],
    ];
    // ---- projection at an assumed yearly return
    const ret = (P().ret ?? 6) / 100;
    const av = autoVol(targets);
    const volPct = P().vol ?? (av.vol != null ? +(av.vol * 100).toFixed(1) : 15);
    const vol = volPct / 100;
    $("#proj-vol").placeholder = av.vol != null ? `auto ${(av.vol * 100).toFixed(1)}` : av.loading ? "auto …" : "15";
    $("#proj-vol-hint").textContent = P().vol != null ? "your value" : av.vol != null
      ? `from 3 years of prices of ${av.what}${av.coverage != null && av.coverage < 0.999 ? ` (${Math.round(av.coverage * 100)}% of it has history)` : ""}`
      : av.loading ? "calculating…" : "no price history — using 15%";
    const startValue = (state.port?.positions || []).reduce((a, x) => a + (x.value ?? x.cost ?? 0), 0);
    const goalVal = P().target ? P().target * r : goal;
    const mc = window.StonksPlanner.monteCarlo({ months: p.months, startValue, startInvested: p.invested, annual: ret, vol, sims: 2000, target: goalVal });
    const proj = mc.pts;
    const end = proj.at(-1);
    const endLbl = p.truncated ? `after ${p.months.length} months` : `by ${monthFmt.format(new Date(end.date.getFullYear(), end.date.getMonth() - 1, 1))}`;
    const chance = mc.chanceAbove(goalVal);
    const pct = (x) => (x >= 0.995 ? ">99%" : x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
    kpis.splice(1, 0,
      [`Chance of ≥ ${fmtMoney(goalVal, b, true)} ${endLbl}`, `<span class="${chance >= 0.5 ? "up" : "warn-t"}">${pct(chance)}</span>`,
        `${pct(end.pLoss)} chance of ending below the ${fmtMoney(end.invested, b, true)} invested`],
      [`Projected value ${endLbl}`, fmtMoney(end.value, b), `median · 80% of paths: ${fmtMoney(end.p10, b, true)} – ${fmtMoney(end.p90, b, true)}`]);
    const yearly = proj.filter((x) => x.i > 0 && (x.i % 12 === 0 || x === end));
    let prevInv = proj[0].invested;
    const yearRows = yearly.map((x) => {
      const contributed = x.invested - prevInv;
      prevInv = x.invested;
      const gain = x.value - x.invested;
      const endOf = new Date(x.date.getFullYear(), x.date.getMonth() - 1, 1);   // after that month's contribution
      return `<tr><td>End of ${monthFmt.format(endOf)}${x.i % 12 === 0 ? ` <span class="sub">year ${x.i / 12}</span>` : ""}</td>
        <td class="num">${fmtMoney(contributed, b)}</td><td class="num">${fmtMoney(x.invested, b)}</td>
        <td class="num"><b>${fmtMoney(x.value, b)}</b></td>
        <td class="num ${cls(gain)}">${fmtSigned(gain, b)} <span class="sub">${fmtPct(x.invested ? (gain / x.invested) * 100 : null, 1)}</span></td>
        <td class="num sub">${fmtMoney(x.p10, b)} – ${fmtMoney(x.p90, b)}</td>
        <td class="num">${pct(1 - x.pLoss)}</td><td class="num">${pct(x.pGoal)}</td></tr>`;
    }).join("");
    const projHtml = `
      <div class="chart-card proj-card">
        <div class="chart-legend"><span class="lk s-port"><i></i>Median path</span>
          <span class="lk s-band"><i class="sq"></i>Half of the paths (25–75%)</span>
          <span class="lk s-band2"><i class="sq"></i>80% of the paths (10–90%)</span>
          <span class="lk s-inv"><i></i>Money invested</span>
          <span class="lk s-goal"><i></i>${fmtMoney(goalVal, b, true)}</span>
          <span class="hint">${mc.sims.toLocaleString()} simulations · ${(ret * 100).toFixed(1)}%/yr expected · ${(vol * 100).toFixed(1)}% volatility</span></div>
        <div id="proj-chart" class="chart"></div>
      </div>
      <h3 class="sub-h">Projection by year</h3>
      <div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th class="num">Added in the period</th><th class="num">Money invested</th>
        <th class="num">Median value</th><th class="num">Median gain</th><th class="num">80% of paths</th>
        <th class="num" title="Share of simulated paths worth more than the money invested at that date">Above invested</th>
        <th class="num" title="Share of simulated paths at or above the value you want to reach">≥ ${fmtMoney(goalVal, b, true)}</th></tr></thead><tbody>${yearRows}</tbody></table></div>`;

    // ---- projected allocation: money invested in each bucket over time, as % of the total
    const order = Object.keys(targets).filter((x) => targets[x] > 0).sort((x, y) => targets[y] - targets[x]);
    const others = Object.keys(current).filter((x) => !order.includes(x) && current[x] > 0);
    const series = order.length > 7 ? [...order.slice(0, 7), "__other__"] : [...order, ...(others.length ? ["__other__"] : [])];
    const lbl = (k) => (k === "__other__" ? "Other" : k);
    const groupOf = (k) => (series.includes(k) ? k : "__other__");
    const snap = (c, i, date) => {
      const tot = Object.values(c).reduce((a, v) => a + v, 0);
      const by = {};
      for (const [k, v] of Object.entries(c)) by[groupOf(k)] = (by[groupOf(k)] || 0) + v;
      return { i, date, total: tot, by, raw: { ...c } };
    };
    const cAcc = { ...current };
    const allocPts = [snap(cAcc, 0, new Date(new Date().getFullYear(), new Date().getMonth(), 1))];
    p.months.forEach((m, i) => {
      m.orders.forEach((o) => { cAcc[o.bucket] = (cAcc[o.bucket] || 0) + o.amount; });
      allocPts.push(snap(cAcc, i + 1, new Date(m.date.getFullYear(), m.date.getMonth() + 1, 1)));
    });
    // table columns: now, end of each year (sampled to ≤ 8), goal
    const yearPts = allocPts.filter((x) => x.i > 0 && x.i % 12 === 0 && x !== allocPts.at(-1));
    const step = Math.max(1, Math.ceil(yearPts.length / 7));
    const cols = [allocPts[0], ...yearPts.filter((_, j) => (j + 1) % step === 0), allocPts.at(-1)];
    const colLbl = (x) => (x.i === 0 ? "Now" : x === allocPts.at(-1) ? (p.truncated ? `Month ${x.i}` : "At goal") : `Year ${x.i / 12}`);
    const allBuckets = [...order, ...others];
    const allocTable = `<div class="table-wrap"><table class="grid alloc-proj"><thead><tr><th>Bucket</th><th class="num">Target</th>${cols.map((x) => `<th class="num">${colLbl(x)}<div class="sub">${monthFmt.format(new Date(x.date.getFullYear(), x.date.getMonth() - (x.i ? 1 : 0), 1))}</div></th>`).join("")}</tr></thead>
      <tbody>${allBuckets.map((k) => `<tr><td><b>${esc(k)}</b></td><td class="num">${targets[k] ? (targets[k] / Object.values(targets).reduce((a, v) => a + v, 0) * 100).toFixed(1) + "%" : "—"}</td>
        ${cols.map((x) => { const v = x.raw[k] || 0; const pc = x.total ? (v / x.total) * 100 : 0; return `<td class="num">${pc.toFixed(1)}%<div class="sub">${fmtMoney(v, b)}</div></td>`; }).join("")}</tr>`).join("")}</tbody>
      <tfoot><tr><td>Total invested</td><td></td>${cols.map((x) => `<td class="num">${fmtMoney(x.total, b)}</td>`).join("")}</tr></tfoot></table></div>`;
    const allocHtml = `
      <h3 class="sub-h">Projected allocation</h3>
      <div class="chart-card proj-card">
        <div class="toolbar tight"><div class="chart-legend" id="alloc-legend"></div><div class="grow"></div>
          <div class="seg" id="alloc-proj-unit"><button data-v="pct" class="${allocUnit === "pct" ? "active" : ""}">%</button><button data-v="eur" class="${allocUnit === "eur" ? "active" : ""}">${esc(b)}</button></div></div>
        <div id="alloc-chart" class="chart"></div>
      </div>
      ${allocTable}`;

    const rows = p.months.slice(0, shownMonths);
    const orderTxt = (o) => `<b>${esc(o.bucket)}</b>${top(o.bucket) && top(o.bucket) !== o.bucket ? ` <span class="sub">e.g. ${esc(top(o.bucket))}</span>` : ""} ${fmtMoney(o.amount, b)}`;
    out.innerHTML = `
      <div class="kpis small">${kpis.map(([kk, v, d]) => `<div class="kpi"><div class="k">${kk}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("")}</div>
      ${p.overweight.length ? `<p class="hint">Already above their share of the goal, so they get no new money: ${p.overweight.map(esc).join(", ")}.</p>` : ""}
      ${projHtml}
      ${allocHtml}
      <div class="cost-cols">
        <div><h3 class="sub-h">Month by month</h3>
          <div class="table-wrap"><table class="grid"><thead><tr><th>Month</th><th>Buy</th><th class="num">Invested after</th><th class="num">Off target</th></tr></thead>
          <tbody>${rows.map((m) => `<tr class="${m.index === 0 ? "now" : ""}"><td>${monthFmt.format(m.date)}</td><td>${m.orders.map(orderTxt).join("<br>")}</td>
            <td class="num">${fmtMoney(m.invested, b)}</td><td class="num">${m.drift.toFixed(1)} pp</td></tr>`).join("")}</tbody></table></div>
          <div class="row plan-more">
            ${p.months.length > shownMonths ? `<button class="btn ghost xs" data-more="12">Show ${Math.min(12, p.months.length - shownMonths)} more</button><button class="btn ghost xs" data-more="all">Show all ${p.months.length}</button>` : ""}
            ${shownMonths > 12 ? `<button class="btn ghost xs" data-more="reset">Show first 12</button>` : ""}
            ${p.truncated ? `<span class="hint">Showing the first ${p.months.length} of ${p.months_needed} months.</span>` : ""}
          </div>
        </div>
        <div><h3 class="sub-h">${p.truncated ? `After ${p.months.length} months` : "At the goal"}</h3>
          <div class="table-wrap"><table class="grid"><thead><tr><th>Bucket</th><th class="num">Invested</th><th class="num">Share</th><th class="num">Target</th><th class="num">Diff</th></tr></thead>
          <tbody>${p.final.slice().sort((x, y) => y.target - x.target || y.amount - x.amount).map((f) => `<tr><td><b>${esc(f.bucket)}</b></td><td class="num">${fmtMoney(f.amount, b)}</td>
            <td class="num">${f.pct.toFixed(1)}%</td><td class="num">${f.target ? f.target.toFixed(1) + "%" : "—"}</td>
            <td class="num ${Math.abs(f.pct - f.target) >= 2 ? "warn-t" : ""}">${fmtPP(f.pct - f.target)}</td></tr>`).join("")}</tbody></table></div>
        </div>
      </div>`;
    drawProjection(proj, true, goalVal);
    lastAlloc = { pts: allocPts, series, lbl, targets };
    drawAllocChart();
  }

  // stacked area: invested per bucket over time (share of total, or money)
  const CAT = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#8b92a1"];
  let allocUnit = "pct", lastAlloc = null;
  $("#mplan-out").addEventListener("click", (e) => {
    const bt = e.target.closest("#alloc-proj-unit button"); if (!bt) return;
    allocUnit = bt.dataset.v;
    $$("#alloc-proj-unit button").forEach((x) => x.classList.toggle("active", x === bt));
    drawAllocChart();
  });
  function drawAllocChart() {
    const el = $("#alloc-chart");
    if (!el || !lastAlloc) return;
    const { pts, series, lbl } = lastAlloc;
    const b = base();
    const color = (k, i) => (k === "__other__" ? CAT[7] : CAT[i % 7]);
    $("#alloc-legend").innerHTML = series.map((k, i) => `<span class="lk"><i class="sq" style="background:${color(k, i)}"></i>${esc(lbl(k))}</span>`).join("");
    const pct = allocUnit === "pct";
    const rows = pts.map((x) => {
      const r = { date: x.date, i: x.i, total: x.total };
      series.forEach((k) => { const v = x.by[k] || 0; r[k] = pct ? (x.total ? (v / x.total) * 100 : 0) : v; });
      return r;
    });
    const stack = d3.stack().keys(series)(rows);
    const W = el.clientWidth || 800, H = 300, m = { t: 12, r: 16, b: 28, l: 70 };
    const x = d3.scaleTime().domain(d3.extent(rows, (r) => r.date)).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, pct ? 100 : d3.max(rows, (r) => r.total) * 1.05]).nice(5).range([H - m.b, m.t]);
    const area = d3.area().x((d) => x(d.data.date)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveStepAfter);
    const span = (rows.at(-1).date - rows[0].date) / (365.25 * 864e5);
    const xt = span > 3 ? x.ticks(d3.timeYear.every(Math.max(1, Math.ceil(span / Math.max(2, Math.floor(W / 90)))))) : x.ticks(Math.max(2, Math.floor(W / 110)));
    const dfmt = new Intl.DateTimeFormat(undefined, span > 3 ? { year: "numeric" } : { month: "short", year: "2-digit" });
    const money = new Intl.NumberFormat(undefined, { style: "currency", currency: b, notation: "compact", maximumFractionDigits: 1 });
    const yt = y.ticks(5);
    el.innerHTML = `<svg class="lc" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Projected allocation over time">
      <g class="grid">${yt.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="yaxis">${yt.map((t) => `<text x="${m.l - 8}" y="${y(t)}" dy="0.32em">${pct ? t + "%" : money.format(t)}</text>`).join("")}</g>
      <g class="xaxis">${xt.map((t) => `<text x="${x(t)}" y="${H - 8}">${dfmt.format(t)}</text>`).join("")}</g>
      ${stack.map((s, i) => `<path class="stk" d="${area(s)}" fill="${color(s.key, i)}"/>`).join("")}
      <line class="xh" y1="${m.t}" y2="${H - m.b}" hidden/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
    </svg>`;
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh");
    const bis = d3.bisector((r) => r.date).left;
    const fmtM = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
    svg.querySelector(".hit").addEventListener("pointermove", (e) => {
      const rc = svg.getBoundingClientRect();
      const d0 = x.invert(((e.clientX - rc.left) / rc.width) * W);
      const r = rows[Math.max(0, Math.min(rows.length - 1, bis(rows, d0) - 1))];
      const X = x(r.date);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.hidden = false;
      const src = pts[r.i];
      const endOf = new Date(r.date.getFullYear(), r.date.getMonth() - 1, 1);
      showTip(`<div class="tt-name">${r.i ? `End of ${fmtM.format(endOf)} · month ${r.i}` : "Today"} · ${fmtMoney(r.total, b)} invested</div>
        <dl class="tt-series">${series.slice().reverse().map((k) => { const v = src.by[k] || 0; const i = series.indexOf(k);
          return `<dt><span class="lk"><i class="sq" style="background:${color(k, i)}"></i>${esc(lbl(k))}</span></dt><dd><b>${(r.total ? (v / r.total) * 100 : 0).toFixed(1)}%</b> <span class="sub">${fmtMoney(v, b)}</span></dd>`; }).join("")}</dl>`, e);
    });
    svg.querySelector(".hit").addEventListener("pointerleave", () => { xh.hidden = true; hideTip(); });
  }

  function drawProjection(pts, withBand, goalVal = null) {
    const el = $("#proj-chart");
    if (!el || pts.length < 2) return;
    const b = base();
    const W = el.clientWidth || 800, H = 300, m = { t: 12, r: 16, b: 28, l: 70 };
    const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.date)).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, Math.max(d3.max(pts, (p) => Math.max(p.high, p.value, p.invested)), goalVal || 0) * 1.05]).nice(5).range([H - m.b, m.t]);
    const money = new Intl.NumberFormat(undefined, { style: "currency", currency: b, notation: "compact", maximumFractionDigits: 1 });
    const line = (k, curve = d3.curveMonotoneX) => d3.line().x((p) => x(p.date)).y((p) => y(p[k])).curve(curve)(pts);
    const area = d3.area().x((p) => x(p.date)).y0((p) => y(p.low)).y1((p) => y(p.high)).curve(d3.curveMonotoneX)(pts);
    const area2 = pts[0].p25 != null ? d3.area().x((p) => x(p.date)).y0((p) => y(p.p25)).y1((p) => y(p.p75)).curve(d3.curveMonotoneX)(pts) : null;
    const span = (pts.at(-1).date - pts[0].date) / (365.25 * 864e5);
    const yt = y.ticks(5);
    const xt = span > 3 ? x.ticks(d3.timeYear.every(Math.max(1, Math.ceil(span / Math.max(2, Math.floor(W / 90))))))
      : x.ticks(Math.max(2, Math.floor(W / 110)));
    const dfmt = new Intl.DateTimeFormat(undefined, span > 3 ? { year: "numeric" } : { month: "short", year: "2-digit" });
    el.innerHTML = `<svg class="lc" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Projected value versus money invested">
      <g class="grid">${yt.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="yaxis">${yt.map((t) => `<text x="${m.l - 8}" y="${y(t)}" dy="0.32em">${money.format(t)}</text>`).join("")}</g>
      <g class="xaxis">${xt.map((t) => `<text x="${x(t)}" y="${H - 8}">${dfmt.format(t)}</text>`).join("")}</g>
      ${withBand ? `<path class="band band2" d="${area}"/>` : ""}
      ${withBand && area2 ? `<path class="band" d="${area2}"/>` : ""}
      ${goalVal ? `<line class="goal-ln" x1="${m.l}" x2="${W - m.r}" y1="${y(goalVal)}" y2="${y(goalVal)}"/>` : ""}
      <path class="ln s-inv" d="${line("invested", d3.curveStepAfter)}"/>
      <path class="ln s-port" d="${line("value")}"/>
      <line class="xh" y1="${m.t}" y2="${H - m.b}" hidden/>
      <circle class="dot s-port" r="4" hidden/><circle class="dot s-inv" r="4" hidden/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
    </svg>`;
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh");
    const [dv, di] = svg.querySelectorAll(".dot");
    const bis = d3.bisector((p) => p.date).center;
    const fmtM = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
    svg.querySelector(".hit").addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const p = pts[bis(pts, x.invert(((e.clientX - r.left) / r.width) * W))];
      const X = x(p.date);
      xh.setAttribute("x1", X); xh.setAttribute("x2", X); xh.hidden = false;
      dv.setAttribute("cx", X); dv.setAttribute("cy", y(p.value)); dv.hidden = false;
      di.setAttribute("cx", X); di.setAttribute("cy", y(p.invested)); di.hidden = false;
      const gain = p.value - p.invested;
      const endOf = new Date(p.date.getFullYear(), p.date.getMonth() - 1, 1);
      showTip(`<div class="tt-name">${p.i ? `End of ${fmtM.format(endOf)} · month ${p.i}` : "Today"}</div>
        <dl class="tt-series"><dt><span class="lk s-port"><i></i>Median value</span></dt><dd><b>${fmtMoney(p.value, b)}</b></dd>
        <dt><span class="lk s-inv"><i></i>Money invested</span></dt><dd><b>${fmtMoney(p.invested, b)}</b></dd>
        <dt>Median gain</dt><dd class="${cls(gain)}">${fmtSigned(gain, b)} (${fmtPct(p.invested ? gain / p.invested * 100 : null, 1)})</dd>
        ${p.p25 != null ? `<dt>Half of the paths</dt><dd>${fmtMoney(p.p25, b)} – ${fmtMoney(p.p75, b)}</dd>` : ""}
        ${withBand ? `<dt>80% of the paths</dt><dd>${fmtMoney(p.low, b)} – ${fmtMoney(p.high, b)}</dd>` : ""}
        ${p.pLoss != null && p.i ? `<dt>Below invested</dt><dd>${Math.round(p.pLoss * 100)}% of paths</dd>` : ""}</dl>`, e);
    });
    svg.querySelector(".hit").addEventListener("pointerleave", () => { xh.hidden = true; dv.hidden = true; di.hidden = true; hideTip(); });
  }
  $("#mplan-out").addEventListener("click", (e) => {
    const bt = e.target.closest("[data-more]"); if (!bt) return;
    const v = bt.dataset.more;
    shownMonths = v === "all" ? Infinity : v === "reset" ? 12 : shownMonths + 12;
    drawMonthlyPlan();
  });

  $("#plan-out").addEventListener("click", async (e) => {
    const bt = e.target.closest(".buy-now"); if (!bt) return;
    const sym = bt.dataset.sym, amt = +bt.dataset.amt;
    const held = (state.port?.positions || []).find((p) => p.symbol === sym);
    let price = held?.price, ccy = held?.price_currency;
    let rate = held && held.value && held.quantity ? held.value / (held.quantity * held.price) : null;
    if (!price) {
      try { const q = await api(`/api/quote/${encodeURIComponent(sym)}`); price = q.price; ccy = q.currency; } catch {}
    }
    if (rate == null) rate = (ccy && ccy !== base()) ? (state.port?.fx?.[ccy] || null) : 1;
    const qty = price && rate ? amt / (price * rate) : null;
    openPosition(null, { symbol: sym, quantity: qty ? +qty.toFixed(4) : null, avg_cost: price ? +price.toFixed(4) : null,
      currency: ccy, account: held?.account, group_name: held?.group_name });
    $("#pos-form").account.dispatchEvent(new Event("input"));   // prefill the fee from the account's rule
  });

  // ---- add a target for a real ticker (looked up on Yahoo), or a free label for your own groups/accounts
  const freeDims = ["group_name", "account"];
  let pick = null;   // {symbol, name, quote, bucket}
  const hint = $("#alloc-new-hint");
  function resetPick() {
    pick = null;
    hint.textContent = "";
    const free = freeDims.includes(allocDim());
    $("#alloc-new-label").textContent = free
      ? "Add a bucket — a label of your own, or search a real ticker to target it on its own"
      : "Add an asset you don't hold yet";
  }
  function bucketFor(q, dim) {
    if (dim === "type") return TYPE_LABEL[q.quote_type] || q.quote_type || "Other";
    if (dim === "sector") return q.sector || (q.quote_type === "EQUITY" ? "Other" : TYPE_LABEL[q.quote_type] || "Other");
    return q.symbol;
  }
  attachSearch($("#alloc-new-name"), async (it) => {
    hint.textContent = "Looking up…";
    try {
      const q = await api(`/api/quote/${encodeURIComponent(it.symbol)}`);
      if (!q.ok) { pick = null; hint.innerHTML = `<span class="down">No price data for ${esc(it.symbol)} — pick another listing.</span>`; return; }
      const dim = allocDim();
      const switching = freeDims.includes(dim);
      pick = { symbol: q.symbol, name: q.name || it.name, quote: q, bucket: bucketFor(q, switching ? "symbol" : dim), switching };
      hint.innerHTML = `<b>${esc(q.symbol)}</b> · ${esc(pick.name)} · ${fmtPrice(q.price, q.currency)} <span class="${cls(q.changes?.["1D"])}">${fmtPct(q.changes?.["1D"])}</span>`
        + (dim === "symbol" || switching ? "" : ` → counts toward the <b>${esc(pick.bucket)}</b> bucket`)
        + (switching ? ` · <span class="warn-t">targets for single assets live under “Allocate by: Each asset” — it will switch there</span>` : "");
    } catch (e) { pick = null; hint.textContent = e.message; }
  });
  $("#alloc-new-name").addEventListener("input", () => { if (pick) { pick = null; hint.textContent = ""; } });
  $("#alloc-new-btn").addEventListener("click", () => {
    const text = $("#alloc-new-name").value.trim(), pct = +$("#alloc-new-pct").value;
    if (!(pct > 0)) { hint.innerHTML = '<span class="down">Enter a target %.</span>'; return; }
    let dim = allocDim(), bucket, extra = null;
    if (pick) {
      if (pick.switching) dim = "symbol";
      bucket = pick.bucket;
      extra = { [pick.symbol]: { name: pick.name, currency: pick.quote.currency } };
    } else if (freeDims.includes(dim) && text) {
      bucket = text;
    } else {
      hint.innerHTML = '<span class="down">Pick a real ticker from the suggestions.</span>';
      return;
    }
    saveTargets(dim, { ...(allTargets()[dim] || {}), [bucket]: pct }, extra);
    $("#alloc-new-name").value = ""; $("#alloc-new-pct").value = "";
    resetPick();
    drawAlloc();
  });
  resetPick();

  // ================================================================== LEDGER
  async function loadLedger(silent) {
    if (!silent || !ledgerData) $("#led-table tbody").innerHTML = `<tr><td class="hint">Loading…</td></tr>`;
    try {
      ledgerData = await api(`/api/ledger?base=${base()}`);
      drawLedger();
    } catch (e) {
      $("#led-table tbody").innerHTML = `<tr><td class="down">${esc(e.message)}</td></tr>`;
    }
  }
  function drawLedger() {
    const d = ledgerData;
    if (!d) return;
    const b = base();
    // yearly realized summary
    const yt = $("#years-table");
    const years = Object.entries(d.years);
    yt.tHead.innerHTML = `<tr><th>Year</th><th class="num">Sales</th><th class="num">Gains</th><th class="num">Losses</th><th class="num">Net realized</th>
      <th class="num">Dividends gross</th><th class="num">Withheld</th><th class="num">Dividends net</th><th class="num">Fees</th></tr>`;
    yt.tBodies[0].innerHTML = years.map(([y, r]) => `<tr><td><b>${y}</b></td><td class="num">${r.sells}</td>
      <td class="num ${r.gains ? "up" : ""}">${r.gains ? fmtSigned(r.gains, b) : "—"}</td><td class="num ${r.losses ? "down" : ""}">${r.losses ? fmtSigned(r.losses, b) : "—"}</td>
      <td class="num ${cls(r.net)}"><b>${fmtSigned(r.net, b)}</b></td>
      <td class="num">${r.div_gross ? fmtMoney(r.div_gross, b) : "—"}</td><td class="num">${r.div_withholding ? fmtMoney(r.div_withholding, b) : "—"}</td>
      <td class="num">${r.div_net ? fmtMoney(r.div_net, b) : "—"}</td><td class="num">${r.fees ? fmtMoney(r.fees, b) : "—"}</td></tr>`).join("")
      || `<tr><td colspan="9" class="hint">No sales or dividends recorded yet. Use <b>Sell</b> or <b>Dividend</b> above.</td></tr>`;

    // filters
    const ysel = $("#led-year");
    const allYears = [...new Set(d.events.map((e) => e.date.slice(0, 4)))].sort().reverse();
    const prev = ysel.value;
    ysel.innerHTML = `<option value="">All</option>` + allYears.map((y) => `<option>${y}</option>`).join("");
    ysel.value = allYears.includes(prev) ? prev : "";
    const fy = ysel.value, ft = $("#led-type").value;
    const rows = d.events.filter((e) => (!fy || e.date.startsWith(fy)) && (!ft || e.kind === ft));

    const t = $("#led-table");
    t.tHead.innerHTML = `<tr><th>Date</th><th>Type</th><th>Asset</th><th>Account</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Fees</th><th class="num">Amount</th><th class="num">Realized</th><th></th></tr>`;
    const pill = { BUY: "Buy", SELL: "Sell", DIVIDEND: "Dividend" };
    t.tBodies[0].innerHTML = rows.map((e) => {
      let qty = "", price = "", fees = "", realized = "", extra = "";
      if (e.kind === "BUY") {
        qty = fmtNum(e.quantity) + (e.remaining != null && Math.abs(e.remaining - e.quantity) > 1e-9 ? `<div class="sub">${fmtNum(e.remaining)} left</div>` : "");
        price = fmtPrice(e.price, e.currency);
        fees = e.fees ? fmtPrice(e.fees, e.currency) : "";
      } else if (e.kind === "SELL") {
        qty = fmtNum(e.quantity);
        price = fmtPrice(e.price, e.currency);
        fees = e.fees ? fmtPrice(e.fees, e.currency) : "";
        realized = e.gain == null ? "—" : `<b class="${cls(e.gain)}">${fmtSigned(e.gain, b)}</b>`;
        extra = e.lots?.length ? `<div class="sub">FIFO: ${e.lots.map((l) => `${fmtNum(l.qty)} from ${fmtDate(l.bought_at)}`).join(" · ")}</div>` : "";
      } else {
        price = "";
        extra = `<div class="sub">gross ${fmtPrice(e.gross_native, e.currency)}${e.withholding_native ? ` · withheld ${fmtPrice(e.withholding_native, e.currency)}` : ""}</div>`;
      }
      return `<tr data-kind="${e.kind}" data-id="${e.id}">
        <td>${fmtDate(e.date)}${e.kind === "BUY" && !e.date_known ? '<div class="sub" title="Set the purchase date by editing this buy">date not set</div>' : ""}</td>
        <td><span class="pill k-${e.kind.toLowerCase()}">${pill[e.kind]}</span></td>
        <td class="asset"><b>${esc(e.symbol || e.name || "—")}</b>${extra}</td>
        <td>${esc(e.account || "")}</td>
        <td class="num">${qty}</td><td class="num">${price}</td><td class="num">${fees}</td>
        <td class="num">${e.amount == null ? "—" : fmtMoney(e.amount, b)}</td>
        <td class="num">${realized}</td>
        <td><div class="row-actions"><button class="edit">Edit</button><button class="del">Delete</button></div></td></tr>`;
    }).join("") || `<tr><td colspan="10" class="hint">Nothing here.</td></tr>`;
    const notes = ["Amounts in " + b + " at each date's FX rate."];
    if (d.fx_approx?.length) notes.push(`No FX history for ${d.fx_approx.join(", ")}: today's rate used.`);
    notes.push("FIFO is applied per asset and account; Hacienda applies it across all your brokers for the same security — if you hold the same ISIN in two brokers, check the result.");
    $("#led-note").textContent = notes.join(" ");
  }
  $("#led-year").addEventListener("change", drawLedger);
  $("#led-type").addEventListener("change", drawLedger);
  $("#led-table").addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-kind]");
    if (!tr) return;
    const kind = tr.dataset.kind, id = +tr.dataset.id;
    if (e.target.closest(".edit")) {
      if (kind === "BUY") {
        const lots = await api("/api/positions");
        const lot = lots.find((x) => x.id === id);
        if (lot) openPosition(lot);
      } else {
        const tx = (await api("/api/transactions")).find((x) => x.id === id);
        if (tx) openTx(kind, tx);
      }
    }
    if (e.target.closest(".del") && confirm(`Delete this ${kind.toLowerCase()}?`)) {
      try {
        await api(kind === "BUY" ? `/api/positions/${id}` : `/api/transactions/${id}`, { method: "DELETE" });
      } catch (err) { alert(err.message); return; }
      loadPortfolio(true);
    }
  });

  // ================================================================== SELL / DIVIDEND dialog
  const dlg = $("#dlg-tx"), form = $("#tx-form");
  let txMode = "SELL", editing = null;
  form.currency.innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join("");
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const openLots = (sym, acct) => (state.port?.positions || []).filter((p) => p.symbol === sym && (acct == null || acct === "" || (p.account || "") === acct));
  function heldHint() {
    const sym = form.symbol.value.trim().toUpperCase(), acct = form.account.value.trim();
    const lots = openLots(sym, acct);
    const qty = lots.reduce((a, p) => a + p.quantity, 0);
    const box = $("#tx-held");
    if (!sym) { box.textContent = ""; return 0; }
    if (txMode === "SELL") {
      box.innerHTML = lots.length
        ? `You hold <b>${fmtNum(qty)}</b> ${esc(sym)}${acct ? ` in ${esc(acct)}` : " across all accounts"} (open lots, oldest sold first).`
        : `<span class="down">No open lots of ${esc(sym)}${acct ? ` in ${esc(acct)}` : ""}.</span>`;
    } else box.textContent = "";
    return qty;
  }
  function prefillFromHolding() {
    const sym = form.symbol.value.trim().toUpperCase();
    const p = openLots(sym, form.account.value.trim())[0] || openLots(sym)[0];
    if (!p) return;
    if (!form.account.value && p.account) form.account.value = p.account;
    const ccy = p.price_currency || p.currency;
    if (CURRENCIES.includes(ccy)) form.currency.value = ccy;
    if (txMode === "SELL" && !form.price.value && p.price) form.price.value = +p.price.toFixed(4);
  }
  attachSearch(form.symbol, () => { prefillFromHolding(); heldHint(); });
  form.symbol.addEventListener("change", () => { prefillFromHolding(); heldHint(); });
  form.account.addEventListener("input", heldHint);
  // prefill the fee from the account's rule until the user types one
  function autoFee(f, grossOf) {
    if (f.fees.dataset.manual === "1") return;
    const fee = ins.feeFor(f.account.value.trim(), grossOf());
    f.fees.value = fee == null ? "" : fee;
    f.fees.dataset.auto = fee == null ? "" : "1";
  }
  const txGross = () => (+form.quantity.value || 0) * (+form.price.value || 0);
  ["account", "quantity", "price"].forEach((k) => form[k].addEventListener("input", () => txMode === "SELL" && autoFee(form, txGross)));
  form.fees.addEventListener("input", () => { form.fees.dataset.manual = form.fees.value === "" ? "" : "1"; });
  const posF = $("#pos-form");
  const posGross = () => (+posF.quantity.value || 0) * (+posF.avg_cost.value || 0);
  ["account", "quantity", "avg_cost"].forEach((k) => posF[k].addEventListener("input", () => autoFee(posF, posGross)));
  posF.fees.addEventListener("input", () => { posF.fees.dataset.manual = posF.fees.value === "" ? "" : "1"; });
  $("#add-position").addEventListener("click", () => { posF.fees.dataset.manual = ""; });
  $("#tx-all").addEventListener("click", () => {
    const q = heldHint();
    if (q) form.quantity.value = +q.toFixed(10);
  });

  function openTx(mode, data = {}) {
    txMode = mode;
    editing = data.id ? data : null;
    form.reset();
    form.fees.dataset.manual = data.id && data.fees != null ? "1" : "";
    $("#tx-error").hidden = true;
    $("#tx-title").textContent = `${editing ? "Edit" : "Record a"} ${mode === "SELL" ? "sale" : "dividend"}`;
    $$("[data-mode]", dlg).forEach((el) => { el.hidden = el.dataset.mode !== mode; });
    $("#tx-delete").hidden = !editing;
    form.currency.value = base();
    form.date.max = iso(new Date());
    form.date.value = iso(new Date());
    for (const k of ["symbol", "account", "date", "quantity", "price", "fees", "amount", "withholding", "currency", "notes"]) {
      if (data[k] != null && form[k]) form[k].value = data[k];
    }
    $("#acct-list").innerHTML = [...new Set((state.port?.positions || []).map((x) => x.account).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("");
    if (!editing && data.symbol) prefillFromHolding();
    heldHint();
    dlg.showModal();
    (data.symbol ? (mode === "SELL" ? form.quantity : form.amount) : form.symbol).focus();
  }
  const num = (el) => (el.value.trim() === "" ? null : +el.value);
  $("#tx-save").addEventListener("click", async () => {
    const body = {
      type: txMode,
      symbol: form.symbol.value.trim().toUpperCase(),
      account: form.account.value.trim() || null,
      date: form.date.value,
      currency: form.currency.value,
      notes: form.notes.value.trim() || null,
    };
    if (txMode === "SELL") Object.assign(body, { quantity: num(form.quantity), price: num(form.price), fees: num(form.fees) });
    else Object.assign(body, { amount: num(form.amount), withholding: num(form.withholding) });
    const err = $("#tx-error");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!body.symbol || !body.date) return fail("Symbol and date are required.");
    if (txMode === "SELL" && !(body.quantity > 0 && body.price != null)) return fail("Enter the quantity sold and the price.");
    if (txMode === "DIVIDEND" && !(body.amount > 0)) return fail("Enter the gross dividend amount.");
    try {
      if (editing) { const { type, ...rest } = body; await api(`/api/transactions/${editing.id}`, { method: "PATCH", body: rest }); }
      else await api("/api/transactions", { method: "POST", body });
      dlg.close();
      ledgerData = null;
      loadPortfolio(true);
    } catch (e) { fail(e.message); }
  });
  $("#tx-delete").addEventListener("click", async () => {
    if (!editing || !confirm("Delete this transaction?")) return;
    await api(`/api/transactions/${editing.id}`, { method: "DELETE" });
    dlg.close();
    loadPortfolio(true);
  });
  $("#add-sell").addEventListener("click", () => openTx("SELL"));
  $("#add-div").addEventListener("click", () => openTx("DIVIDEND"));

  // redraw chart on resize
  let rw = 0;
  new ResizeObserver(() => {
    const w = $("#perf-chart").clientWidth;
    if (w && w !== rw && perf && sub === "performance") { rw = w; drawChart(); }
  }).observe($("#perf-chart"));

  // initial sub-tab
  $$("#p-subnav [data-sub]").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  SUBS.forEach((s) => { $(`#p-sub-${s}`).hidden = s !== sub; });

  return { openTx, onPortfolio, showSub };
};
