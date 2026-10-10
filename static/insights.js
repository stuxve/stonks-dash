/* stonks-dash — portfolio sub-tabs: look-through exposure, costs & fees, Spanish taxes. */
window.StonksInsights = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, base, fmtPct, fmtMoney, fmtSigned, fmtNum, fmtDate, cls,
    showTip, moveTip, hideTip, loadPortfolio, $, $$ } = ctx;

  const money = (v, ccy) => fmtMoney(v, ccy || base());
  const pct1 = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(1)}%`);
  const pct2 = (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(2)}%`);
  const kpi = (k, v, d = "") => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

  // ================================================================== EXPOSURE
  let expo = null, expoDim = "companies", showRest = true;
  async function loadExposure(silent) {
    if (!silent || !expo) $("#expo-bars").innerHTML = `<div class="loading">Opening up your funds…</div>`;
    try { expo = await api(`/api/exposure?base=${base()}`); drawExposure(); }
    catch (e) { $("#expo-bars").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  $("#expo-dim").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    expoDim = b.dataset.v;
    $$("#expo-dim button").forEach((x) => x.classList.toggle("active", x === b));
    drawExposure();
  });
  $("#expo-rest").addEventListener("change", (e) => { showRest = e.target.checked; drawExposure(); });

  function drawExposure() {
    const e = expo;
    if (!e) return;
    const b = base();
    $("#expo-rest-wrap").hidden = expoDim !== "companies";
    let rows = e[expoDim] || [];
    if (expoDim === "companies" && !showRest) rows = rows.filter((r) => !r.rest);
    const label = (r) => (expoDim === "companies" ? r.name : r.key);
    const top = rows.slice(0, 18);
    const max = Math.max(...top.map((r) => r.total), 1);
    $("#expo-bars").innerHTML = top.length ? top.map((r, i) => `
      <div class="xbar" data-i="${i}">
        <div class="xl">${esc(label(r))}${r.symbol && expoDim === "companies" ? ` <span class="sub">${esc(r.symbol)}</span>` : ""}${r.overlap ? ' <span class="pill warn">overlap</span>' : ""}</div>
        <div class="xt"><span class="seg-d" style="width:${(r.direct / max) * 100}%"></span><span class="seg-f" style="width:${(r.funds / max) * 100}%"></span></div>
        <div class="xv"><b>${pct1(r.pct)}</b> <span class="sub">${money(r.total, b)}</span></div>
      </div>`).join("") : `<div class="empty">No open positions.</div>`;
    $$("#expo-bars .xbar").forEach((el) => {
      const r = top[+el.dataset.i];
      const html = () => `<div class="tt-head"><span class="tt-sym">${esc(label(r))}</span><span class="tt-type">${pct1(r.pct)} of portfolio</span></div>
        <dl class="tt-series"><dt><span class="lk s-port"><i></i>Direct</span></dt><dd><b>${money(r.direct, b)}</b></dd>
        <dt><span class="lk s-bench"><i></i>Through funds</span></dt><dd><b>${money(r.funds, b)}</b></dd>
        ${(r.via || []).map((v) => `<dt class="sub">via ${esc(v.fund)}</dt><dd>${money(v.value, b)}</dd>`).join("")}</dl>`;
      el.addEventListener("mouseenter", (ev) => showTip(html(), ev));
      el.addEventListener("mousemove", moveTip);
      el.addEventListener("mouseleave", hideTip);
    });
    const funds = e.funds || [];
    const fundMoney = funds.reduce((a, f) => a + f.value, 0);
    const covered = funds.reduce((a, f) => a + f.value * (f.top_covered || 0), 0);
    const notes = [];
    if (funds.length) notes.push(`Published top holdings cover ${pct1(fundMoney ? (covered / fundMoney) * 100 : 0)} of your fund money; the rest of each fund appears as “Other holdings of …”.`);
    const proxied = funds.filter((f) => f.proxy);
    if (proxied.length) notes.push(`${proxied.map((f) => `${f.symbol} uses the composition of ${f.proxy}`).join(", ")} (same index; Yahoo publishes nothing for that listing).`);
    if (expoDim === "countries" || expoDim === "currencies") notes.push("Fund countries/currencies use approximate index weights (choose the profile per fund below). Hedged share classes count as their hedge currency.");
    $("#expo-note").textContent = notes.join(" ");

    // overlaps callout
    const ov = e.overlaps || [];
    $("#expo-overlap").innerHTML = ov.length ? `<b>Overlap:</b> ` + ov.map((r) => `${esc(r.name)} — ${money(r.direct, b)} direct + ${money(r.funds, b)} through ${r.via.map((v) => esc(v.fund)).join(", ")} = <b>${pct1(r.pct)}</b> of your portfolio`).join(" · ") : "";
    $("#expo-overlap").hidden = !ov.length;

    // full table
    const t = $("#expo-table");
    t.tHead.innerHTML = `<tr><th>${{ companies: "Company", sectors: "Sector", countries: "Country", currencies: "Currency" }[expoDim]}</th><th class="num">Direct</th><th class="num">Through funds</th><th class="num">Total</th><th class="num">Share</th>${expoDim === "companies" ? "<th>Via</th>" : ""}</tr>`;
    t.tBodies[0].innerHTML = rows.map((r) => `<tr><td>${esc(label(r))}${r.symbol && expoDim === "companies" ? ` <span class="sub">${esc(r.symbol)}</span>` : ""}</td>
      <td class="num">${r.direct ? money(r.direct, b) : "—"}</td><td class="num">${r.funds ? money(r.funds, b) : "—"}</td>
      <td class="num"><b>${money(r.total, b)}</b></td><td class="num">${pct2(r.pct)}</td>
      ${expoDim === "companies" ? `<td class="sub">${(r.via || []).map((v) => esc(v.fund)).join(", ")}</td>` : ""}</tr>`).join("");

    // funds and their profiles
    const ft = $("#expo-funds");
    const opts = Object.entries(e.profiles || {});
    ft.tHead.innerHTML = `<tr><th>Fund</th><th class="num">Value</th><th>Country profile</th><th>Currency</th><th class="num">Top holdings</th><th class="num">TER</th></tr>`;
    ft.tBodies[0].innerHTML = funds.map((f) => `<tr data-sym="${esc(f.symbol)}">
      <td><b>${esc(f.symbol)}</b><div class="sub">${esc(f.name)}</div></td>
      <td class="num">${money(f.value, b)}</td>
      <td><select class="prof">${opts.map(([k, l]) => `<option value="${k}" ${k === f.profile ? "selected" : ""}>${esc(l)}${k === f.auto_profile ? " (auto)" : ""}</option>`).join("")}</select></td>
      <td>${f.hedged_to ? `hedged to <b>${esc(f.hedged_to)}</b>` : '<span class="sub">unhedged</span>'}</td>
      <td class="num">${f.data ? `${f.n_holdings} · ${pct1((f.top_covered || 0) * 100)}${f.proxy ? `<div class="sub" title="Yahoo publishes no composition for ${esc(f.symbol)}; using ${esc(f.proxy)}, which tracks the same index">via proxy ${esc(f.proxy)}</div>` : ""}` : '<span class="sub" title="Yahoo has no composition for this fund and no proxy for its profile — pick a profile">no data</span>'}</td>
      <td class="num"><input class="ter" type="number" step="0.01" min="0" value="${f.ter != null ? +(f.ter * 100).toFixed(3) : ""}" placeholder="—" title="${f.ter_manual ? "Entered by you" : f.ter != null ? "From Yahoo" : "Not published — enter the fund's TER from its factsheet"}"> %</td></tr>`).join("") || `<tr><td colspan="6" class="hint">No funds or ETFs in the portfolio.</td></tr>`;
  }
  $("#expo-funds").addEventListener("change", async (e) => {
    const ter = e.target.closest("input.ter");
    if (ter) {
      const sym = ter.closest("tr").dataset.sym;
      const cur = { ...(state.settings.fund_ter || {}) };
      if (ter.value === "") delete cur[sym]; else cur[sym] = +ter.value;
      await saveSettings({ fund_ter: cur });
      costs = null;
      return loadExposure(true);
    }
    const sel = e.target.closest("select.prof"); if (!sel) return;
    const sym = sel.closest("tr").dataset.sym;
    const f = expo.funds.find((x) => x.symbol === sym);
    const cur = { ...(state.settings.fund_profiles || {}) };
    if (sel.value === f.auto_profile) delete cur[sym]; else cur[sym] = sel.value;
    await saveSettings({ fund_profiles: cur });
    loadExposure(true);
  });

  // ================================================================== COSTS
  let costs = null;
  async function loadCosts(silent) {
    if (!silent || !costs) $("#cost-kpis").innerHTML = `<div class="hint">Loading…</div>`;
    try { costs = await api(`/api/costs?base=${base()}`); drawCosts(); }
    catch (e) { $("#cost-kpis").innerHTML = `<div class="down">${esc(e.message)}</div>`; }
  }
  const ruleText = (r) => (!r ? "" : [r.fixed ? `€${r.fixed}` : "", r.pct ? `${r.pct}%` : "", r.min ? `min €${r.min}` : ""].filter(Boolean).join(" + "));
  function drawCosts() {
    const c = costs;
    if (!c) return;
    const b = base(), s = c.summary;
    $("#cost-kpis").innerHTML = [
      kpi("Fees paid", money(s.total_fees, b), `${s.pct_of_invested == null ? "" : pct2(s.pct_of_invested) + " of the money you invested"}`),
      kpi("This year", money(s.this_year, b), ""),
      kpi("Fees ÷ traded volume", s.avg_pct == null ? "—" : pct2(s.avg_pct), `${s.expensive} trade${s.expensive === 1 ? "" : "s"} paid more than 1% in fees`),
      kpi("Fund running costs", `${money(s.ongoing_per_year, b)}<span class="unit">/yr</span>`, s.weighted_ter == null ? "no fund TER data" : `weighted TER ${pct2(s.weighted_ter * 100)}`),
    ].join("");
    $("#cost-missing").hidden = !s.missing;
    $("#cost-missing").innerHTML = s.missing ? `⚠ <b>${s.missing}</b> trade${s.missing === 1 ? " has" : "s have"} no fee recorded, so the totals are too low. Set a fee rule for the account below and press <b>Fill missing</b>.` : "";

    const at = $("#cost-accounts");
    at.tHead.innerHTML = `<tr><th>Account</th><th class="num">Trades</th><th class="num">Volume</th><th class="num">Fees</th><th class="num">Avg</th><th class="num">No fee</th><th>Fee rule (prefills new trades)</th><th></th></tr>`;
    at.tBodies[0].innerHTML = c.by_account.map((a) => {
      const r = a.rule || {};
      return `<tr data-acct="${esc(a.key)}">
        <td><b>${esc(a.key || "(no account)")}</b></td><td class="num">${a.trades}</td><td class="num">${money(a.volume, b)}</td>
        <td class="num">${money(a.fees, b)}</td><td class="num ${a.avg_pct > 1 ? "warn-t" : ""}">${a.avg_pct == null ? "—" : pct2(a.avg_pct)}</td>
        <td class="num ${a.missing ? "warn-t" : ""}">${a.missing || "—"}</td>
        <td class="rule"><label>€ <input data-f="fixed" type="number" step="any" min="0" value="${r.fixed ?? ""}" placeholder="0"></label>
          <label>+ <input data-f="pct" type="number" step="any" min="0" value="${r.pct ?? ""}" placeholder="0"> %</label>
          <label>min € <input data-f="min" type="number" step="any" min="0" value="${r.min ?? ""}" placeholder="—"></label></td>
        <td><div class="row-actions"><button class="fill" ${a.missing ? "" : "disabled"} title="Apply the rule to trades without a fee">Fill missing</button></div></td></tr>`;
    }).join("") || `<tr><td colspan="8" class="hint">No trades yet.</td></tr>`;

    const tt = $("#cost-top");
    tt.tHead.innerHTML = `<tr><th>Date</th><th>Type</th><th>Asset</th><th>Account</th><th class="num">Amount</th><th class="num">Fee</th><th class="num">Fee %</th></tr>`;
    tt.tBodies[0].innerHTML = c.top.map((t) => `<tr><td>${fmtDate(t.date)}</td><td><span class="pill k-${t.kind.toLowerCase()}">${t.kind === "BUY" ? "Buy" : "Sell"}</span></td>
      <td><b>${esc(t.symbol || "—")}</b></td><td>${esc(t.account || "")}</td><td class="num">${money(t.amount, b)}</td>
      <td class="num">${money(t.fee, b)}</td><td class="num ${t.pct > 1 ? "warn-t" : ""}"><b>${pct2(t.pct)}</b></td></tr>`).join("")
      || `<tr><td colspan="7" class="hint">No fees recorded yet.</td></tr>`;

    const yt = $("#cost-years");
    yt.tHead.innerHTML = `<tr><th>Year</th><th class="num">Trades</th><th class="num">Volume</th><th class="num">Fees</th><th class="num">Avg</th></tr>`;
    yt.tBodies[0].innerHTML = c.by_year.map((y) => `<tr><td><b>${y.key}</b></td><td class="num">${y.trades}</td><td class="num">${money(y.volume, b)}</td><td class="num">${money(y.fees, b)}</td><td class="num">${y.avg_pct == null ? "—" : pct2(y.avg_pct)}</td></tr>`).join("");

    const ot = $("#cost-ongoing");
    ot.tHead.innerHTML = `<tr><th>Fund</th><th class="num">Value</th><th class="num">TER</th><th class="num">Cost per year</th></tr>`;
    ot.tBodies[0].innerHTML = c.ongoing.map((o) => `<tr><td><b>${esc(o.symbol)}</b><div class="sub">${esc(o.name)}</div></td><td class="num">${money(o.value, b)}</td>
      <td class="num">${o.ter ? pct2(o.ter * 100) : "—"}</td><td class="num">${o.per_year == null ? "—" : money(o.per_year, b)}</td></tr>`).join("")
      || `<tr><td colspan="4" class="hint">No funds or ETFs.</td></tr>`;
  }
  $("#cost-accounts").addEventListener("change", async (e) => {
    const inp = e.target.closest("input[data-f]"); if (!inp) return;
    const tr = inp.closest("tr"), acct = tr.dataset.acct;
    const rule = {};
    $$("input[data-f]", tr).forEach((i) => { if (i.value !== "") rule[i.dataset.f] = +i.value; });
    const rules = { ...(state.settings.account_fees || {}) };
    if (Object.keys(rule).length) rules[acct] = rule; else delete rules[acct];
    await saveSettings({ account_fees: rules });
    costs.by_account.find((a) => a.key === acct).rule = rules[acct];
  });
  $("#cost-accounts").addEventListener("click", async (e) => {
    const btn = e.target.closest(".fill"); if (!btn) return;
    const acct = btn.closest("tr").dataset.acct;
    const rule = (state.settings.account_fees || {})[acct];
    if (!rule) { alert("Set the fee rule for this account first."); return; }
    if (!confirm(`Fill the fee (${ruleText(rule)}) on every ${acct || "unassigned"} trade that has none?`)) return;
    try {
      const r = await api("/api/costs/fill", { method: "POST", body: { account: acct || null } });
      btn.textContent = `${r.updated} updated`;
      loadPortfolio(true);
    } catch (err) { alert(err.message); }
  });

  // ================================================================== TAXES (ES)
  let taxData = null, taxYear = null;
  async function loadTax(silent) {
    if (!silent || !taxData) $("#tax-kpis").innerHTML = `<div class="hint">Loading…</div>`;
    try {
      taxData = await api(`/api/tax${taxYear ? `?year=${taxYear}` : ""}`);
      drawTax();
    } catch (e) { $("#tax-kpis").innerHTML = `<div class="down">${esc(e.message)}</div>`; }
  }
  $("#tax-year").addEventListener("change", (e) => { taxYear = +e.target.value; loadTax(false); });
  const eur = (v) => fmtMoney(v, "EUR");
  const eurS = (v) => fmtSigned(v, "EUR");

  function drawTax() {
    const d = taxData;
    if (!d) return;
    const y = d.selected, isNow = d.year === +d.today.slice(0, 4);
    $("#tax-year").innerHTML = d.years.map((x) => `<option ${x.year === d.year ? "selected" : ""}>${x.year}</option>`).join("");
    const toPay = y.after_deductions; // tax minus the deductible withholding
    $("#tax-kpis").innerHTML = [
      kpi("Gains & losses (computable)", `<span class="${cls(y.gp)}">${eurS(y.gp)}</span>`,
        `${y.gains ? `gains ${eurS(y.gains)}` : "no gains"}${y.losses ? ` · losses ${eurS(y.losses)}` : ""}${y.blocked ? ` · <span class="warn-t">${eur(-y.blocked)} of loss deferred (2-month rule)</span>` : ""}${y.released ? ` · released ${eurS(y.released)}` : ""}`),
      kpi("Dividends (gross)", eur(y.rcm), y.withheld ? `withheld ${eur(y.withheld)}` : ""),
      kpi("Taxable savings base", eur(y.base), `average rate ${pct1(y.avg_rate * 100)}`),
      kpi(isNow ? "Estimated tax so far" : "Estimated tax", eur(toPay), y.dd_deduction ? `${eur(y.tax)} − ${eur(y.dd_deduction)} withheld at source` : "before any Spanish withholding you already had"),
    ].join("");
    // brackets & compensation
    const br = y.brackets.map((p) => `<tr><td>${eur(p.from)} – ${p.to == null ? "∞" : eur(p.to)}</td><td class="num">${(p.rate * 100).toFixed(0)}%</td><td class="num">${eur(p.amount)}</td><td class="num">${eur(p.tax)}</td></tr>`).join("");
    const cmp = y.compensations;
    const comp = [
      cmp.gp_vs_rcm ? `Losses offset against dividends (25% limit): <b>${eur(cmp.gp_vs_rcm)}</b>` : "",
      cmp.prior_vs_gp ? `Losses from previous years used against gains: <b>${eur(cmp.prior_vs_gp)}</b>` : "",
      cmp.prior_vs_rcm ? `Losses from previous years used against dividends: <b>${eur(cmp.prior_vs_rcm)}</b>` : "",
      y.carry_out.length ? `Losses carried forward: ${y.carry_out.map((c) => `<b>${eur(c.amount)}</b> from ${c.year} (usable until ${c.expires})`).join(", ")}` : "",
    ].filter(Boolean);
    $("#tax-detail").innerHTML = `
      <div class="tax-cols">
        <div><h4>Tax scale ${d.year}</h4><table class="grid mini"><thead><tr><th>Bracket</th><th class="num">Rate</th><th class="num">Base</th><th class="num">Tax</th></tr></thead>
          <tbody>${br || `<tr><td colspan="4" class="hint">Nothing taxable.</td></tr>`}</tbody></table></div>
        <div><h4>Offsets & carry-forward</h4>${comp.length ? `<ul class="plain">${comp.map((x) => `<li>${x}</li>`).join("")}</ul>` : '<p class="hint">Nothing to offset.</p>'}
          ${y.carry_in?.length ? `<p class="hint">Losses available at the start of ${d.year}: ${y.carry_in.map((c) => `${eur(c.amount)} (${c.year})`).join(", ")}</p>` : ""}</div>
      </div>`;

    // warnings
    const w = d.warnings.map((x) => x.kind === "rebuy"
      ? `<li>⚠ You sold <b>${esc(x.symbol)}</b> at a loss on ${fmtDate(x.sale_date)} — don't buy it again before <b>${fmtDate(x.until)}</b> or the loss (${eurS(x.loss)}) is deferred.</li>`
      : `<li>⏸ ${eurS(x.amount)} of losses on <b>${esc(x.symbol)}</b> are deferred by the 2-month rule; they count when you sell the shares bought around that sale.</li>`);
    $("#tax-warnings").innerHTML = w.length ? `<ul class="plain">${w.join("")}</ul>` : "";
    $("#tax-warnings").hidden = !w.length;

    // sales in the year
    const st = $("#tax-sales");
    st.tHead.innerHTML = `<tr><th>Date</th><th>Asset</th><th class="num">Qty</th><th class="num">Proceeds</th><th class="num">Cost (FIFO)</th><th class="num">Gain</th><th class="num">2-month rule</th><th class="num">Computable</th></tr>`;
    st.tBodies[0].innerHTML = d.sales.map((s) => `<tr><td>${fmtDate(s.date)}</td><td><b>${esc(s.symbol)}</b>${s.account ? ` <span class="sub">${esc(s.account)}</span>` : ""}</td>
      <td class="num">${fmtNum(s.quantity)}</td><td class="num">${eur(s.proceeds)}</td><td class="num">${eur(s.cost)}</td>
      <td class="num ${cls(s.gain)}">${eurS(s.gain)}</td>
      <td class="num">${s.blocked ? `<span class="warn-t" title="Same shares bought ${s.replacements.map((r) => fmtDate(r.bought_at)).join(", ")} — within 2 months of the sale">${eur(-s.blocked)} of loss deferred</span>` : "—"}</td>
      <td class="num ${cls(s.computable)}"><b>${eurS(s.computable)}</b></td></tr>`).join("")
      + d.released.map((r) => `<tr class="lot-row"><td>${fmtDate(r.date)}</td><td><b>${esc(r.symbol)}</b> <span class="sub">deferred loss released</span></td><td></td><td></td><td></td><td></td><td></td><td class="num down"><b>${eurS(r.amount)}</b></td></tr>`).join("")
      || `<tr><td colspan="8" class="hint">No sales in ${d.year}.</td></tr>`;

    // what-if + harvesting (current year only)
    $("#tax-now").hidden = !isNow;
    if (isNow) {
      const sim = d.simulation;
      const ht = $("#tax-harvest");
      ht.tHead.innerHTML = `<tr><th>Asset</th><th class="num">Unrealized loss</th><th class="num">Tax saved this year if sold</th><th>Then</th></tr>`;
      ht.tBodies[0].innerHTML = d.harvest.map((h) => `<tr><td><b>${esc(h.symbol || h.name)}</b><div class="sub">${esc(h.name)}</div></td>
        <td class="num down">${eurS(h.gain)}</td>
        <td class="num">${h.saving > 0.005 ? `<b class="up">${eur(h.saving)}</b>` : `<span class="sub" title="No gains this year to offset — the loss would be carried forward up to 4 years">0 € now · carried forward</span>`}</td>
        <td class="sub">don't rebuy before ${fmtDate(h.rebuy_until)}${h.recent_qty ? ` · ${fmtNum(h.recent_qty)} bought in the last 2 months` : ""}</td></tr>`).join("")
        || `<tr><td colspan="4" class="hint">No positions with unrealized losses.</td></tr>`;
      const wt = $("#tax-whatif");
      wt.tHead.innerHTML = `<tr><th>Asset</th><th class="num">Value</th><th class="num">Tax cost (FIFO, FX of buy date)</th><th class="num">Gain if sold</th><th class="num">Extra tax this year</th></tr>`;
      wt.tBodies[0].innerHTML = sim.positions.slice().reverse().map((p) => `<tr><td><b>${esc(p.symbol || p.name)}</b>${p.accounts.length > 1 ? ` <span class="sub">${p.accounts.length} accounts</span>` : ""}</td>
        <td class="num">${eur(p.value)}</td><td class="num">${eur(p.cost)}</td><td class="num ${cls(p.gain)}">${eurS(p.gain)}</td>
        <td class="num ${p.tax > 0 ? "down" : p.tax < 0 ? "up" : ""}">${eurS(p.tax)}</td></tr>`).join("");
      wt.tFoot.innerHTML = sim.positions.length ? `<tr><td>Sell everything</td><td></td><td></td><td class="num ${cls(sim.sell_all_gain)}">${eurS(sim.sell_all_gain)}</td><td class="num">${eurS(sim.sell_all_tax)}</td></tr>` : "";
    }

    // years overview
    const yt = $("#tax-years");
    yt.tHead.innerHTML = `<tr><th>Year</th><th class="num">Gains/losses</th><th class="num">Dividends</th><th class="num">Base</th><th class="num">Tax est.</th><th class="num">Carried forward</th></tr>`;
    yt.tBodies[0].innerHTML = d.years.map((x) => `<tr><td><b>${x.year}</b></td><td class="num ${cls(x.gp)}">${eurS(x.gp)}</td><td class="num">${eur(x.rcm)}</td>
      <td class="num">${eur(x.base)}</td><td class="num">${eur(x.after_deductions)}</td>
      <td class="num">${x.carry_out.length ? eur(x.carry_out.reduce((a, c) => a + c.amount, 0)) : "—"}</td></tr>`).join("");

    // prior losses editor
    const pl = d.prior_losses || {};
    $("#tax-prior").innerHTML = Object.entries(pl).sort().map(([yr, v]) => `<span class="chip-in">${yr}: ${eur(v)} <button data-y="${yr}" title="Remove">✕</button></span>`).join("") || '<span class="sub">none</span>';
    $("#tax-note").textContent = `Estimate for Spain (territorio común) in EUR — not tax advice. Uses FIFO per asset and account, the FX of each date, the ${d.year} savings scale, the 25% offset limit, 4-year carry-forward and the 2-month rule. Doesn't include regional rules, other savings income (interest, funds outside this app) or the foreign-tax limits per treaty.`
      + (d.fx_approx?.length ? ` No FX history for ${d.fx_approx.join(", ")}: today's rate used.` : "");
  }
  $("#tax-prior-add").addEventListener("click", async () => {
    const y = +$("#tax-prior-year").value, v = +$("#tax-prior-amt").value;
    if (!(y > 1990) || !(v > 0)) return;
    await saveSettings({ tax_prior_losses: { ...(state.settings.tax_prior_losses || {}), [y]: v } });
    $("#tax-prior-amt").value = "";
    loadTax(true);
  });
  $("#tax-prior").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-y]"); if (!b) return;
    const cur = { ...(state.settings.tax_prior_losses || {}) };
    delete cur[b.dataset.y];
    await saveSettings({ tax_prior_losses: cur });
    loadTax(true);
  });

  // ================================================================== dispatch
  function refresh(sub, silent) {
    if (sub === "exposure") return loadExposure(silent);
    if (sub === "costs") return loadCosts(silent);
    if (sub === "taxes") return loadTax(silent);
  }
  // fee rule → fee for a trade of `gross` in `account` (used to prefill the buy/sell dialogs)
  function feeFor(account, gross) {
    const r = (state.settings.account_fees || {})[account || ""];
    if (!r || !(gross > 0)) return null;
    let f = (r.fixed || 0) + ((r.pct || 0) / 100) * gross;
    if (r.min != null) f = Math.max(f, r.min);
    return Math.round(f * 100) / 100;
  }
  return { refresh, feeFor };
};
