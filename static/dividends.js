/* stonks-dash — Market hours → Dividends: for each holding, how and when it pays, the next ex-dividend date and
 * payment, what you can expect, what you've recorded, and past payments you held units for but haven't recorded.
 * ex-dividend date ("ex-date"): you must own the units BEFORE this day to get the payment.
 * TTM (trailing 12 months) yield: dividends of the last 365 days ÷ today's price. */
window.StonksDividends = function (ctx) {
  "use strict";
  const { api, esc, state, base, fmtMoney, fmtPrice, fmtNum, fmtDate, fmtPct, openTx, $ } = ctx;
  const box = $("#h-divs");
  let data = null, at = 0, key = "", loading = false;
  const open = new Set();

  async function load(force) {
    const k = base();
    if (loading || (!force && data && k === key && Date.now() - at < 10 * 60e3)) { if (data) draw(); return; }
    loading = true;
    if (!data) box.innerHTML = '<div class="loading">Loading dividends…</div>';
    try { data = await api(`/api/dividends?base=${encodeURIComponent(k)}`); at = Date.now(); key = k; }
    catch (e) { box.innerHTML = `<div class="empty">Could not load dividends: ${esc(e.message)}</div>`; return; }
    finally { loading = false; }
    draw();
  }

  const until = (iso) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(`${iso}T00:00:00`) - t) / 864e5); };
  const days = (n) => (n == null ? "" : n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} d ago` : `in ${n} d`);
  const KIND = {
    stopped: ["Stopped?", "Paid before, but the last two expected payments didn't come"],
    none: ["No dividend", "This company doesn't pay a dividend"],
    none_fund: ["No payouts on record", "Yahoo has no distributions for this fund: it's most likely accumulating (income reinvested inside the fund)"],
    accumulating: ["Accumulating", "Accumulating fund: dividends from its holdings are reinvested inside the fund, nothing is paid out to you"],
    na: ["n/a", "Crypto and currencies don't pay dividends"],
  };

  function draw() {
    if (!data) return;
    const b = data.base, t = data.totals, items = data.items;
    const payers = items.filter((x) => x.kind === "pays" || x.kind === "stopped");
    const others = items.filter((x) => !payers.includes(x));
    const kpi = (k, v, d = "", tip = "") => `<div class="kpi" title="${esc(tip)}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const kpis = `<div class="kpis small">
      ${kpi("Expected per year", fmtMoney(t.annual, b), t.yield != null ? `${t.yield.toFixed(2)}% of your portfolio value · gross` : "gross",
        "If every payer keeps paying its latest amount at its usual frequency, on the units you hold now. Gross: before tax withheld at source and Spanish tax.")}
      ${kpi("Next 90 days", fmtMoney(t.next90, b), "ex-dates in the next 3 months · gross", "Payments whose ex-date falls in the next 90 days, on the units you hold now.")}
      ${kpi("Received this year", fmtMoney(t.ytd_net, b), `net · ${fmtMoney(t.ytd_gross, b)} gross`, "Dividends you recorded with a payment date this year (Dividend button in My portfolio).")}
      ${kpi("Received all-time", fmtMoney(t.all_net, b), "net, as recorded")}
      ${kpi("To record", `<span class="${t.missing ? "warn-t" : ""}">${t.missing}</span>`, `${t.awaiting} awaiting payment`,
        "Past ex-dates where you held units and no dividend is recorded yet. 'Awaiting': the ex-date was less than 45 days ago, so it may not be paid yet.")}
    </div>`;
    box.innerHTML = `${kpis}${months()}
      ${payers.length ? table(payers) : '<p class="hint">None of your holdings pays dividends.</p>'}
      ${others.length ? `<p class="dv-others"><b>Don't pay out:</b> ${others.map((x) => `<span class="pill" title="${esc(KIND[x.kind]?.[1] || "")}">${esc(x.symbol)} · ${esc(KIND[x.kind]?.[0] || x.kind)}</span>`).join(" ")}</p>` : ""}
      ${followUp()}
      <p class="hint">Data: Yahoo Finance dividend history (amount per share at each <b>ex-dividend date</b>) and, mostly for US stocks, its calendar of the next ex-date and payment date.
        To get a payment you must own the units <b>before</b> the ex-date. When Yahoo hasn't published the next date it's <i>estimated</i> from the usual spacing of past payments, with the last amount.
        Amounts are gross per share in the listing's currency; your broker pays them net of tax withheld at source (for example 15% for US stocks with the W-8BEN form, 19% in Spain), and converts the currency.
        <b>TTM yield</b> (trailing twelve months): dividends of the last 365 days ÷ today's price. <b>Yield on cost</b>: the yearly payout rate on what you paid.</p>`;
  }

  function months() {
    const ms = data.months || [];
    if (!ms.length) return "";
    const now = new Date(), cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    // 12 past + 12 future months, empty ones included
    const keys = [];
    for (let i = -11; i <= 12; i++) { const d = new Date(now.getFullYear(), now.getMonth() + i, 1); keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
    const by = Object.fromEntries(ms.map((m) => [m.month, m]));
    const max = Math.max(1e-9, ...keys.map((k) => Math.max(by[k]?.expected || 0, by[k]?.received || 0)));
    const b = data.base;
    const lbl = (k) => new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(`${k}-01T00:00:00`));
    const tick = (k) => (k.endsWith("-01") ? `${lbl(k)} ${k.slice(2, 4)}` : lbl(k));     // the year on January
    return `<div class="dv-months" title="">${keys.map((k) => {
      const m = by[k] || {}, past = k < cur, v = past ? m.received || 0 : (m.expected || 0) + (k === cur ? m.received || 0 : 0);
      const tip = past ? `${lbl(k)} ${k.slice(0, 4)}: received ${fmtMoney(m.received || 0, b)} net (recorded)`
        : `${lbl(k)} ${k.slice(0, 4)}: expected ${fmtMoney(m.expected || 0, b)} gross (by ex-date)${k === cur ? ` · received ${fmtMoney(m.received || 0, b)}` : ""}\n`
          + (m.items || []).map((i) => `${i.symbol} ${i.ex}${i.estimated ? " (est.)" : ""}: ${fmtMoney(i.amount, b)}`).join("\n");
      return `<div class="dv-m ${past ? "past" : "fut"} ${k === cur ? "cur" : ""}" title="${esc(tip)}"><div class="dv-bar" style="height:${Math.round((v / max) * 100)}%"></div><span>${tick(k)}</span></div>`;
    }).join("")}</div><div class="hint dv-mleg"><span class="dv-sw past"></span> received (recorded, net) <span class="dv-sw fut"></span> expected (gross, by ex-date month) · hover a month</div>`;
  }

  function table(rows) {
    const b = data.base;
    const head = `<tr><th>Asset</th><th>Pays</th><th class="num">Last ex-date</th><th class="num" title="You must own the units before this date">Next ex-date</th><th class="num">Payment</th>
      <th class="num">Per share</th><th class="num">Your units</th><th class="num">Expected</th><th class="num" title="Trailing 12 months: last year's dividends ÷ today's price">TTM yield</th>
      <th class="num" title="Yearly payout rate on what you paid">Yield on cost</th><th class="num">Per year</th><th class="num">Received</th><th></th></tr>`;
    const body = rows.map((x) => {
      const n = x.next, pp = x.pending_pay, c = x.currency;
      const miss = x.follow_up.filter((e) => e.status === "missing").length;
      const nextCell = n ? `<b>${esc(fmtDate(n.ex))}</b><div class="sub">${n.estimated ? '<span class="dv-est" title="Not published yet: estimated from the usual spacing of past payments">est.</span> ' : ""}${days(n.days)}</div>`
        : x.kind === "stopped" ? '<span class="warn-t">overdue</span>' : "—";
      const pay = pp ? `<b>${esc(fmtDate(pp.pay))}</b><div class="sub">for ex ${esc(fmtDate(pp.ex))} · ${days(pp.days)}</div>`
        : n?.pay ? `${esc(fmtDate(n.pay))}<div class="sub">${days(until(n.pay))}</div>` : '<span class="sub" title="Yahoo has no payment date yet">—</span>';
      const per = n?.amount != null ? `${fmtPrice(n.amount, c)}${n.amount_known ? "" : '<div class="sub" title="Not announced: the last regular payment">as last</div>'}` : "—";
      const exp = pp?.expected_base != null ? `${fmtMoney(pp.expected_base, b)}<div class="sub">due ${esc(fmtDate(pp.pay))}</div>`
        : n?.expected_base != null ? `${fmtMoney(n.expected_base, b)}<div class="sub">${c !== b ? fmtPrice(n.expected, c) + " · " : ""}gross</div>` : "—";
      return `<tr class="dv-row" data-sym="${esc(x.symbol)}"><td class="asset"><button class="exp">${open.has(x.symbol) ? "▾" : "▸"}</button><b>${esc(x.symbol)}</b>${x.source ? `<span class="pill" title="Dividends of ${esc(x.source)}, the listing this fund is priced from">via ${esc(x.source)}</span>` : ""}<div class="sub">${esc(x.name || "")}</div></td>
        <td>${x.kind === "stopped" ? `<span class="warn-t" title="${esc(KIND.stopped[1])}">stopped?</span>` : esc(x.freq_label || "irregular")}</td>
        <td class="num">${x.last ? `${esc(fmtDate(x.last.ex))}<div class="sub">${fmtPrice(x.last.amount, c)}</div>` : "—"}</td>
        <td class="num">${nextCell}</td><td class="num">${pay}</td><td class="num">${per}</td>
        <td class="num">${fmtNum(x.units)}</td><td class="num">${exp}</td>
        <td class="num">${x.yield_ttm != null ? x.yield_ttm.toFixed(2) + "%" : "—"}</td>
        <td class="num">${x.yield_on_cost != null ? x.yield_on_cost.toFixed(2) + "%" : "—"}</td>
        <td class="num">${x.annual_base != null ? fmtMoney(x.annual_base, b) : "—"}</td>
        <td class="num">${x.received.count ? `${fmtMoney(x.received.net, b)}<div class="sub">${x.received.count} recorded · net</div>` : '<span class="sub">none</span>'}</td>
        <td>${miss ? `<span class="pill warn-t" title="Past payments you held units for, not recorded">${miss} to record</span>` : ""}</td></tr>
        ${open.has(x.symbol) ? `<tr class="dv-detail"><td colspan="13">${detail(x)}</td></tr>` : ""}`;
    }).join("");
    return `<div class="table-wrap"><table class="grid dv-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function detail(x) {
    const c = x.currency;
    const hist = (x.history || []).slice().reverse().slice(0, 12)
      .map(([d, v]) => `<span class="pill">${esc(fmtDate(d))} · ${fmtPrice(v, c)}</span>`).join(" ");
    const fu = x.follow_up.length ? `<table class="grid dv-fu"><thead><tr><th>Ex-date</th><th class="num">Per share</th><th class="num">Units you held</th><th class="num">Expected gross</th><th>Status</th><th></th></tr></thead><tbody>
      ${x.follow_up.map((e) => fuRow(x, e)).join("")}</tbody></table>` : '<p class="hint">No ex-date in the last 2 years while you held units.</p>';
    return `<div class="dv-det"><div><b>Payments per share</b> (ex-date · amount, newest first)<div class="dv-hist">${hist || "—"}</div></div>
      <div><b>Your payments</b> (last 2 years)${fu}</div></div>`;
  }

  const STATUS = { recorded: ["Recorded", "up"], awaiting: ["Awaiting payment", "muted-t"], missing: ["Not recorded", "warn-t"] };
  function fuRow(x, e) {
    const [l, k] = STATUS[e.status];
    const rec = e.tx ? `${esc(fmtDate(e.tx.date))} · ${fmtPrice(e.tx.amount, e.tx.currency || x.currency)}` : "";
    return `<tr><td>${esc(fmtDate(e.ex))}</td><td class="num">${fmtPrice(e.amount, x.currency)}</td><td class="num">${fmtNum(e.units)}</td>
      <td class="num">${fmtPrice(e.gross, x.currency)}${e.gross_base != null && x.currency !== data.base ? `<div class="sub">${fmtMoney(e.gross_base, data.base)}</div>` : ""}</td>
      <td class="${k}">${l}${rec ? `<div class="sub">${rec}</div>` : ""}</td>
      <td>${e.status !== "recorded" ? `<button class="btn ghost xs dv-rec" data-sym="${esc(x.symbol)}" data-ex="${esc(e.ex)}">Record</button>` : ""}</td></tr>`;
  }

  function followUp() {
    const rows = data.items.flatMap((x) => x.follow_up.filter((e) => e.status === "missing").map((e) => ({ x, e })));
    if (!rows.length) return "";
    return `<h3 class="sub-h">Not recorded yet <span class="hint">· you held units on these ex-dates, but no dividend is recorded within 75 days after</span></h3>
      <div class="table-wrap"><table class="grid dv-fu"><thead><tr><th>Asset</th><th>Ex-date</th><th class="num">Per share</th><th class="num">Units you held</th><th class="num">Expected gross</th><th></th></tr></thead><tbody>
      ${rows.map(({ x, e }) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${esc(fmtDate(e.ex))}</td><td class="num">${fmtPrice(e.amount, x.currency)}</td><td class="num">${fmtNum(e.units)}</td>
        <td class="num">${fmtPrice(e.gross, x.currency)}</td><td><button class="btn ghost xs dv-rec" data-sym="${esc(x.symbol)}" data-ex="${esc(e.ex)}">Record</button></td></tr>`).join("")}
      </tbody></table></div>
      <p class="hint">Some brokers pay small amounts late or net them with other income; if a payment never came (for example you sold before the record date), ignore it.</p>`;
  }

  box.addEventListener("click", (ev) => {
    const r = ev.target.closest(".dv-rec");
    if (r) {
      const x = data.items.find((i) => i.symbol === r.dataset.sym), e = x?.follow_up.find((f) => f.ex === r.dataset.ex);
      if (!x || !e) return;
      const today = new Date().toISOString().slice(0, 10);
      openTx("DIVIDEND", {
        symbol: x.symbol, account: x.accounts.length === 1 ? x.accounts[0] || null : null,
        date: e.ex > today ? today : e.ex, amount: +e.gross.toFixed(4), currency: x.currency,
        notes: `ex-date ${e.ex} · ${fmtNum(e.units)} × ${e.amount}`,
      });
      return;
    }
    const row = ev.target.closest(".dv-row");
    if (row) { const s = row.dataset.sym; open.has(s) ? open.delete(s) : open.add(s); draw(); }
  });
  // after a dividend is recorded or edited, refresh the follow-up
  $("#dlg-tx").addEventListener("close", () => { if (state.view === "hours") setTimeout(() => load(true), 400); else data = null; });

  return { load, draw };
};
