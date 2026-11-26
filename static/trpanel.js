/* stonks-dash — Trade Republic panel: live Lang & Schwarz (LSX) prices for your TR holdings (app/trlive.py).
 * Dashboard PIN → encrypts the TR session on the Pi and unlocks it for N minutes (default 10), then it locks itself.
 * Your TR PIN is only used for the login request and never stored. */
window.StonksTR = function (ctx) {
  "use strict";
  const { api, esc, $ } = ctx;
  const dlg = $("#dlg-tr"), body = $("#tr-body"), pill = $("#tr-btn");
  let st = null, poll = null;

  const fmtLeft = (until) => { const s = Math.max(0, Math.round(until - Date.now() / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const LABEL = { no_pin: "Set up", no_session: "Not connected", pending: "Confirm in app", locked: "Locked", live: "Live" };

  async function load() {
    try { st = await api("/api/tr"); } catch { return; }
    drawPill();
    if (dlg.open) draw();
    clearTimeout(poll);
    if (st.state === "pending") poll = setTimeout(load, 2000);   // waiting for the push confirmation
  }
  function drawPill() {
    if (!st) return;
    pill.hidden = false;
    pill.className = `tr-pill tr-${st.state}`;
    pill.textContent = st.state === "live" ? `TR ${fmtLeft(st.unlocked_until)}` : "TR";
    pill.title = st.state === "live" ? `Trade Republic: live Lang & Schwarz prices · locks in ${fmtLeft(st.unlocked_until)}`
      : `Trade Republic: ${LABEL[st.state] || st.state}`;
  }
  // keep the countdown moving; re-read the state when it runs out (the Pi locks itself)
  setInterval(() => {
    if (!st) return;
    if (st.state === "live") { drawPill(); if (st.unlocked_until * 1000 < Date.now() + 1000) load(); if (dlg.open) { const el = $("#tr-left"); if (el) el.textContent = fmtLeft(st.unlocked_until); } }
  }, 1000);
  setInterval(() => { if (!document.hidden) load(); }, 30e3);

  function msg(text, bad = true) { const el = $("#tr-msg"); if (el) { el.textContent = text || ""; el.className = bad ? "error" : "hint"; el.hidden = !text; } }
  async function call(path, method = "POST", data) {
    msg("");
    try { st = await api(path, { method, body: data }); drawPill(); draw(); if (st.state === "pending") { clearTimeout(poll); poll = setTimeout(load, 2000); } return true; }
    catch (e) { msg(e.message); body.querySelectorAll('input[type="password"]').forEach((i) => { i.value = ""; }); return false; }
  }
  const pinInput = (id, ph = "Dashboard PIN") => `<input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" autocomplete="off" placeholder="${ph}">`;

  function draw() {
    if (!st) { body.innerHTML = '<div class="loading">Loading…</div>'; return; }
    const s = st.state;
    let html = "";
    if (s === "no_pin") {
      html = `<p>Choose a <b>dashboard PIN</b> (4–8 digits). It encrypts your Trade Republic session on the Pi and unlocks live prices for a few minutes at a time.</p>
        <div class="row">${pinInput("tr-new", "New PIN")}${pinInput("tr-new2", "Repeat PIN")}<button class="btn primary" data-a="setpin">Set PIN</button></div>`;
    } else if (s === "no_session") {
      html = `<p>Log in to Trade Republic. You'll confirm it in the <b>Trade Republic app</b> (or with your authenticator-app code).</p>
        <div class="tr-form">
          <label class="field">Phone number<input id="tr-phone" type="tel" placeholder="+34600123456" autocomplete="off"></label>
          <label class="field">Trade Republic PIN<input id="tr-trpin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits"></label>
          <label class="field">Dashboard PIN${pinInput("tr-pin")}</label>
          <button class="btn primary" data-a="login">Log in</button>
        </div>
        <p class="hint">Your Trade Republic PIN goes to Trade Republic once, for this login, and is never stored. The session the Pi gets back is stored encrypted with your dashboard PIN.</p>`;
    } else if (s === "pending") {
      html = st.pending?.needs_code
        ? `<p>Enter the code from your <b>authenticator app</b>.</p><div class="row"><input id="tr-code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="Code"><button class="btn primary" data-a="code">Confirm</button></div>`
        : `<p class="tr-wait">📱 Open the <b>Trade Republic app</b> and confirm the login…</p><p class="hint">Waiting up to ${fmtLeft(st.pending?.until || 0)}.</p>`;
    } else if (s === "locked") {
      html = `<p>🔒 Locked. Enter your dashboard PIN to resume live prices for <b>${st.lock_minutes} min</b>.</p>
        <div class="row">${pinInput("tr-pin")}<button class="btn primary" data-a="unlock">Unlock</button></div>
        ${st.locked_out_until ? `<p class="warn-t">Too many wrong PINs: try again after ${new Date(st.locked_out_until * 1000).toLocaleTimeString()}.</p>` : ""}
        <p class="hint">Session for ${esc(st.phone || "your account")}. <button class="linkbtn" data-a="relogin">Log in again</button> · <button class="linkbtn" data-a="forget">Forget the session</button> · <button class="linkbtn" data-a="reset">Forgot the PIN?</button></p>`;
    } else if (s === "live") {
      const held = st.held || [];
      const rows = (st.positions || []).map((p) => {
        const mism = p.symbol && p.dash_qty != null && p.qty != null && Math.abs(p.dash_qty - p.qty) > 1e-6;
        return `<tr><td><b>${esc(p.name || p.isin)}</b><div class="sub">${esc(p.isin)}</div></td>
          <td class="num">${p.qty != null ? p.qty.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}<div class="sub">avg ${p.avg != null ? p.avg.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " €" : "—"}</div></td>
          <td><select data-isin="${esc(p.isin)}">
              <option value="auto" ${p.how !== "yours" ? "selected" : ""}>Automatic${p.how === "auto" ? ` (${esc(p.symbol)})` : ": no match"}</option>
              <option value="none" ${p.how === "yours" && !p.symbol ? "selected" : ""}>— don't use —</option>
              ${held.map((h) => `<option value="${esc(h)}" ${p.how === "yours" && h === p.symbol ? "selected" : ""}>${esc(h)}</option>`).join("")}</select>
            <div class="sub">${p.symbol ? `TR price → ${esc(p.symbol)}` : "not shown"}</div></td>
          <td class="num ${mism ? "warn-t" : ""}" title="${mism ? "The dashboard has a different quantity than Trade Republic" : ""}">${p.dash_qty != null ? p.dash_qty.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}</td></tr>`;
      }).join("");
      html = `<p class="tr-live">● Live: Lang &amp; Schwarz prices (bid/ask midpoint) for your TR holdings · ${st.ticks} updates${st.last_tick ? `, last ${new Date(st.last_tick * 1000).toLocaleTimeString()}` : ""}.
          Locks in <b id="tr-left">${fmtLeft(st.unlocked_until)}</b>. <button class="btn ghost xs" data-a="lock">Lock now</button></p>
        <div class="table-wrap"><table class="grid tr-map"><thead><tr><th>Trade Republic holding</th><th class="num">TR units</th><th>Shown as</th><th class="num">Dashboard units</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="hint">Loading your holdings…</td></tr>'}</tbody></table></div>
        <p class="hint">Prices come in euros from LSX (07:30–23:00) and are converted to each listing's currency (e.g. US$ for MCD). They replace Yahoo's for these tickers while unlocked.</p>`;
    }
    const settings = st.pin_set && s !== "no_pin" ? `<details class="tr-settings"><summary>Security settings</summary>
        <div class="row"><label class="field">Auto-lock after (min)<input id="tr-mins" type="number" min="1" max="240" value="${st.lock_minutes}"></label><button class="btn ghost" data-a="mins">Save</button></div>
        <div class="row">${pinInput("tr-cur", "Current PIN")}${pinInput("tr-new", "New PIN")}${pinInput("tr-new2", "Repeat new PIN")}<button class="btn ghost" data-a="changepin">Change PIN</button></div>
        <p class="hint">5 wrong PINs block attempts for 15 minutes. The encryption key comes from the PIN plus a secret kept on the Pi (STONKS_SECRET or /data/.stonks_secret), so a copy of the database alone can't be decrypted.</p></details>` : "";
    body.innerHTML = `<div id="tr-msg" class="error" hidden></div>${st.error ? `<p class="warn-t">${esc(st.error)}</p>` : ""}${html}${settings}
      <p class="hint tr-note">Trade Republic has no public API: this uses pytr, which talks to TR's private web API as you, read-only (holdings and prices; no order calls). TR can end the session at any time.</p>`;
  }

  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const v = (id) => ($(`#${id}`)?.value || "").trim();
    const a = b.dataset.a;
    if (a === "setpin" || a === "changepin") {
      if (!/^\d{4,8}$/.test(v("tr-new"))) return msg("The PIN must be 4–8 digits.");
      if (v("tr-new") !== v("tr-new2")) return msg("The two PINs don't match.");
      await call("/api/tr/pin", "POST", { new_pin: v("tr-new"), pin: a === "changepin" ? v("tr-cur") : null });
      if (a === "changepin") msg("PIN changed.", false);
    } else if (a === "login") {
      b.disabled = true;
      await call("/api/tr/login", "POST", { phone: v("tr-phone").replace(/\s+/g, ""), tr_pin: v("tr-trpin"), pin: v("tr-pin") });
      b.disabled = false;
    } else if (a === "code") await call("/api/tr/login/code", "POST", { code: v("tr-code") });
    else if (a === "unlock") { b.disabled = true; await call("/api/tr/unlock", "POST", { pin: v("tr-pin") }); b.disabled = false; }
    else if (a === "lock") await call("/api/tr/lock");
    else if (a === "relogin") { st = { ...st, state: "no_session" }; draw(); }
    else if (a === "forget") {
      const pin = prompt("Dashboard PIN to delete the saved Trade Republic session:");
      if (pin) await call("/api/tr/forget", "POST", { pin });
    } else if (a === "reset") {
      if (confirm("Delete the dashboard PIN and the saved Trade Republic session? You'll set a new PIN and log in to Trade Republic again.")) await call("/api/tr/reset");
    } else if (a === "mins") await call("/api/tr/config", "PUT", { lock_minutes: +v("tr-mins") });
  });
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { const b = e.target.closest(".row, .tr-form")?.querySelector("[data-a]"); b?.click(); } });
  body.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-isin]");
    if (sel) call("/api/tr/config", "PUT", { map: { [sel.dataset.isin]: sel.value } });
  });
  pill.addEventListener("click", () => { draw(); dlg.showModal(); load(); });
  load();
  return { load, status: () => st };
};
