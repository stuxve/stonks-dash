/* stonks-dash — Trade Republic panel: live prices for your TR holdings, mostly from Lang & Schwarz (app/trlive.py).
 * The dashboard PIN (static/lock.js) encrypts the TR session; once you've unlocked the dashboard the Pi keeps the
 * feed running, also while the dashboard is locked again. Your TR PIN is only used for the login request. */
window.StonksTR = function (ctx) {
  "use strict";
  const { api, esc, $ } = ctx;
  const dlg = $("#dlg-tr"), body = $("#tr-body"), pill = $("#tr-btn");
  let st = null, poll = null, shown = "";

  const LABEL = { no_session: "Not connected", pending: "Confirm in the app", connecting: "Connecting…", live: "Live", stopped: "Stopped" };
  const ago = (t) => { if (!t) return "—"; const s = Math.max(0, Math.round((st.now || Date.now() / 1000) - t)); return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
  const n = (v, d = 6) => (v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d }));

  async function load() {
    try { st = await api("/api/tr"); } catch { return; }
    drawPill();
    if (dlg.open) draw();
    clearTimeout(poll);
    if (st.state === "pending" || st.state === "connecting" || (dlg.open && st.state === "live" && !st.positions?.length))
      poll = setTimeout(load, 2000);
  }
  function drawPill() {
    pill.hidden = false;
    pill.className = `tr-pill tr-${st.state}${st.error && st.state !== "live" ? " tr-err" : ""}`;
    pill.textContent = "TR";
    pill.title = `Trade Republic: ${LABEL[st.state] || st.state}${st.error ? ` · ${st.error}` : ""}`;
  }
  setInterval(() => { if (!document.hidden) load(); }, 30e3);

  function msg(text, bad = true) { const el = $("#tr-msg"); if (el) { el.textContent = text || ""; el.className = bad ? "error" : "hint"; el.hidden = !text; } }
  async function call(path, method = "POST", data) {
    msg("");
    try { st = await api(path, { method, body: data }); drawPill(); draw(true); clearTimeout(poll); if (["pending", "connecting"].includes(st.state)) poll = setTimeout(load, 2000); return true; }
    catch (e) { msg(e.message); return false; }
  }

  // Redraw only when what's shown changes, so a refresh never wipes what you're typing; counters update in place.
  function draw(force = false) {
    if (!st) { body.innerHTML = '<div class="loading">Loading…</div>'; return; }
    const s = st.state;
    const sig = JSON.stringify([s, st.error, st.pending?.needs_code, s === "live" ? (st.positions || []).map((p) => [p.isin, p.name, p.symbol, p.how, p.qty, p.dash_qty, p.venue, p.issue]) : 0, st.held]);
    if (!force && sig === shown && body.firstChild) {
      const c = $("#tr-count"); if (c) c.textContent = `${st.ticks} updates, last ${ago(st.last_tick)}`;
      return;
    }
    const keepMsg = $("#tr-msg") && !$("#tr-msg").hidden ? $("#tr-msg").outerHTML : '<div id="tr-msg" class="error" hidden></div>';
    shown = sig;
    let html = "";
    if (s === "no_session") {
      html = `<p>Log in to Trade Republic. You'll confirm it in the <b>Trade Republic app</b> (or with your authenticator-app code).</p>
        <div class="tr-form">
          <label class="field">Phone number<input id="tr-phone" type="tel" placeholder="+34600123456" autocomplete="off"></label>
          <label class="field">Trade Republic PIN<input id="tr-trpin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits"></label>
          <button class="btn primary" data-a="login">Log in</button>
        </div>
        <p class="hint">Your Trade Republic PIN goes to Trade Republic once, for this login; the Pi doesn't keep it. The session it gets back is stored encrypted with your dashboard PIN, and the feed keeps running while the dashboard is locked.</p>`;
    } else if (s === "pending") {
      html = st.pending?.needs_code
        ? `<p>Enter the code from your <b>authenticator app</b>.</p><div class="row"><input id="tr-code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="Code"><button class="btn primary" data-a="code">Confirm</button></div>
           <p class="hint">A wrong code can be retried until the login expires.</p>`
        : `<p class="tr-wait">📱 Open the <b>Trade Republic app</b> and confirm the login…</p>`;
    } else if (s === "connecting") {
      html = `<p class="tr-wait">Connecting to Trade Republic…</p>`;
    } else if (s === "stopped") {
      html = `<p>The price feed isn't running. <button class="btn primary xs" data-a="reconnect">Reconnect</button></p>`;
    } else if (s === "live") {
      const held = st.held || [];
      const rows = (st.positions || []).map((p) => {
        const mism = p.symbol && p.dash_qty != null && p.qty != null && Math.abs(p.dash_qty - p.qty) > 1e-6;
        return `<tr><td><b>${esc(p.name || p.isin)}</b><div class="sub">${esc(p.isin)}${p.venue ? ` · ${esc(p.venue === "LSX" ? "Lang & Schwarz" : p.venue)}` : ""}</div>${p.issue ? `<div class="sub warn-t">${esc(p.issue)}</div>` : ""}</td>
          <td class="num">${n(p.qty)}<div class="sub">avg ${p.avg != null ? n(p.avg, 4) + " €" : "—"}</div></td>
          <td><select data-isin="${esc(p.isin)}">
              <option value="auto" ${p.how !== "yours" ? "selected" : ""}>Automatic${p.how === "auto" ? ` (${esc(p.symbol)})` : ": no match"}</option>
              <option value="none" ${p.how === "yours" && !p.symbol ? "selected" : ""}>— don't use —</option>
              ${held.map((h) => `<option value="${esc(h)}" ${p.how === "yours" && h === p.symbol ? "selected" : ""}>${esc(h)}</option>`).join("")}</select>
            <div class="sub">${p.symbol ? `TR price → ${esc(p.symbol)}` : "not shown"}</div></td>
          <td class="num ${mism ? "warn-t" : ""}" title="${mism ? "Your dashboard has a different quantity than Trade Republic (counting your Trade Republic account, or all accounts if none is named that)" : ""}">${n(p.dash_qty)}</td></tr>`;
      }).join("");
      html = `<p class="tr-live">● Live · ${esc(st.phone || "")} · <span id="tr-count">${st.ticks} updates, last ${ago(st.last_tick)}</span>
          <button class="btn ghost xs" data-a="disconnect">Disconnect</button></p>
        <div class="table-wrap"><table class="grid tr-map"><thead><tr><th>Trade Republic holding</th><th class="num">TR units</th><th>Shown as</th><th class="num">Dashboard units</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="hint">Loading your holdings…</td></tr>'}</tbody></table></div>
        <p class="hint">Prices are the bid/ask midpoint in euros, converted to each listing's currency (e.g. US$ for MSFT). They replace Yahoo's for these tickers while they flow (Lang &amp; Schwarz trades 07:30–23:00).</p>`;
    }
    body.innerHTML = `${keepMsg}${st.error ? `<p class="warn-t">${esc(st.error)}</p>` : ""}${html}
      <p class="hint tr-note">Trade Republic has no public API: this uses pytr, which talks to TR's private web API as you, read-only (holdings and prices; no order calls). TR can end the session at any time.</p>`;
  }

  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const v = (id) => ($(`#${id}`)?.value || "").trim();
    const a = b.dataset.a;
    b.disabled = true;
    if (a === "login") {
      const ok = await call("/api/tr/login", "POST", { phone: v("tr-phone").replace(/[\s-]+/g, ""), tr_pin: v("tr-trpin") });
      if (!ok && $("#tr-trpin")) $("#tr-trpin").value = "";
    } else if (a === "code") {
      if (!(await call("/api/tr/login/code", "POST", { code: v("tr-code") })) && $("#tr-code")) { $("#tr-code").value = ""; $("#tr-code").focus(); }
    } else if (a === "reconnect") await call("/api/tr/reconnect");
    else if (a === "disconnect") {
      if (confirm("Disconnect Trade Republic? The saved session is deleted; you'll log in again (and confirm in the app) to get its prices back.")) await call("/api/tr/disconnect");
    }
    if (b.isConnected) b.disabled = false;
  });
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); e.target.closest(".row, .tr-form")?.querySelector("[data-a]")?.click(); } });
  body.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-isin]");
    if (sel) call("/api/tr/config", "PUT", { map: { [sel.dataset.isin]: sel.value } });
  });
  pill.addEventListener("click", () => { draw(true); dlg.showModal(); load(); });
  load();
  return { load, status: () => st };
};
