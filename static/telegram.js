/* stonks-dash — Telegram alerts panel (in Sell targets). The Pi checks your buys every few minutes and sends a
 * message when one hits its target or stop, breaks out, gets near a level, or reports earnings soon. */
window.StonksTelegram = function (ctx) {
  "use strict";
  const { api, esc, $, $$ } = ctx;
  let st = null, poll = null;
  const box = $("#tg-telegram");

  const ago = (t) => {
    if (!t) return "never";
    const s = Math.round(Date.now() / 1000 - t);
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t * 1000).toLocaleString();
  };
  const EV = [["tp", "Target hit"], ["sl", "Stop hit"], ["brk", "Breakout (suggests raising the stop)"], ["near", "Near target / near stop"],
    ["earnings", "Earnings coming up"], ["unmonitored", "Also for buys without any exit set"]];

  async function load() {
    try { st = await api("/api/alerts"); } catch (e) { box.querySelector(".tgx-body").innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    draw();
    clearTimeout(poll);
    if (st.pairing && !st.linked) poll = setTimeout(load, 3000);   // waiting for the /start message
  }
  async function call(path, method = "POST", body) {
    const err = box.querySelector(".tgx-err");
    err.hidden = true;
    try { st = await api(path, { method, body }); draw(); return true; }
    catch (e) { err.textContent = e.message; err.hidden = false; return false; }
  }

  function draw() {
    const c = st.config || {}, ev = c.events || {};
    const on = c.enabled && st.token && st.linked;
    const muted = st.muted_until && st.muted_until * 1000 > Date.now();
    box.querySelector(".tgx-sum").innerHTML = `<span class="st ${on ? (muted ? "st-warn" : "st-open") : "st-closed"}">${on ? (muted ? "Muted" : "On") : "Off"}</span>
      <b>Telegram alerts</b> <span class="hint">${on ? `to ${esc(c.chat_name || "your chat")} · checks every ${c.interval_min} min · last ${ago(st.last_check)}${muted ? ` · muted until ${new Date(st.muted_until * 1000).toLocaleTimeString()}` : ""}`
        : !st.token ? "set up a bot to get target, stop and breakout alerts on your phone" : !st.linked ? "link your Telegram chat to finish" : "paused"}</span>
      ${st.last_error ? `<span class="warn-t" title="${esc(st.last_error)}">· last error: ${esc(st.last_error.slice(0, 60))}</span>` : ""}`;
    const bot = st.bot ? `<b>@${esc(st.bot.username)}</b>` : "";
    const step1 = st.token === "env"
      ? `<p>✓ Bot token from the <code>TELEGRAM_BOT_TOKEN</code> environment variable ${bot}.</p>`
      : st.token === "app"
        ? `<p>✓ Bot ${bot} <button class="btn ghost xs" data-act="rmtoken">Remove token</button></p>`
        : `<ol class="tgx-steps"><li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, pick a name and a username ending in <i>bot</i>.</li>
            <li>Copy the token it gives you (<code>123456789:AA…</code>) and paste it here. It's stored only on the Pi and never shown again or included in backups.
              For extra safety put it in <code>.env</code> as <code>TELEGRAM_BOT_TOKEN=…</code> instead.</li></ol>
           <div class="row-in"><input type="password" class="tgx-token" placeholder="Bot token" autocomplete="off"><button class="btn primary" data-act="token">Save token</button></div>`;
    const step2 = !st.token ? `<p class="hint">After the token.</p>`
      : st.linked ? `<p>✓ Linked to <b>${esc(c.chat_name || String(c.chat_id))}</b>
            <button class="btn ghost xs" data-act="test">Send a test</button> <button class="btn ghost xs" data-act="check">Check now</button>
            <button class="btn ghost xs" data-act="unlink">Unlink</button></p>
          <p class="hint">In the chat: <code>/status</code> buys at or near a level · <code>/summary</code> portfolio today · <code>/mute 8</code> pause for 8 h · <code>/unmute</code></p>`
      : st.pairing ? `<p>${st.pairing.link ? `<a class="btn primary" href="${esc(st.pairing.link)}" target="_blank" rel="noopener noreferrer">Open ${bot} in Telegram</a> and press <b>Start</b> — or ` : ""}send <code>/start ${esc(st.pairing.code)}</code> to ${bot || "your bot"}.
            <span class="hint">Waiting… (code valid 10 minutes)</span></p>`
      : `<p><button class="btn primary" data-act="link">Link my Telegram</button> <span class="hint">Only the chat that sends the one-time code gets alerts; messages from anyone else are ignored.</span></p>`;
    const step3 = `<div class="tgx-grid">
        <label class="ctl"><input type="checkbox" data-cfg="enabled" ${c.enabled ? "checked" : ""}> Alerts on</label>
        ${EV.map(([k, l]) => `<label class="ctl"><input type="checkbox" data-ev="${k}" ${ev[k] ? "checked" : ""}> ${l}</label>`).join("")}
      </div>
      <div class="row tgx-row">
        <label class="field">Check every (min)<input type="number" min="5" max="1440" step="5" data-cfg="interval_min" value="${c.interval_min ?? 15}"></label>
        <label class="field" title="Empty = the 'Near' setting of this tab">Near within (%)<input type="number" min="0.5" max="50" step="0.5" data-cfg="near_pct" value="${c.near_pct ?? ""}" placeholder="tab setting"></label>
        <label class="field">Earnings: days before<input type="number" min="0" max="30" data-cfg="earn_days" value="${c.earn_days ?? 3}"></label>
        <label class="field" title="Don't repeat the same alert for the same buy within this many hours">Repeat after (h)<input type="number" min="0" max="168" data-cfg="cooldown_h" value="${c.cooldown_h ?? 12}"></label>
        <label class="field">Daily summary at<input type="time" data-cfg="summary_time" value="${c.summary_time || ""}"></label>
        <label class="field grow" title="Link at the end of each alert">Link in messages<input type="text" data-cfg="app_url" value="${esc(c.app_url || "")}" placeholder="${esc(location.origin)}"></label>
      </div>`;
    const logHtml = (st.log || []).length ? `<table class="grid tgx-log"><tbody>${st.log.slice(0, 8).map((x) => `<tr><td class="sub">${ago(x.t)}</td><td>${esc(x.kind)}</td>
        <td>${esc((x.text || "").replace(/<[^>]+>/g, "").split("\n")[0])}</td><td class="${x.ok ? "up" : "warn-t"}">${x.ok ? "sent" : esc(x.err || "failed")}</td></tr>`).join("")}</tbody></table>` : `<p class="hint">Nothing sent yet.</p>`;
    box.querySelector(".tgx-body").innerHTML = `
      <div class="tgx-err callout warn" hidden></div>
      <div class="tgx-cols"><div><h4>1 · Bot</h4>${step1}</div><div><h4>2 · Your chat</h4>${step2}</div></div>
      <h4>3 · What to send</h4>${step3}
      <h4>Recent</h4>${logHtml}
      <p class="hint">The Pi checks with the same rules as this tab, also when no browser is open, and only sends <b>changes</b> (a buy that reaches its target, stop, a breakout…), not the same alert every check.</p>`;
  }

  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act;
    if (act === "token") {
      const v = box.querySelector(".tgx-token").value.trim();
      if (v) { b.disabled = true; await call("/api/alerts/token", "POST", { token: v }); b.disabled = false; }
    } else if (act === "rmtoken") {
      if (confirm("Remove the bot token? Alerts stop and the chat is unlinked.")) call("/api/alerts/token", "POST", { token: "" });
    } else if (act === "link") {
      if (await call("/api/alerts/link")) {
        if (!st.config.app_url) await call("/api/alerts/config", "PUT", { app_url: location.origin });
        load();
      }
    } else if (act === "unlink") {
      if (confirm("Unlink this chat?")) call("/api/alerts/unlink");
    } else if (act === "test") {
      b.disabled = true; await call("/api/alerts/test"); b.disabled = false;
    } else if (act === "check") {
      b.disabled = true;
      try { const r = await api("/api/alerts/check", { method: "POST" }); st = r; draw(); box.querySelector(".tgx-err").hidden = false; box.querySelector(".tgx-err").textContent = r.sent ? `Sent ${r.sent} alert${r.sent > 1 ? "s" : ""}.` : "Nothing new to send."; }
      catch (err) { box.querySelector(".tgx-err").textContent = err.message; box.querySelector(".tgx-err").hidden = false; }
      b.disabled = false;
    }
  });
  box.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.ev) return call("/api/alerts/config", "PUT", { events: { [el.dataset.ev]: el.checked } });
    const k = el.dataset.cfg; if (!k) return;
    let v = el.type === "checkbox" ? el.checked : el.value.trim();
    if (["interval_min", "earn_days", "cooldown_h", "near_pct"].includes(k)) v = v === "" ? null : +v;
    if (k === "summary_time" && v === "") v = "";
    call("/api/alerts/config", "PUT", { [k]: v });
  });
  box.addEventListener("toggle", () => { if (box.open) load(); });

  function refresh() { if (!st || box.open) load(); }
  return { refresh };
};
