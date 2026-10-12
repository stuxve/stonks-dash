/* stonks-dash — Ideas: screens IBEX 35 (Spain) or large caps worldwide on value, quality, growth, momentum,
 * analysts, income (net of non-recoverable withholding for a Spanish resident), risk and FIT WITH YOUR PORTFOLIO
 * (sectors and regions you're missing, low correlation with what you hold, not already owned through funds).
 * Factor scores come from the server; the weighting happens here so presets and sliders are instant. */
window.StonksIdeas = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtPrice, fmtMoney, cls, showTip, moveTip, hideTip, openPosition, $, $$ } = ctx;

  const FACTORS = [
    ["fit", "Fit", "Fits your portfolio: adds sectors/regions you're underweight vs the world, moves little with what you hold, not already owned (directly or inside your funds)"],
    ["value", "Value", "Cheap vs its sector: P/E, P/B, EV/EBITDA"],
    ["quality", "Quality", "Return on equity, operating margin, low debt"],
    ["growth", "Growth", "Sales and earnings growth (last quarter, year on year)"],
    ["momentum", "Momentum", "12-month return excluding the last month, and closeness to the 52-week high"],
    ["analysts", "Analysts", "Upside to the consensus target and average recommendation (≥3 analysts)"],
    ["income", "Income", "Dividend yield after the withholding a Spanish resident can't recover; halved if the payout is above 100%"],
    ["risk", "Low risk", "Low volatility"],
  ];
  const PRESETS = {
    balanced: { label: "Balanced", w: { fit: 1.5, value: 1, quality: 1, growth: 1, momentum: 1, analysts: 1, income: 0.5, risk: 0.5 } },
    diversify: { label: "Diversify me", w: { fit: 3, value: 1, quality: 1, growth: 0.5, momentum: 0.5, analysts: 0.5, income: 0.5, risk: 1.5 } },
    value: { label: "Value", w: { fit: 1, value: 3, quality: 1.5, growth: 0.5, momentum: 0.5, analysts: 1, income: 1, risk: 0.5 } },
    quality: { label: "Quality", w: { fit: 1, value: 1, quality: 3, growth: 1, momentum: 1, analysts: 0.5, income: 0.5, risk: 1 } },
    growth: { label: "Growth", w: { fit: 1, value: 0.5, quality: 1, growth: 3, momentum: 1.5, analysts: 1, income: 0, risk: 0 } },
    income: { label: "Dividends", w: { fit: 1, value: 1, quality: 1.5, growth: 0.5, momentum: 0.5, analysts: 0.5, income: 3, risk: 1 } },
  };
  const S = () => state.settings.ideas || (state.settings.ideas = {});
  const save = (patch) => saveSettings({ ideas: { ...S(), ...patch } });
  const uni = () => S().universe || "spain";
  const preset = () => S().preset || "balanced";
  const weights = () => ({ ...PRESETS.balanced.w, ...(preset() === "custom" ? S().weights || {} : PRESETS[preset()].w) });
  const data = {};
  let poll = null, showN = 15;

  const pct = (v, d = 0) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`);
  const heat = (v) => {
    if (v == null) return "transparent";
    const t = (v - 50) / 50;   // −1…1
    return t >= 0 ? `rgba(48, 204, 90, ${(0.12 + t * 0.55).toFixed(3)})` : `rgba(246, 53, 56, ${(0.12 - t * 0.5).toFixed(3)})`;
  };

  function composite(r, w) {
    let s = 0, ws = 0;
    for (const [k] of FACTORS) {
      const v = r.f[k], wk = w[k] || 0;
      if (v == null || !wk) continue;
      s += v * wk; ws += wk;
    }
    return ws ? (s / ws) * (0.85 + 0.15 * r.coverage) : null;
  }

  async function load(silent) {
    const u = uni();
    if (!silent || !data[u]) $("#id-table").innerHTML = `<tbody><tr><td class="hint">Screening ${u === "spain" ? "the IBEX 35" : "large caps worldwide"}…</td></tr></tbody>`;
    try {
      data[u] = await api(`/api/ideas?universe=${u}&base=${base()}`);
    } catch (e) { $("#id-table").innerHTML = `<tbody><tr><td class="hint">${esc(e.message)}</td></tr></tbody>`; return; }
    draw();
    clearTimeout(poll);
    if (data[u].progress?.pending) poll = setTimeout(() => load(true), 4000);   // fundamentals still arriving
  }

  function drawControls() {
    $$("#id-uni button").forEach((x) => x.classList.toggle("active", x.dataset.v === uni()));
    if (!$("#id-preset").children.length) {
      $("#id-preset").innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button data-v="${k}">${p.label}</button>`).join("") + `<button data-v="custom">Custom</button>`;
    }
    $$("#id-preset button").forEach((x) => x.classList.toggle("active", x.dataset.v === preset()));
    const w = weights();
    $("#id-weights").hidden = preset() !== "custom";
    if (!$("#id-weights").children.length) {
      $("#id-weights").innerHTML = FACTORS.map(([k, label, tip]) => `<label class="field" title="${esc(tip)}">${label} <b></b>
        <input type="range" min="0" max="3" step="0.5" data-k="${k}"></label>`).join("");
    }
    $$("#id-weights input[data-k]").forEach((el) => {
      if (document.activeElement === el) return;           // don't fight a slider being dragged
      el.value = w[el.dataset.k] ?? 0;
      el.previousElementSibling.textContent = (+el.value).toFixed(1);
    });
    $("#id-hide-held").checked = S().hide_held ?? false;
    $("#id-custom").value = ((S().custom || {})[uni()] || []).join(", ");
    $("#id-custom-l").textContent = `Extra tickers for ${uni() === "spain" ? "Spain" : "World"}`;
  }

  function drawExposure(d) {
    const rowsS = Object.keys(d.ref_sectors).map((k) => [k, d.my_sectors[k] || 0, d.ref_sectors[k]]);
    const max = Math.max(...rowsS.map((r) => Math.max(r[1], r[2])), 1);
    const bar = ([k, mine, ref]) => {
      const gap = ref - mine;
      return `<div class="xr" title="${esc(k)}: you ${mine.toFixed(1)}% of your stocks · world ${ref.toFixed(1)}%"><span class="xl">${esc(k)}</span>
        <span class="xb"><i class="me" style="width:${(mine / max * 100).toFixed(1)}%"></i><i class="ref" style="left:${(ref / max * 100).toFixed(1)}%"></i></span>
        <span class="xv ${gap >= 3 ? "up" : gap <= -5 ? "warn-t" : ""}">${mine.toFixed(0)}% <span class="sub">/ ${ref.toFixed(0)}%</span></span></div>`;
    };
    const regs = Object.keys(d.ref_regions).map((k) => [k, d.my_regions[k] || 0, d.ref_regions[k]]);
    const maxR = Math.max(...regs.map((r) => Math.max(r[1], r[2])), 1);
    const barR = ([k, mine, ref]) => `<div class="xr"><span class="xl">${esc(k)}</span><span class="xb"><i class="me" style="width:${(mine / maxR * 100).toFixed(1)}%"></i><i class="ref" style="left:${(ref / maxR * 100).toFixed(1)}%"></i></span>
        <span class="xv ${ref - mine >= 4 ? "up" : ""}">${mine.toFixed(0)}% <span class="sub">/ ${ref.toFixed(0)}%</span></span></div>`;
    $("#id-exposure").innerHTML = `<div><h4>Your stocks by sector <span class="sub">(bar = you, tick = world)</span></h4>${rowsS.map(bar).join("")}</div>
      <div><h4>By region</h4>${regs.map(barR).join("")}<p class="hint">Look-through: funds are opened up into what they hold. Crypto, bonds and cash are left out. Sectors and regions where you're well below the world add to <b>Fit</b>.</p></div>`;
  }

  function draw() {
    drawControls();
    const d = data[uni()];
    if (!d) return;
    drawExposure(d);
    const p = d.progress || {};
    $("#id-progress").innerHTML = p.pending ? `<div class="prog"><i style="width:${(p.have / Math.max(p.total, 1) * 100).toFixed(0)}%"></i></div>
      <span class="hint">Fetching company data from Yahoo: ${p.have}/${p.total} (only the first time each day)…</span>` : "";
    const w = weights();
    const sector = $("#id-sector").value || "";
    const sectors = [...new Set(d.rows.map((r) => r.sector))].sort();
    $("#id-sector").innerHTML = `<option value="">All sectors</option>` + sectors.map((s) => `<option ${s === sector ? "selected" : ""}>${esc(s)}</option>`).join("");
    let rows = d.rows.map((r) => ({ ...r, score: composite(r, w) })).filter((r) => r.score != null);
    if (sector) rows = rows.filter((r) => r.sector === sector);
    if (S().hide_held) rows = rows.filter((r) => (r.held_pct || 0) < 0.5);
    rows.sort((a, c) => c.score - a.score);
    const shown = rows.slice(0, showN);
    const reasons = (r) => FACTORS.map(([k]) => [k, (r.f[k] ?? 0) * (w[k] || 0) / 100, r.why[k]])
      .filter((x) => x[2] && (r.f[x[0]] ?? 0) >= 60).sort((a, c) => c[1] - a[1]).slice(0, 3);
    const t = $("#id-table");
    t.innerHTML = `<thead><tr><th class="num">#</th><th>Stock</th><th class="num">Score</th>
      ${FACTORS.map(([k, l, tip]) => `<th class="fh" title="${esc(tip)} · weight ${(w[k] || 0).toFixed(1)}">${l}</th>`).join("")}
      <th class="num">Price</th><th class="num" title="Forward P/E (trailing if missing)">P/E</th><th class="num" title="Dividend yield after the withholding you can't recover as a Spanish resident">Net yield</th>
      <th class="num" title="Analyst consensus upside (number of analysts)">Upside</th><th>Why it ranks here</th><th></th></tr></thead>
      <tbody>${shown.map((r, i) => `<tr data-sym="${esc(r.symbol)}">
        <td class="num sub">${i + 1}</td>
        <td class="asset"><b>${esc(r.symbol)}</b>${r.held_pct >= 0.5 ? `<span class="pill" title="Already ${r.held_pct.toFixed(1)}% of your portfolio, directly or inside your funds">held ${r.held_pct.toFixed(1)}%</span>` : ""}
          <div class="sub">${esc(r.name)} · ${esc(r.sector)}${r.country ? ` · ${esc(r.country)}` : ""}</div></td>
        <td class="num"><div class="scb"><i style="width:${r.score.toFixed(0)}%"></i></div><b>${r.score.toFixed(0)}</b></td>
        ${FACTORS.map(([k, l]) => `<td class="fc" style="background:${heat(r.f[k])}" title="${esc(l)}: ${r.f[k] == null ? "no data" : r.f[k].toFixed(0) + "/100"}${r.why[k] ? ` — ${esc(r.why[k])}` : ""}">${r.f[k] == null ? "·" : r.f[k].toFixed(0)}</td>`).join("")}
        <td class="num">${fmtPrice(r.currency === "GBp" ? r.price / 100 : r.price, r.currency === "GBp" ? "GBP" : r.currency || "USD")}</td>
        <td class="num">${r.pe ? r.pe.toFixed(1) : "—"}</td>
        <td class="num">${r.net_yield ? (r.net_yield * 100).toFixed(1) + "%" : "—"}${r.div_yield && r.net_yield < r.div_yield - 0.0005 ? `<div class="sub">gross ${(r.div_yield * 100).toFixed(1)}%</div>` : ""}</td>
        <td class="num ${cls(r.upside)}">${r.upside != null ? pct(r.upside) : "—"}${r.n ? `<div class="sub">${r.n} an.</div>` : ""}</td>
        <td class="why">${reasons(r).map(([k, , txt]) => `<div><span class="wk">${FACTORS.find((f) => f[0] === k)[1]}</span> ${esc(txt)}</div>`).join("")}
          ${r.flags.length ? `<div class="flags">${r.flags.map((f) => `<span class="pill warn">${esc(f)}</span>`).join("")}</div>` : ""}</td>
        <td><div class="row-actions"><button class="buy" title="Record a buy of ${esc(r.symbol)}">Buy</button>
          <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.symbol)}" target="_blank" rel="noopener noreferrer" title="Open on Yahoo Finance">Yahoo ↗</a></div></td></tr>`).join("")}</tbody>`;
    $("#id-more").innerHTML = rows.length > showN ? `<button class="btn ghost xs" data-n="${showN + 15}">Show 15 more</button><button class="btn ghost xs" data-n="999">Show all ${rows.length}</button>`
      : showN > 15 ? `<button class="btn ghost xs" data-n="15">Show top 15</button>` : "";
    $("#id-note").textContent = `${rows.length} stocks scored · ${d.has_portfolio ? "fit uses your current holdings" : "add holdings to score fit"} · prices and momentum update live, company data daily`;
  }

  // ------------------------------------------------------------------ events
  $("#id-uni").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; save({ universe: b.dataset.v }); showN = 15; $("#id-sector").value = ""; data[b.dataset.v] ? draw() : load(false); });
  $("#id-preset").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.v === "custom" && preset() !== "custom") save({ preset: "custom", weights: weights() });
    else save({ preset: b.dataset.v });
    draw();
  });
  $("#id-weights").addEventListener("input", (e) => {
    const el = e.target.closest("input[data-k]"); if (!el) return;
    save({ weights: { ...weights(), [el.dataset.k]: +el.value } });
    el.previousElementSibling.textContent = (+el.value).toFixed(1);
    clearTimeout(drawT); drawT = setTimeout(draw, 120);
  });
  let drawT = null;
  $("#id-sector").addEventListener("change", () => { showN = 15; draw(); });
  $("#id-hide-held").addEventListener("change", (e) => { save({ hide_held: e.target.checked }); draw(); });
  $("#id-more").addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (!b) return; showN = +b.dataset.n; draw(); });
  $("#id-custom").addEventListener("change", (e) => {
    const list = e.target.value.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    save({ custom: { ...(S().custom || {}), [uni()]: list } }).then(() => load(false));
  });
  $("#id-table").addEventListener("click", (e) => {
    const b = e.target.closest(".buy"); if (!b) return;
    const sym = b.closest("tr").dataset.sym;
    const r = data[uni()]?.rows.find((x) => x.symbol === sym);
    const ccy = r?.currency === "GBp" ? "GBP" : r?.currency;
    const px = r?.price ? (r.currency === "GBp" ? r.price / 100 : r.price) : null;
    openPosition(null, { symbol: sym, currency: ccy, avg_cost: px ? +px.toFixed(4) : null });
  });

  function refresh(silent) {
    const d = data[uni()];
    if (!d || !silent || d.base !== base() || Date.now() - d.as_of * 1000 > 10 * 60e3) load(silent);
    else draw();
  }
  return { refresh };
};
