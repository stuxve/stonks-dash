/* stonks-dash — dashboard PIN lock (app/auth.py). Runs before app.js: the app only starts once the Pi says this
 * browser is unlocked. Your use of the page (clicks, keys, scrolling, touches) is reported to the Pi at most every
 * 30 s; after `idle_minutes` without any, the Pi ends the session and every tab reloads into this lock screen. */
window.StonksLock = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  let st = null, resolveReady, lastAct = Date.now(), lastPing = 0, started = false;
  const ready = new Promise((r) => { resolveReady = r; });

  async function get(path, body) {
    const r = await fetch(path, body === undefined && path === "/api/auth" ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const d = j?.detail;
      throw new Error(typeof d === "string" ? d : Array.isArray(d) ? "The PIN must be 4–8 digits." : r.statusText);
    }
    return j;
  }

  function screen(html) {
    let el = $("#lockscreen");
    if (!el) {
      el = document.createElement("div");
      el.id = "lockscreen";
      document.body.appendChild(el);
    }
    document.body.classList.add("locked");
    el.innerHTML = `<form class="lock-card" autocomplete="off">
      <div class="brand"><span class="logo" aria-hidden="true"><i></i><i></i><i></i><i></i></span>stonks<b>dash</b></div>${html}
      <p id="lock-msg" class="error" hidden></p></form>`;
    el.querySelector("input")?.focus();
    return el;
  }
  const pinField = (id, ph) => `<input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" autocomplete="off" placeholder="${ph}" required>`;
  function msg(t) { const m = $("#lock-msg"); if (m) { m.textContent = t; m.hidden = !t; } }

  function drawLocked() {
    const out = st.locked_out_until ? `<p class="warn-t">Too many wrong PINs: try again after ${new Date(st.locked_out_until * 1000).toLocaleTimeString()}.</p>` : "";
    const el = screen(`<h2>Locked</h2><p class="hint">Enter your PIN.</p>${pinField("lk-pin", "PIN")}
      <button class="btn primary" type="submit">Unlock</button>${out}
      <details class="lock-help"><summary>Forgot the PIN?</summary><p class="hint">On the Pi:<br><code>sudo docker exec stonks-dash python -m app.auth reset</code><br><code>sudo docker restart stonks-dash</code><br>
      That deletes the PIN and the saved Trade Republic session (your portfolio stays); then set a new PIN here.</p></details>`);
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = el.querySelector("button[type=submit]");
      b.disabled = true;
      try { st = await get("/api/auth/unlock", { pin: $("#lk-pin").value }); opened(); }
      catch (err) { msg(err.message); $("#lk-pin").value = ""; $("#lk-pin").focus(); b.disabled = false; }
    });
  }
  function drawSetup() {
    const el = screen(`<h2>Set a PIN</h2><p class="hint">4–8 digits; 6 or more is safer. It locks this dashboard after ${st.idle_minutes} minutes without use and encrypts your Trade Republic session.</p>
      ${pinField("lk-new", "New PIN")}${pinField("lk-new2", "Repeat PIN")}<button class="btn primary" type="submit">Set PIN</button>`);
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!/^\d{4,8}$/.test($("#lk-new").value)) return msg("The PIN must be 4–8 digits.");
      if ($("#lk-new").value !== $("#lk-new2").value) return msg("The two PINs don't match.");
      try { st = await get("/api/auth/setup", { new_pin: $("#lk-new").value }); opened(); }
      catch (err) { msg(err.message); }
    });
  }

  function opened() {
    $("#lockscreen")?.remove();
    document.body.classList.remove("locked");
    lastAct = lastPing = Date.now();
    if (!started) { started = true; watch(); }
    resolveReady();
  }
  // the session ended (idle, "Lock now", another tab, a restart): reload, so nothing of the data stays in the page
  function lost() { if (!lost.done) { lost.done = true; location.reload(); } }

  function watch() {
    const act = () => { lastAct = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) addEventListener(ev, act, { passive: true, capture: true });
    setInterval(async () => {
      if (lastAct > lastPing && Date.now() - lastPing > 30e3) {          // you used the page: keep the session open
        lastPing = Date.now();
        try { await get("/api/auth/ping"); } catch { /* a 401 is caught by the check below */ }
      }
    }, 5e3);
    setInterval(check, 15e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  }
  async function check() {
    try { st = await get("/api/auth"); } catch { return; }              // Pi unreachable: the app shows that
    if (st.state !== "unlocked" && st.state !== "off") lost();
  }

  async function lockNow() {
    try { await get("/api/auth/lock"); } catch {}
    lost();
  }

  (async function boot() {
    try { st = await get("/api/auth"); }
    catch (e) { screen(`<h2>Backend unreachable</h2><p class="hint">${String(e.message).replace(/[<>&]/g, "")}</p>`); return; }
    if (st.state === "unlocked" || st.state === "off") { if (st.state === "unlocked" && !started) { started = true; watch(); } resolveReady(); }
    else if (st.state === "no_pin") drawSetup();
    else drawLocked();
  })();

  return { ready, lost, lockNow, status: () => st };
})();
