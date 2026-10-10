/* stonks-dash — "Market hours" view: live open/closed status, countdowns and a 24h session timeline. */
window.StonksHours = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, fmtPct, fmtPrice, cls, makeColor, showTip, moveTip, hideTip, $, $$ } = ctx;

  const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const REGION_ORDER = ["Asia-Pacific", "Middle East & Africa", "Europe", "Americas", "24h markets"];
  const H = 3600_000;
  const STATUS = {
    open: { label: "Open", cls: "st-open" },
    break: { label: "Lunch break", cls: "st-warn" },
    pre: { label: "Pre-market", cls: "st-ext" },
    post: { label: "After-hours", cls: "st-ext" },
    closed: { label: "Closed", cls: "st-closed" },
    holiday: { label: "Holiday", cls: "st-closed" },
    always: { label: "Open 24/7", cls: "st-open" },
    nodata: { label: "No calendar", cls: "st-closed" },
  };

  let data = null;        // /api/sessions payload
  let quotes = {};        // symbol -> quote
  let skew = 0;           // server clock - browser clock (ms)
  let ticker = null;
  let fetchedDay = null;
  const board = $("#h-board");

  const now = () => Date.now() + skew;
  const tzMode = () => state.settings.hours_tz || "mine";
  const winMode = () => state.settings.hours_window || "today";

  // ------------------------------------------------------------------ formatting
  const fmtCache = new Map();
  function fmt(ms, tz, opts) {
    const key = tz + JSON.stringify(opts);
    let f = fmtCache.get(key);
    if (!f) { f = new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }); fmtCache.set(key, f); }
    return f.format(new Date(ms));
  }
  const hm = (ms, tz) => fmt(ms, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  const isoDay = (ms, tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const tzAbbr = (tz, ms) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms))
        .find((p) => p.type === "timeZoneName")?.value || tz;
    } catch { return tz; }
  };
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(mm).padStart(2, "0")}m`;
    return `${mm}m`;
  }
  const dispTz = (ex) => (tzMode() === "local" && ex.tz ? ex.tz : MY_TZ);

  // ------------------------------------------------------------------ status engine
  function statusOf(ex, t) {
    if (ex.always_open) return { key: "always", next: null };
    if (!ex.sessions.length && !ex.tz) return { key: "nodata", next: null };
    const cur = ex.sessions.find((s) => s.o <= t && t < s.c);
    if (cur) {
      if (cur.bs && cur.bs <= t && t < cur.be) return { key: "break", next: { at: cur.be, verb: "Reopens" }, session: cur };
      if (cur.bs && t < cur.bs) return { key: "open", next: { at: cur.bs, verb: "Lunch in", rel: true }, session: cur, closeAt: cur.c };
      return { key: "open", next: { at: cur.c, verb: "Closes" }, session: cur };
    }
    const upcoming = ex.sessions.find((s) => s.o > t);
    const ext = ex.ext.find((e) => e.s <= t && t < e.e);
    const nxt = upcoming ? { at: upcoming.o, verb: "Opens" } : null;
    if (ext) return { key: ext.k, next: ext.k === "pre" ? nxt : { at: ext.e, verb: "Ends" }, session: upcoming };
    const today = ex.tz ? isoDay(t, ex.tz) : null;
    const hol = today && ex.holidays.find((h) => h.date === today);
    if (hol) return { key: "holiday", holiday: hol.name, next: nxt, session: upcoming };
    return { key: "closed", next: nxt, session: upcoming };
  }

  function nextText(st, t, tz) {
    if (st.key === "always") return "Never closes";
    if (!st.next) return st.key === "nodata" ? "Rebuild to update calendars" : "No session in the next 3 weeks";
    const left = st.next.at - t;
    if (left < 20 * H) return `${st.next.verb === "Lunch in" ? "Lunch in" : st.next.verb + " in"} ${dur(left)}`;
    const when = fmt(st.next.at, tz, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return `${st.next.verb} ${when}`;
  }

  // ------------------------------------------------------------------ window
  function windowRange() {
    if (winMode() === "rolling") {
      const s = Math.floor((now() - 3 * H) / H) * H;
      return [s, s + 24 * H];
    }
    const d = new Date(now());
    d.setHours(0, 0, 0, 0);
    return [d.getTime(), d.getTime() + 24 * H];
  }

  // ------------------------------------------------------------------ load
  async function load(silent) {
    if (!silent && !data) board.innerHTML = `<div class="loading">Loading calendars…</div>`;
    const t0 = Date.now();
    const d = await api("/api/sessions");
    skew = d.now - Math.round((t0 + Date.now()) / 2);
    data = d;
    fetchedDay = new Date().toDateString();
    draw();
    ctx.stamp(d.now / 1000);
    loadQuotes();
    if (!ticker) ticker = setInterval(tick, 1000);
  }
  async function loadQuotes() {
    if (!data) return;
    const syms = data.exchanges.map((e) => e.index).filter(Boolean);
    try {
      quotes = await api(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
      if (state.view === "hours") drawIndexCells();
    } catch (e) { console.warn("index quotes", e); }
  }

  // ------------------------------------------------------------------ render
  function sortedGroups() {
    const t = now();
    const [ws] = windowRange();
    const groups = d3.groups(data.exchanges, (e) => e.region)
      .sort((a, b) => REGION_ORDER.indexOf(a[0]) - REGION_ORDER.indexOf(b[0]));
    for (const g of groups) {
      // within a region: in the order they open during the visible day
      const key = (e) => {
        const s = e.sessions.find((x) => x.c > ws) || e.sessions.find((x) => x.c > t);
        return s ? ((s.o - ws) % (24 * H) + 24 * H) % (24 * H) : 1e15;
      };
      g[1].sort((a, b) => key(a) - key(b));
    }
    return groups;
  }

  function hoursText(ex, st) {
    if (ex.always_open) return "24 / 7";
    const s = st.session || ex.sessions.find((x) => x.c > now());
    if (!s) return "—";
    const tz = dispTz(ex);
    let txt = `${hm(s.o, tz)} – ${hm(s.c, tz)}`;
    if (s.bs) txt += ` <span class="sub">lunch ${hm(s.bs, tz)}–${hm(s.be, tz)}</span>`;
    if (s.early) txt += ` <span class="pill warn">early close</span>`;
    const multiDay = s.c - s.o > 24 * H;
    if (multiDay) txt = `${fmt(s.o, tz, { weekday: "short" })} ${hm(s.o, tz)} – ${fmt(s.c, tz, { weekday: "short" })} ${hm(s.c, tz)}`;
    return txt;
  }

  function draw() {
    if (!data) return;
    syncControls();
    const [ws, we] = windowRange();
    const span = we - ws;
    const mobile = matchMedia("(max-width: 720px)").matches;
    const trackPx = Math.max(board.clientWidth - (mobile ? 0 : 420), 100);
    const fits = (wPct, text) => (wPct / 100) * trackPx > text.length * 6.4 + 12;
    const pct = (ms) => ((Math.min(Math.max(ms, ws), we) - ws) / span) * 100;
    const t = now();

    // axis ticks every hour, labels every 3h (in my timezone)
    let axis = "";
    for (let h = Math.ceil(ws / H) * H; h < we; h += H) {
      const lbl = new Date(h).getHours();
      const major = lbl % 3 === 0 && (!mobile || lbl % 6 === 0);
      const edge = h === ws ? "first" : "";
      axis += `<span class="tick ${major ? "major" : ""} ${edge}" style="left:${pct(h)}%">${major ? String(lbl).padStart(2, "0") + ":00" : ""}</span>`;
    }
    const grid = Array.from({ length: 23 }, (_, i) => `<i style="left:${((i + 1) / 24) * 100}%"></i>`).join("");

    let html = `<div class="hrow hhead"><div class="hinfo"><span class="hint">Market</span></div>
      <div class="htrack axis">${axis}</div><div class="hidx hint">Index 1D</div></div>`;
    for (const [region, list] of sortedGroups()) {
      html += `<div class="hregion">${esc(region)}</div>`;
      for (const ex of list) {
        const st = statusOf(ex, t);
        const bars = [];
        if (ex.always_open) {
          bars.push(`<div class="bar reg" style="left:0;width:100%"><span>24/7</span></div>`);
        }
        for (const e of ex.ext) {
          if (e.e <= ws || e.s >= we) continue;
          bars.push(`<div class="bar ext" data-k="${e.k}" style="left:${pct(e.s)}%;width:${pct(e.e) - pct(e.s)}%" data-tip="${e.k}|${e.s}|${e.e}"></div>`);
        }
        for (const s of ex.sessions) {
          if (s.c <= ws || s.o >= we) continue;
          const parts = s.bs ? [[s.o, s.bs], [s.be, s.c]] : [[s.o, s.c]];
          for (const [a, b] of parts) {
            if (b <= ws || a >= we) continue;
            const w = pct(b) - pct(a);
            const tz = dispTz(ex);
            const text = b - a > 24 * H
              ? `${fmt(a, tz, { weekday: "short" })} ${hm(a, tz)} → ${fmt(b, tz, { weekday: "short" })} ${hm(b, tz)}`
              : `${hm(a, tz)}–${hm(b, tz)}`;
            const lbl = fits(w, text) ? `<span>${esc(text)}</span>` : "";
            bars.push(`<div class="bar reg ${s.early ? "early" : ""}" style="left:${pct(a)}%;width:${w}%" data-tip="reg|${s.o}|${s.c}|${s.bs || ""}|${s.be || ""}">${lbl}</div>`);
          }
        }
        // holidays: a hatched block where the regular session would have been
        const ref = ex.sessions.find((s) => !s.early) || ex.sessions[0];
        for (const h of ref && ex.tz ? ex.holidays : []) {
          const shift = Math.round((Date.parse(h.date) - Date.parse(isoDay(ref.o, ex.tz))) / (24 * H)) * 24 * H;
          const a = ref.o + shift, b = ref.c + shift;
          if (b <= ws || a >= we) continue;
          const w = pct(b) - pct(a);
          const text = fits(w, `Holiday · ${h.name}`) ? `Holiday · ${h.name}` : fits(w, "Holiday") ? "Holiday" : "";
          bars.push(`<div class="bar holb" style="left:${pct(a)}%;width:${w}%" title="${esc(h.name)}"><span>${esc(text)}</span></div>`);
        }
        const S = STATUS[st.key];
        html += `<div class="hrow" data-code="${ex.code}">
          <div class="hinfo">
            <div class="hname"><b>${esc(ex.name)}</b><span class="sub">${esc(ex.city)}${ex.tz ? " · " + esc(tzAbbr(ex.tz, t)) : ""}</span></div>
            <div class="hstat"><span class="st ${S.cls}" data-st>${st.key === "holiday" ? "Holiday" : S.label}</span>
              <span class="cd" data-cd>${esc(nextText(st, t, dispTz(ex)))}</span></div>
            <div class="hhours sub">${hoursText(ex, st)}${ex.stale ? ' <span class="pill warn" title="Holiday data in this image ends soon — rebuild with --pull">calendar outdated</span>' : ""}${st.holiday ? ` <span class="pill">${esc(st.holiday)}</span>` : ""}</div>
          </div>
          <div class="htrack">${grid}${bars.join("")}<div class="past"></div><div class="nowl"></div></div>
          <div class="hidx" data-idx="${esc(ex.index || "")}"></div>
        </div>`;
      }
    }
    board.innerHTML = html;
    drawIndexCells();
    drawUpcoming();
    tick();
  }

  function drawIndexCells() {
    if (!data) return;
    const color = makeColor(3);
    for (const cell of $$(".hidx[data-idx]", board)) {
      const q = quotes[cell.dataset.idx];
      const v = q?.ok ? q.changes?.["1D"] : null;
      cell.innerHTML = q?.ok
        ? `<span class="idx-sym">${esc(cell.dataset.idx.replace(/^\^/, ""))}</span><span class="idx-chg" style="background:${color(v) || "#2a2e39"}">${fmtPct(v)}</span>`
        : `<span class="idx-sym">${esc(cell.dataset.idx.replace(/^\^/, ""))}</span><span class="idx-chg na">—</span>`;
    }
  }

  function drawUpcoming() {
    const t = now();
    const horizon = t + 14 * 24 * H;
    const rows = [];
    for (const ex of data.exchanges) {
      for (const h of ex.holidays) {
        const at = Date.parse(h.date + "T12:00:00Z");
        if (at >= t - 12 * H && at <= horizon) rows.push({ at, date: h.date, ex, what: `Closed — ${h.name}`, kind: "closed" });
      }
      for (const e of ex.early) {
        if (e.close >= t - 12 * H && e.close <= horizon) {
          rows.push({ at: e.close, date: e.date, ex, what: `Early close ${hm(e.close, dispTz(ex))}`, kind: "early" });
        }
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.ex.name.localeCompare(b.ex.name));
    const tb = $("#h-upcoming tbody");
    const dfmt = (iso) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z"));
    tb.innerHTML = rows.length ? rows.map((r) => `<tr>
        <td>${dfmt(r.date)}</td><td><b>${esc(r.ex.name)}</b> <span class="sub">${esc(r.ex.city)}</span></td>
        <td><span class="pill ${r.kind === "early" ? "warn" : ""}">${r.kind === "early" ? "Early close" : "Closed"}</span> ${esc(r.what.replace(/^Closed — /, ""))}</td></tr>`).join("")
      : `<tr><td colspan="3" class="hint">No holidays or early closes in the next 14 days for the selected markets.</td></tr>`;
  }

  // ------------------------------------------------------------------ live tick (1 s)
  function tick() {
    if (!data || state.view !== "hours") return;
    if (new Date().toDateString() !== fetchedDay) { load(true); return; }
    const t = now();
    const [ws, we] = windowRange();
    if (winMode() === "rolling" && t - ws > 4 * H) { draw(); return; }
    const p = Math.min(Math.max((t - ws) / (we - ws), 0), 1) * 100;
    board.style.setProperty("--nowpct", `${p}%`);
    $("#h-clock").textContent = fmt(t, MY_TZ, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    $("#h-date").textContent = fmt(t, MY_TZ, { weekday: "long", day: "numeric", month: "long" });
    $("#h-tz").textContent = `${MY_TZ} (${tzAbbr(MY_TZ, t)})`;
    const counts = { open: 0, break: 0, ext: 0, closed: 0 };
    let changed = false;
    for (const ex of data.exchanges) {
      const row = board.querySelector(`.hrow[data-code="${ex.code}"]`);
      if (!row) continue;
      const st = statusOf(ex, t);
      const S = STATUS[st.key];
      const pill = row.querySelector("[data-st]");
      const label = st.key === "holiday" ? "Holiday" : S.label;
      if (pill.textContent !== label) { changed = true; }
      row.querySelector("[data-cd]").textContent = nextText(st, t, dispTz(ex));
      row.classList.toggle("is-open", st.key === "open" || st.key === "always");
      if (st.key === "open" || st.key === "always") counts.open++;
      else if (st.key === "break") counts.break++;
      else if (st.key === "pre" || st.key === "post") counts.ext++;
      else counts.closed++;
    }
    $("#h-summary").innerHTML = `<span><b class="up">● ${counts.open}</b> open</span>` +
      (counts.break ? `<span><b class="warn-t">● ${counts.break}</b> lunch</span>` : "") +
      (counts.ext ? `<span><b class="ext-t">● ${counts.ext}</b> extended</span>` : "") +
      `<span><b class="muted-t">● ${counts.closed}</b> closed</span>`;
    if (changed) draw(); // a market just opened/closed: refresh pills, hours and ordering
  }

  // ------------------------------------------------------------------ tooltip on bars
  board.addEventListener("mousemove", (e) => {
    const bar = e.target.closest(".bar[data-tip]");
    if (!bar) return hideTip();
    const row = bar.closest(".hrow");
    const ex = data.exchanges.find((x) => x.code === row.dataset.code);
    const [k, a, b, bs, be] = bar.dataset.tip.split("|");
    const both = (ms) => `${hm(+ms, MY_TZ)} <span class="sub">your time</span> · ${hm(+ms, ex.tz)} <span class="sub">${esc(tzAbbr(ex.tz, +ms))}</span>`;
    const title = k === "pre" ? "Pre-market" : k === "post" ? "After-hours" : "Regular session";
    const html = `<div class="tt-head"><span class="tt-sym">${esc(ex.name)}</span><span class="tt-type">${title}</span></div>
      <div class="tt-name">${esc(fmt(+a, ex.tz, { weekday: "long", day: "numeric", month: "short" }))}</div>
      <dl><dt>Opens</dt><dd>${both(a)}</dd><dt>Closes</dt><dd>${both(b)}</dd>
      ${bs ? `<dt>Lunch</dt><dd>${hm(+bs, MY_TZ)}–${hm(+be, MY_TZ)} <span class="sub">your time</span></dd>` : ""}
      <dt>Length</dt><dd>${dur(+b - +a - (bs ? +be - +bs : 0))}</dd></dl>`;
    if (tip.hidden || tip.dataset.key !== bar.dataset.tip) { showTip(html, e); tip.dataset.key = bar.dataset.tip; } else moveTip(e);
  });
  board.addEventListener("mouseleave", hideTip);
  const tip = document.getElementById("tooltip");

  // ------------------------------------------------------------------ controls
  function syncControls() {
    $$("#h-tzmode button").forEach((b) => b.classList.toggle("active", b.dataset.v === tzMode()));
    $$("#h-window button").forEach((b) => b.classList.toggle("active", b.dataset.v === winMode()));
  }
  $("#h-tzmode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    saveSettings({ hours_tz: b.dataset.v }); draw();
  });
  $("#h-window").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    saveSettings({ hours_window: b.dataset.v }); draw();
  });

  const dlg = $("#dlg-hours");
  $("#h-choose").addEventListener("click", () => {
    if (!data) return;
    const sel = new Set(data.selected);
    const groups = d3.groups(data.catalog, (c) => c.region).sort((a, b) => REGION_ORDER.indexOf(a[0]) - REGION_ORDER.indexOf(b[0]));
    $("#h-catalog").innerHTML = groups.map(([r, list]) => `<fieldset><legend>${esc(r)}</legend>${list.map((c) =>
      `<label class="check"><input type="checkbox" value="${c.code}" ${sel.has(c.code) ? "checked" : ""}> ${esc(c.name)} <span class="sub">${esc(c.city)}</span></label>`).join("")}</fieldset>`).join("");
    dlg.showModal();
  });
  $("#h-save").addEventListener("click", async () => {
    const codes = $$("#h-catalog input:checked").map((i) => i.value);
    await saveSettings({ sessions_exchanges: codes });
    dlg.close();
    data = null;
    load(false);
  });

  return { load, draw, loaded: () => !!data, refreshQuotes: loadQuotes };
};
