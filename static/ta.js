/* stonks-dash — Analysis: interactive technical-analysis chart for any ticker.
 * Chart: TradingView Lightweight Charts (static/vendor, Apache-2.0). Indicator math: static/ta-ind.js (window.TA).
 * Everything is recomputed in the browser from daily OHLCV (/api/ta), so parameters change instantly. */
window.StonksTA = function (ctx) {
  "use strict";
  const { api, esc, state, saveSettings, fmtDate, attachSearch, $, $$ } = ctx;
  const L = window.LightweightCharts, T = window.TA;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C = {
    up: "#26a69a", down: "#ef5350", ma: ["#f5c542", "#3987e5", "#e05aa8", "#b388ff"], bb: "#7e8a9e", kc: "#4dd0e1",
    dc: "#90a4ae", ichi: { t: "#2196f3", k: "#ff7043", a: "#66bb6a", b: "#ef5350", c: "#ab47bc" }, sar: "#ffd54f",
    st: ["#26a69a", "#ef5350"], vwap: "#ffa726", res: "#ef5350", sup: "#26a69a", piv: "#9fa8da", fib: "#ffb74d",
    hl52: "#bdbdbd", mine: "#2962ff", stop: "#ef5350", target: "#26a69a", draw: "#e0e0e0",
  };

  // ------------------------------------------------------------------ indicator registry
  // params: [key, label, default, min, max, step]
  const P = (k, l, d, min = 1, max = 500, step = 1) => ({ k, l, d, min, max, step });
  const MA_TYPES = ["SMA", "EMA", "WMA", "HMA", "DEMA", "TEMA", "KAMA"];
  const IND = [
    { key: "ma1", g: "Overlays", l: "Moving average 1", on: true, ma: true, p: [P("n", "Length", 20)], type: "SMA", color: C.ma[0] },
    { key: "ma2", g: "Overlays", l: "Moving average 2", on: true, ma: true, p: [P("n", "Length", 50)], type: "SMA", color: C.ma[1] },
    { key: "ma3", g: "Overlays", l: "Moving average 3", on: true, ma: true, p: [P("n", "Length", 200)], type: "SMA", color: C.ma[2] },
    { key: "ma4", g: "Overlays", l: "Moving average 4", on: false, ma: true, p: [P("n", "Length", 9)], type: "EMA", color: C.ma[3] },
    { key: "bb", g: "Overlays", l: "Bollinger Bands", on: true, p: [P("n", "Length", 20), P("k", "StdDev", 2, 0.5, 5, 0.1)] },
    { key: "kc", g: "Overlays", l: "Keltner Channels", on: false, p: [P("n", "EMA", 20), P("m", "× ATR", 2, 0.5, 5, 0.1), P("a", "ATR", 10)] },
    { key: "dc", g: "Overlays", l: "Donchian Channels", on: false, p: [P("n", "Length", 20)] },
    { key: "ichi", g: "Overlays", l: "Ichimoku Cloud", on: false, p: [P("a", "Conversion", 9), P("b", "Base", 26), P("c", "Span B", 52)] },
    { key: "sar", g: "Overlays", l: "Parabolic SAR", on: false, p: [P("s", "Step", 0.02, 0.001, 0.2, 0.001), P("m", "Max", 0.2, 0.01, 1, 0.01)] },
    { key: "st", g: "Overlays", l: "Supertrend", on: false, p: [P("n", "ATR", 10), P("m", "Factor", 3, 0.5, 10, 0.1)] },
    { key: "vwap", g: "Overlays", l: "Anchored VWAP", on: false, vol: true, p: [], hint: "Anchor with the ⚓ tool (default: first bar shown)" },
    { key: "env", g: "Overlays", l: "MA Envelopes", on: false, p: [P("n", "SMA", 20), P("pct", "± %", 2.5, 0.1, 50, 0.1)] },
    { key: "ribbon", g: "Overlays", l: "MA Ribbon (Guppy GMMA)", on: false, p: [], hint: "EMAs 3–15 (traders, green) and 30–60 (investors, red)" },
    { key: "alli", g: "Overlays", l: "Williams Alligator", on: false, p: [P("j", "Jaw", 13), P("t", "Teeth", 8), P("l", "Lips", 5)], hint: "Smoothed MAs of the median price, shifted 8 / 5 / 3 bars ahead" },
    { key: "chand", g: "Overlays", l: "Chandelier Exit", on: false, p: [P("n", "Length", 22), P("k", "× ATR", 3, 0.5, 10, 0.1)], hint: "Long exit: highest high − k·ATR (green). Short exit: lowest low + k·ATR (red)" },
    { key: "atrts", g: "Overlays", l: "ATR trailing stop", on: false, p: [P("n", "ATR", 14), P("k", "× ATR", 3, 0.5, 10, 0.1)] },
    { key: "lrf", g: "Overlays", l: "Linear regression forecast", on: false, p: [P("n", "Length", 20)], hint: "Rolling least-squares end point (LSMA)" },
    { key: "lrc", g: "Overlays", l: "Linear regression channel", on: false, p: [P("n", "Last bars", 100, 10, 5000), P("k", "StdDev", 2, 0.5, 5, 0.1)] },
    { key: "zz", g: "Overlays", l: "ZigZag", on: false, p: [P("pct", "Reversal %", 5, 0.5, 50, 0.5)], hint: "The last leg is provisional until price reverses by the %" },
    { key: "vbp", g: "Overlays", l: "Volume-by-price (visible range)", on: false, vol: true, p: [P("b", "Rows", 24, 6, 80)], hint: "Volume traded at each price level in the bars on screen; green = up bars, red = down bars; outlined = point of control" },
    { key: "elder", g: "Overlays", l: "Elder Impulse colours", on: false, p: [], hint: "Bars green when EMA 13 and the MACD histogram both rise, red when both fall, blue otherwise" },
    { key: "zones", g: "Levels", l: "Support / resistance zones", on: true, p: [], hint: "Same zones as Sell targets (daily closes, 3 years)" },
    { key: "piv", g: "Levels", l: "Pivot points (previous period)", on: false, p: [], hint: "Classic floor pivots from last month (daily), last year (weekly/monthly)" },
    { key: "fib", g: "Levels", l: "Auto Fibonacci (visible range)", on: false, p: [] },
    { key: "hl52", g: "Levels", l: "52-week high / low", on: true, p: [] },
    { key: "cross", g: "Levels", l: "Golden / death cross markers", on: true, p: [], hint: "50 / 200-bar SMA crosses" },
    { key: "mine", g: "Levels", l: "My buys, avg cost, stop & target", on: true, p: [] },
    { key: "cdl", g: "Patterns", l: "Candlestick patterns", on: false, p: [P("bars", "Last bars", 250, 10, 5000)], hint: "About 40 patterns (engulfing, hammer, stars, harami, soldiers/crows, tasuki, three methods…). Hover a bar to see their names in the legend." },
    { key: "cdlI", g: "Patterns", l: "… also doji & spinning tops", on: false, p: [] },
    { key: "gaps", g: "Patterns", l: "Gaps (shaded until filled)", on: false, p: [P("min", "Min %", 0.5, 0, 20, 0.1)] },
    { key: "cpat", g: "Patterns", l: "Chart patterns (experimental)", on: false, p: [P("pct", "Swing %", 0, 0, 50, 0.5)], hint: "Double/triple tops & bottoms, head & shoulders, triangles, wedges, rectangles, flags & pennants from ZigZag swings (Swing % 0 = automatic). Heuristic: always check by eye." },
    { key: "vol", g: "Panes", l: "Volume", on: true, vol: true, p: [P("n", "Avg", 20)], overlayPane: true },
    { key: "rsi", g: "Panes", l: "RSI", on: true, p: [P("n", "Length", 14), P("ob", "Overbought", 70, 50, 100), P("os", "Oversold", 30, 0, 50)] },
    { key: "macd", g: "Panes", l: "MACD", on: true, p: [P("f", "Fast", 12), P("s", "Slow", 26), P("g", "Signal", 9)] },
    { key: "stoch", g: "Panes", l: "Stochastic", on: false, p: [P("n", "%K", 14), P("k", "Smooth", 3), P("d", "%D", 3)] },
    { key: "adx", g: "Panes", l: "ADX / DMI", on: false, p: [P("n", "Length", 14)] },
    { key: "atr", g: "Panes", l: "ATR", on: false, p: [P("n", "Length", 14)] },
    { key: "obv", g: "Panes", l: "On-balance volume", on: false, vol: true, p: [P("n", "Signal", 20)] },
    { key: "mfi", g: "Panes", l: "Money Flow Index", on: false, vol: true, p: [P("n", "Length", 14)] },
    { key: "cmf", g: "Panes", l: "Chaikin Money Flow", on: false, vol: true, p: [P("n", "Length", 20)] },
    { key: "cci", g: "Panes", l: "CCI", on: false, p: [P("n", "Length", 20)] },
    { key: "wr", g: "Panes", l: "Williams %R", on: false, p: [P("n", "Length", 14)] },
    { key: "roc", g: "Panes", l: "Rate of change", on: false, p: [P("n", "Length", 12)] },
  ];
  const byKey = Object.fromEntries(IND.map((x) => [x.key, x]));

  // ------------------------------------------------------------------ settings
  const S = () => state.settings.ta || (state.settings.ta = {});
  let saveT;
  function saveTA(patch) {
    Object.assign(S(), patch);
    clearTimeout(saveT);
    saveT = setTimeout(() => saveSettings({ ta: { ...S() } }), 400);
  }
  const cfg = (k) => {
    const d = byKey[k], s = (S().ind || {})[k] || {};
    const p = Object.fromEntries(d.p.map((x) => [x.k, s[x.k] ?? x.d]));
    return { on: s.on ?? d.on, ...p, type: s.type || d.type };
  };
  function setCfg(k, patch) { const ind = { ...(S().ind || {}) }; ind[k] = { ...(ind[k] || {}), ...patch }; saveTA({ ind }); }
  const view = () => ({ sym: S().symbol || null, iv: S().interval || "D", range: S().range || "1Y", type: S().type || "candles", log: !!S().log });
  const drawings = () => ((S().drawings || {})[view().sym] || []);
  function setDrawings(list) { saveTA({ drawings: { ...(S().drawings || {}), [view().sym]: list } }); }

  // ------------------------------------------------------------------ data
  let raw = null, rawSym = null, rawYears = 0, loading = false;
  let chart = null, main = null, D = null, legends = [], tool = "cursor", pending = null, measureLine = null;

  async function load(sym, years) {
    years = years || (view().range === "All" ? 30 : 10);
    if (raw && rawSym === sym && rawYears >= years) return true;
    loading = true;
    $("#ta-head").innerHTML = `<span class="hint">Loading ${esc(sym)}…</span>`;
    try {
      raw = await api(`/api/ta?symbol=${encodeURIComponent(sym)}&years=${years}`);
      rawSym = sym; rawYears = years; loadedAt = Date.now();
      return true;
    } catch (e) {
      raw = null; rawSym = null;
      $("#ta-head").innerHTML = `<span class="down">${esc(e.message)}</span>`;
      if (chart) { chart.remove(); chart = null; }
      $("#ta-signals").innerHTML = "";
      return false;
    } finally { loading = false; }
  }

  // derived data for the current interval
  function prepare() {
    const bars = T.resample(raw.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), view().iv);
    const t = bars.map((b) => b.t), o = bars.map((b) => b.o), h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c), v = bars.map((b) => b.v);
    return { bars, t, o, h, l, c, v, n: bars.length, hasVol: raw.has_volume, crypto: raw.quote_type === "CRYPTOCURRENCY" };
  }
  const per52 = () => ({ D: 252, W: 52, M: 12 })[view().iv];
  function futureTimes(k) {
    const out = [], last = new Date(D.t[D.n - 1] + "T00:00:00Z");
    const d = new Date(last);
    while (out.length < k) {
      if (view().iv === "M") d.setUTCMonth(d.getUTCMonth() + 1, 1);
      else if (view().iv === "W") d.setUTCDate(d.getUTCDate() + 7);
      else { d.setUTCDate(d.getUTCDate() + 1); if (!D.crypto && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue; }
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  const maFn = (type) => ({ SMA: T.sma, EMA: T.ema, WMA: T.wma, HMA: T.hma, DEMA: T.dema, TEMA: T.tema, KAMA: T.kama })[type] || T.sma;
  function idxOnOrBefore(date) {
    let lo = 0, hi = D.n - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (D.t[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  // ------------------------------------------------------------------ formatting
  const dec = (p) => (p === 0 || p >= 10 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 6);
  const fp = (x) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(undefined, { minimumFractionDigits: dec(Math.abs(x)), maximumFractionDigits: dec(Math.abs(x)) }));
  const fn = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fv = (x) => (x == null ? "—" : Math.abs(x) >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : `${Math.round(x)}`);
  const ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
  const pp = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`);
  const fb = (x) => (x == null || !isFinite(x) ? "—" : x.toLocaleString(undefined, { maximumFractionDigits: 4 }));   // box / reversal sizes
  const pc = (x, d = 2) => (x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);

  const LOCALE = (() => { try { return Intl.getCanonicalLocales(navigator.language)[0]; } catch { return "en-US"; } })();

  // ------------------------------------------------------------------ chart building
  function lineOpts(color, extra = {}) {
    return { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra };
  }
  const pts = (vals, times = D.t) => vals.map((v, i) => (v == null || !isFinite(v) ? { time: times[i] } : { time: times[i], value: v })).filter((p, i) => times[i]);

  // fresh = new symbol / interval / range: show the selected range instead of keeping the current zoom
  function build(fresh = false) {
    const el = $("#ta-chart");
    if (!raw || !el) return;
    let keep = null;
    if (chart) { if (!fresh) try { keep = chart.timeScale().getVisibleLogicalRange(); } catch {} chart.remove(); chart = null; }
    lines = []; drawn = []; measureLine = null; markerApi = null; legendState = null; main = null;
    legends.forEach((x) => x.remove()); legends = [];
    D = prepare();
    const vw = view();
    const alt = ALT.has(vw.type);
    el.hidden = alt; $("#ta-alt").hidden = !alt; $("#ta-altp").hidden = !alt; $("#ta-drawings").hidden = alt;
    $("#ta-tools").classList.toggle("disabled", alt); $("#ta-indbox").classList.toggle("dim", alt);
    computePatterns();
    if (alt) { altParams(); altRender(); signals(); return; }
    const bg = css("--bg") || "#0e1014", text = css("--muted") || "#8b92a1", border = css("--border") || "#272c37";
    const panesOn = IND.filter((x) => x.g === "Panes" && !x.overlayPane && cfg(x.key).on && !(x.vol && !D.hasVol));
    el.style.height = `${(window.innerWidth < 700 ? 360 : 440) + panesOn.length * 120}px`;
    chart = L.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: bg }, textColor: text, fontSize: 11, fontFamily: css("--font"),
        panes: { separatorColor: border, separatorHoverColor: "rgba(41,98,255,.4)", enableResize: true } },
      grid: { vertLines: { color: "rgba(255,255,255,.04)" }, horzLines: { color: "rgba(255,255,255,.04)" } },
      rightPriceScale: { borderColor: border }, timeScale: { borderColor: border, rightOffset: 6, minBarSpacing: 0.5 },
      crosshair: { mode: L.CrosshairMode.Normal },
      localization: { locale: LOCALE },
    });
    // main series
    const nFuture = Math.max(cfg("ichi").on ? cfg("ichi").b : 0, cfg("alli").on ? 8 : 0);
    const future = nFuture ? futureTimes(nFuture) : [];
    const tAll = D.t.concat(future);
    const ohlc = vw.type === "heikin" ? T.heikinAshi(D.o, D.h, D.l, D.c) : D;
    const imp = cfg("elder").on ? T.elderImpulse(D.c) : null, IMP = { 1: "#26a69a", "-1": "#ef5350", 0: "#42a5f5" };
    const candle = (i) => {
      const b = { time: D.t[i], open: ohlc.o[i], high: ohlc.h[i], low: ohlc.l[i], close: ohlc.c[i] };
      if (imp && imp[i] != null) { const col = IMP[imp[i]]; b.color = col; b.wickColor = col; b.borderColor = col; }
      return b;
    };
    const upDn = { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false };
    if (vw.type === "line") main = chart.addSeries(L.LineSeries, { color: css("--series-1") || "#3987e5", lineWidth: 2 });
    else if (vw.type === "area") main = chart.addSeries(L.AreaSeries, { lineColor: "#3987e5", topColor: "rgba(57,135,229,.35)", bottomColor: "rgba(57,135,229,0)", lineWidth: 2 });
    else if (vw.type === "bars") main = chart.addSeries(L.BarSeries, { upColor: C.up, downColor: C.down, thinBars: false });
    else main = chart.addSeries(L.CandlestickSeries, upDn);
    const mainData = vw.type === "line" || vw.type === "area" ? D.t.map((t, i) => ({ time: t, value: D.c[i] })) : D.t.map((_, i) => candle(i));
    main.setData(mainData.concat(future.map((t) => ({ time: t }))));
    const prec = dec(Math.abs(D.c[D.n - 1]));
    main.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
    main.priceScale().applyOptions({ mode: vw.log ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal, scaleMargins: { top: 0.06, bottom: cfg("vol").on && D.hasVol ? 0.22 : 0.06 } });

    const leg = { main: [], panes: [] };   // legend entries: {label, color, vals, fmt}
    const add = (vals, color, label, opts = {}, pane = 0, fmt = fp, times) => {
      const s = chart.addSeries(L.LineSeries, lineOpts(color, opts), pane);
      s.setData(pts(vals, times));
      if (label) (pane === 0 ? leg.main : leg.panes[pane - 1].items).push({ label, color, vals, fmt });
      return s;
    };

    // overlays
    for (const k of ["ma1", "ma2", "ma3", "ma4"]) {
      const x = cfg(k);
      if (x.on) add(maFn(x.type)(D.c, x.n), byKey[k].color, `${x.type} ${x.n}`, { lineWidth: 1.5 });
    }
    if (cfg("bb").on) {
      const x = cfg("bb"), b = T.bollinger(D.c, x.n, x.k);
      add(b.up, C.bb, `BB ${x.n},${x.k} up`, { lineStyle: 0 }); add(b.mid, C.bb, "mid", { lineStyle: 2 }); add(b.lo, C.bb, "low");
    }
    if (cfg("kc").on) {
      const x = cfg("kc"), b = T.keltner(D.h, D.l, D.c, x.n, x.m, x.a);
      add(b.up, C.kc, `KC up`); add(b.mid, C.kc, "KC mid", { lineStyle: 2 }); add(b.lo, C.kc, "KC low");
    }
    if (cfg("dc").on) {
      const x = cfg("dc"), b = T.donchian(D.h, D.l, x.n);
      add(b.up, C.dc, `DC ${x.n} up`); add(b.mid, C.dc, "DC mid", { lineStyle: 1 }); add(b.lo, C.dc, "DC low");
    }
    if (cfg("ichi").on) {
      const x = cfg("ichi"), r = T.ichimoku(D.h, D.l, D.c, x.a, x.b, x.c), sh = x.b;
      const fwd = (vals) => new Array(sh).fill(null).concat(vals);            // plotted `sh` bars ahead
      add(r.tenkan, C.ichi.t, `Tenkan ${x.a}`); add(r.kijun, C.ichi.k, `Kijun ${x.b}`);
      add(fwd(r.spanA), C.ichi.a, "Span A", { lineWidth: 1.5 }, 0, fp, tAll);
      add(fwd(r.spanB), C.ichi.b, "Span B", { lineWidth: 1.5 }, 0, fp, tAll);
      add(D.c.slice(sh), C.ichi.c, "Chikou", { lineStyle: 1 }, 0, fp, D.t.slice(0, D.n - sh));
      leg.main.find((e) => e.label === "Span A").vals = fwd(r.spanA);
      leg.main.find((e) => e.label === "Span B").vals = fwd(r.spanB);
      leg.main.find((e) => e.label === "Chikou").vals = D.c.slice(sh).concat(new Array(sh).fill(null));
    }
    if (cfg("sar").on) {
      const x = cfg("sar"), r = T.psar(D.h, D.l, x.s, x.m);
      const s = chart.addSeries(L.LineSeries, lineOpts(C.sar, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }));
      s.setData(r.sar.map((v, i) => (v == null ? { time: D.t[i] } : { time: D.t[i], value: v, color: r.up[i] ? C.up : C.down })));
      leg.main.push({ label: "SAR", color: C.sar, vals: r.sar, fmt: fp });
    }
    if (cfg("st").on) {
      const x = cfg("st"), r = T.supertrend(D.h, D.l, D.c, x.n, x.m);
      const s = chart.addSeries(L.LineSeries, lineOpts(C.st[0], { lineWidth: 1.5 }));
      s.setData(r.line.map((v, i) => (v == null ? { time: D.t[i] } : { time: D.t[i], value: v, color: r.up[i] ? C.st[0] : C.st[1] })));
      leg.main.push({ label: `Supertrend ${x.n},${x.m}`, color: C.st[0], vals: r.line, fmt: fp });
    }
    if (cfg("vwap").on && D.hasVol) {
      const a = (S().vwap_anchor || {})[vw.sym];
      const from = a ? Math.max(0, idxOnOrBefore(a)) : startIndexForRange();
      add(T.vwap(D.h, D.l, D.c, D.v, from), C.vwap, `VWAP ⚓ ${D.t[from]}`, { lineWidth: 1.5 });
    }
    if (cfg("env").on) {
      const x = cfg("env"), e = T.envelopes(D.c, x.n, x.pct);
      add(e.up, "#80cbc4", `Env +${x.pct}%`); add(e.mid, "#80cbc4", `SMA ${x.n}`, { lineStyle: 1 }); add(e.lo, "#80cbc4", `Env −${x.pct}%`);
    }
    if (cfg("ribbon").on) {
      for (const n of [3, 5, 8, 10, 12, 15]) add(T.ema(D.c, n), "rgba(38,166,154,.75)", null);
      for (const n of [30, 35, 40, 45, 50, 60]) add(T.ema(D.c, n), "rgba(239,83,80,.75)", null);
    }
    if (cfg("alli").on) {
      const x = cfg("alli"), r = T.alligator(D.h, D.l, x.j, x.t, x.l);
      const fwdK = (vals, k) => new Array(k).fill(null).concat(vals);
      add(fwdK(r.jaw, 8), "#2962ff", `Jaw ${x.j}`, { lineWidth: 1.5 }, 0, fp, tAll);
      add(fwdK(r.teeth, 5), "#ef5350", `Teeth ${x.t}`, { lineWidth: 1.5 }, 0, fp, tAll);
      add(fwdK(r.lips, 3), "#26a69a", `Lips ${x.l}`, { lineWidth: 1.5 }, 0, fp, tAll);
    }
    if (cfg("chand").on) {
      const x = cfg("chand"), r = T.chandelier(D.h, D.l, D.c, x.n, x.k);
      add(r.long, "#66bb6a", `Chandelier long`, { lineStyle: 2 }); add(r.short, "#ef5350", `Chandelier short`, { lineStyle: 2 });
    }
    if (cfg("atrts").on) {
      const x = cfg("atrts"), r = T.atrTrail(D.h, D.l, D.c, x.n, x.k);
      const s = chart.addSeries(L.LineSeries, lineOpts("#ffca28", { lineWidth: 1.5, lineStyle: 2 }));
      s.setData(r.stop.map((v, i) => (v == null ? { time: D.t[i] } : { time: D.t[i], value: v, color: r.up[i] ? C.up : C.down })));
      leg.main.push({ label: `ATR stop ${x.n}×${x.k}`, color: "#ffca28", vals: r.stop, fmt: fp });
    }
    if (cfg("lrf").on) add(T.linreg(D.c, cfg("lrf").n), "#ffee58", `LinReg ${cfg("lrf").n}`, { lineWidth: 1.5 });
    if (cfg("lrc").on) {
      const x = cfg("lrc"), a = Math.max(0, D.n - x.n), f = T.linFit(D.c, a, D.n - 1);
      if (f) for (const [k, st] of [[0, 0], [x.k, 2], [-x.k, 2]]) {
        const s = chart.addSeries(L.LineSeries, lineOpts("#ce93d8", { lineWidth: k ? 1 : 1.5, lineStyle: st, autoscaleInfoProvider: () => null }));
        s.setData([{ time: D.t[a], value: f.at(a) + k * f.sd }, { time: D.t[D.n - 1], value: f.at(D.n - 1) + k * f.sd }]);
      }
    }
    if (cfg("zz").on) {
      const zz = T.zigzag(D.h, D.l, cfg("zz").pct);
      const s = chart.addSeries(L.LineSeries, lineOpts("#fff59d", { lineWidth: 1.5 }));
      s.setData(zz.map((z) => ({ time: D.t[z.i], value: z.p })));
    }
    // volume (overlay at the bottom of the price pane)
    if (cfg("vol").on && D.hasVol) {
      const vs = chart.addSeries(L.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      vs.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vs.setData(D.t.map((t, i) => ({ time: t, value: D.v[i], color: D.c[i] >= D.o[i] ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)" })));
      const avg = chart.addSeries(L.LineSeries, lineOpts("rgba(255,255,255,.45)", { priceScaleId: "vol" }));
      avg.setData(pts(T.sma(D.v, cfg("vol").n)));
      leg.main.push({ label: "Vol", color: text, vals: D.v, fmt: fv });
    }

    // panes
    let pane = 0;
    const newPane = (title) => { pane += 1; leg.panes.push({ title, items: [] }); return pane; };
    const hline = (s, price, color = "rgba(255,255,255,.25)") => s.createPriceLine({ price, color, lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: false, title: "" });
    for (const d of panesOn) {
      const x = cfg(d.key);
      if (d.key === "rsi") {
        const p = newPane(`RSI ${x.n}`); const s = add(T.rsi(D.c, x.n), "#b388ff", "RSI", { lineWidth: 1.5 }, p, (v) => fn(v, 1));
        hline(s, x.ob, "rgba(239,83,80,.6)"); hline(s, x.os, "rgba(38,166,154,.6)"); hline(s, 50);
      } else if (d.key === "macd") {
        const p = newPane(`MACD ${x.f},${x.s},${x.g}`), r = T.macd(D.c, x.f, x.s, x.g);
        const hs = chart.addSeries(L.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }, p);
        hs.setData(r.hist.map((v, i) => (v == null ? { time: D.t[i] } : { time: D.t[i], value: v, color: v >= 0 ? (i && v >= r.hist[i - 1] ? "rgba(38,166,154,.8)" : "rgba(38,166,154,.4)") : (i && v <= r.hist[i - 1] ? "rgba(239,83,80,.8)" : "rgba(239,83,80,.4)") })));
        leg.panes[p - 1].items.push({ label: "Hist", color: text, vals: r.hist, fmt: (v) => fn(v, 3) });
        const pf = { priceFormat: { type: "price", precision: 4, minMove: 0.0001 } };
        add(r.macd, "#2196f3", "MACD", { lineWidth: 1.5, ...pf }, p, (v) => fn(v, 3)); add(r.signal, "#ff9800", "Signal", pf, p, (v) => fn(v, 3));
      } else if (d.key === "stoch") {
        const p = newPane(`Stoch ${x.n},${x.k},${x.d}`), r = T.stochastic(D.h, D.l, D.c, x.n, x.k, x.d);
        const s = add(r.k, "#2196f3", "%K", { lineWidth: 1.5 }, p, (v) => fn(v, 1)); add(r.d, "#ff9800", "%D", {}, p, (v) => fn(v, 1));
        hline(s, 80, "rgba(239,83,80,.6)"); hline(s, 20, "rgba(38,166,154,.6)");
      } else if (d.key === "adx") {
        const p = newPane(`ADX ${x.n}`), r = T.adx(D.h, D.l, D.c, x.n);
        const s = add(r.adx, "#e0e0e0", "ADX", { lineWidth: 1.5 }, p, (v) => fn(v, 1));
        add(r.pdi, C.up, "+DI", {}, p, (v) => fn(v, 1)); add(r.mdi, C.down, "−DI", {}, p, (v) => fn(v, 1)); hline(s, 25);
      } else if (d.key === "atr") {
        const p = newPane(`ATR ${x.n}`), a = T.atr(D.h, D.l, D.c, x.n);
        add(a, "#4dd0e1", "ATR", { lineWidth: 1.5 }, p);
        leg.panes[p - 1].items.push({ label: "% of price", color: text, vals: a.map((v, i) => (v == null ? null : v / D.c[i])), fmt: (v) => pp(v, 2) });
      } else if (d.key === "obv") {
        const p = newPane("OBV"), o = T.obv(D.c, D.v);
        add(o, "#4dd0e1", "OBV", { lineWidth: 1.5, priceFormat: { type: "volume" } }, p, fv); add(T.sma(o, x.n), "#ff9800", `SMA ${x.n}`, { priceFormat: { type: "volume" } }, p, fv);
      } else if (d.key === "mfi") {
        const p = newPane(`MFI ${x.n}`); const s = add(T.mfi(D.h, D.l, D.c, D.v, x.n), "#ffb74d", "MFI", { lineWidth: 1.5 }, p, (v) => fn(v, 1));
        hline(s, 80, "rgba(239,83,80,.6)"); hline(s, 20, "rgba(38,166,154,.6)");
      } else if (d.key === "cmf") {
        const p = newPane(`CMF ${x.n}`); const s = add(T.cmf(D.h, D.l, D.c, D.v, x.n), "#81c784", "CMF", { lineWidth: 1.5, priceFormat: { type: "price", precision: 3, minMove: 0.001 } }, p, (v) => fn(v, 3)); hline(s, 0);
      } else if (d.key === "cci") {
        const p = newPane(`CCI ${x.n}`); const s = add(T.cci(D.h, D.l, D.c, x.n), "#4fc3f7", "CCI", { lineWidth: 1.5 }, p, (v) => fn(v, 0));
        hline(s, 100, "rgba(239,83,80,.6)"); hline(s, -100, "rgba(38,166,154,.6)"); hline(s, 0);
      } else if (d.key === "wr") {
        const p = newPane(`Williams %R ${x.n}`); const s = add(T.williamsR(D.h, D.l, D.c, x.n), "#ce93d8", "%R", { lineWidth: 1.5 }, p, (v) => fn(v, 1));
        hline(s, -20, "rgba(239,83,80,.6)"); hline(s, -80, "rgba(38,166,154,.6)");
      } else if (d.key === "roc") {
        const p = newPane(`ROC ${x.n}`); const s = add(T.roc(D.c, x.n), "#90caf9", "ROC %", { lineWidth: 1.5 }, p, (v) => fn(v, 2)); hline(s, 0);
      }
    }
    // size panes by stretch factor (works before the chart has its final size): price pane ~ 320px + 120px per pane
    chart.panes().forEach((pn, i) => pn.setStretchFactor(i === 0 ? 320 : 120));

    priceLines(); markers(); drawDrawings();
    makeLegends(leg);
    ovInit(el);
    setRange(keep);
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (cfg("fib").on) { clearTimeout(fibT); fibT = setTimeout(priceLines, 120); } });
    signals();
  }
  let fibT;

  // ------------------------------------------------------------------ patterns (computed once per build)
  let PAT = { cdl: [], byI: new Map(), gaps: [], cp: { patterns: [] } };
  const short = (name) => name.replace(/^(Bullish|Bearish) /, "").replace(/ \((bullish|bearish)\)/, "");
  function computePatterns() {
    const cdl = T.candles(D.o, D.h, D.l, D.c), byI = new Map();
    for (const x of cdl) (byI.get(x.i) || byI.set(x.i, []).get(x.i)).push(x);
    PAT = { cdl, byI, gaps: T.gaps(D.h, D.l, D.c, cfg("gaps").min), cp: T.chartPatterns(D.o, D.h, D.l, D.c, { pct: cfg("cpat").pct }) };
  }

  // ------------------------------------------------------------------ levels as price lines
  let lines = [];
  function priceLines() {
    lines.forEach((l) => { try { main.removePriceLine(l); } catch {} });
    lines = [];
    const pl = (price, color, title, style = L.LineStyle.Dashed, width = 1, axis = true) => {
      if (price == null || !isFinite(price)) return;
      lines.push(main.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: axis, title }));
    };
    const z = raw.zones;
    if (cfg("zones").on && z) {
      for (const r of z.resistance || []) pl(r.level, C.res, `R ${r.touches}×`, L.LineStyle.Dashed, r.touches >= 3 ? 2 : 1);
      for (const r of z.support || []) pl(r.level, C.sup, `S ${r.touches}×`, L.LineStyle.Dashed, r.touches >= 3 ? 2 : 1);
    }
    if (cfg("hl52").on) {
      const k = Math.max(0, D.n - per52());
      pl(Math.max(...D.h.slice(k)), C.hl52, "52w high", L.LineStyle.Dotted); pl(Math.min(...D.l.slice(k)), C.hl52, "52w low", L.LineStyle.Dotted);
    }
    if (cfg("piv").on) {
      const pv = prevPeriodPivots();
      if (pv) for (const [k, v] of Object.entries(pv.p)) pl(v, C.piv, `${k} (${pv.label})`, k === "P" ? L.LineStyle.Solid : L.LineStyle.Dotted, 1, k === "P");
    }
    if (cfg("fib").on) {
      const r = chart.timeScale().getVisibleLogicalRange();
      const a = Math.max(0, Math.floor(r ? r.from : 0)), b = Math.min(D.n - 1, Math.ceil(r ? r.to : D.n - 1));
      if (b > a) fibLines(a, b, pl);
    }
    if (cfg("mine").on) {
      const m = mine();
      if (m) {
        pl(m.avg, C.mine, `avg cost ${fp(m.avg)}`, L.LineStyle.Solid, 1);
        m.stops.forEach((x) => pl(x, C.stop, "stop", L.LineStyle.LargeDashed, 1));
        m.targets.forEach((x) => pl(x, C.target, "target", L.LineStyle.LargeDashed, 1));
      }
    }
    for (const d of drawings()) {
      if (d.type === "h") pl(d.p, d.color || C.draw, "", L.LineStyle.Solid, 1);
      if (d.type === "fib") fibFromPoints(d, pl);
    }
  }
  const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  function fibLines(a, b, pl) {
    let hi = -Infinity, lo = Infinity, ih = a, il = a;
    for (let i = a; i <= b; i++) { if (D.h[i] > hi) { hi = D.h[i]; ih = i; } if (D.l[i] < lo) { lo = D.l[i]; il = i; } }
    const upMove = il < ih;                          // low came first: retracements measured down from the high
    for (const f of FIBS) pl(upMove ? hi - (hi - lo) * f : lo + (hi - lo) * f, C.fib, `${(f * 100).toFixed(1)}%`, L.LineStyle.Dotted, 1);
  }
  function fibFromPoints(d, pl) {
    const [a, b] = [d.a, d.b];
    for (const f of FIBS) pl(b.p - (b.p - a.p) * f, d.color || C.fib, `${(f * 100).toFixed(1)}%`, L.LineStyle.Dotted, 1);
  }
  function prevPeriodPivots() {
    const last = D.t[D.n - 1];
    const daily = raw.bars;
    const key = view().iv === "D" ? (t) => t.slice(0, 7) : (t) => t.slice(0, 4);
    const cur = key(last);
    const prev = daily.filter((b) => key(b[0]) < cur);
    if (!prev.length) return null;
    const pk = key(prev[prev.length - 1][0]);
    const pb = prev.filter((b) => key(b[0]) === pk);
    const H = Math.max(...pb.map((b) => b[2])), Lw = Math.min(...pb.map((b) => b[3])), Cl = pb[pb.length - 1][4];
    return { p: T.pivots(H, Lw, Cl), label: pk };
  }

  // ------------------------------------------------------------------ my positions
  function mine() {
    const sym = view().sym;
    const lots = (state.port?.positions || []).filter((p) => p.symbol === sym && p.quantity > 0);
    if (!lots.length) return null;
    const q = lots.reduce((a, p) => a + p.quantity, 0);
    const avg = lots.reduce((a, p) => a + p.quantity * p.avg_cost, 0) / q;
    const sameCcy = lots.every((p) => p.currency === raw.currency);
    const uniq = (k) => [...new Set(lots.map((p) => p[k]).filter((x) => x != null && x > 0))];
    return { lots, avg: sameCcy ? avg : null, stops: uniq("stop_price"), targets: uniq("target_price") };
  }

  // ------------------------------------------------------------------ markers
  let markerApi = null;
  function markers() {
    const list = [];
    if (cfg("cross").on && D.n > 200) {
      for (const [i, dir] of T.crosses(T.sma(D.c, 50), T.sma(D.c, 200))) {
        list.push({ time: D.t[i], position: dir > 0 ? "belowBar" : "aboveBar", color: dir > 0 ? "#f5c542" : "#9e9e9e",
          shape: dir > 0 ? "arrowUp" : "arrowDown", text: dir > 0 ? "Golden cross" : "Death cross" });
      }
    }
    const m = cfg("mine").on && mine();
    if (m) {
      for (const p of m.lots) {
        if (!p.bought_at) continue;
        const i = idxOnOrBefore(p.bought_at.slice(0, 10));
        if (i < 0) continue;
        list.push({ time: D.t[i], position: "belowBar", color: C.mine, shape: "circle", text: `Buy ${p.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ ${fp(p.avg_cost)}` });
      }
    }
    if (cfg("cdl").on) {
      const from = D.n - cfg("cdl").bars, best = new Map();
      for (const p of PAT.cdl) {
        if (p.i < from || (p.kind === "I" && !cfg("cdlI").on)) continue;
        const b = best.get(p.i);
        if (!b || p.bars > b.bars || (p.bars === b.bars && p.dir && !b.dir)) best.set(p.i, p);
      }
      for (const p of best.values()) list.push({ time: D.t[p.i], position: p.dir > 0 ? "belowBar" : "aboveBar", color: p.dir > 0 ? "#26a69a" : p.dir < 0 ? "#ef5350" : "#9e9e9e",
        shape: p.dir > 0 ? "arrowUp" : p.dir < 0 ? "arrowDown" : "circle", text: p.i >= D.n - 20 ? short(p.name) : "", size: 0.6 });   // names only on recent bars; hover shows them in the legend
    }
    list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    markerApi = L.createSeriesMarkers(main, list);
  }

  // ------------------------------------------------------------------ drawings
  let drawn = [];
  function drawDrawings() {
    drawn.forEach((s) => { try { chart.removeSeries(s); } catch {} }); drawn = [];
    const noScale = { autoscaleInfoProvider: () => null };
    for (const d of drawings()) {
      if (d.type !== "trend") continue;
      const ia = idxOnOrBefore(d.a.t), ib = idxOnOrBefore(d.b.t);
      if (ia < 0 || ib < 0 || ia === ib) continue;
      const slope = (d.b.p - d.a.p) / (ib - ia);
      const pts2 = [{ time: D.t[ia], value: d.a.p }, { time: D.t[ib], value: d.b.p }];
      if (d.ext !== false && ib < D.n - 1) pts2.push({ time: D.t[D.n - 1], value: d.b.p + slope * (D.n - 1 - ib) });
      const s = chart.addSeries(L.LineSeries, lineOpts(d.color || C.draw, { lineWidth: 2, ...noScale }));
      s.setData(pts2);
      drawn.push(s);
    }
    drawList();
    ovVer++;
  }
  function drawList() {
    const ds = drawings();
    const lbl = (d) => ({ h: () => `— ${fp(d.p)}`, trend: () => `╱ ${dS(d.a.t)}→${dS(d.b.t)}`, fib: () => `Fib ${fp(d.a.p)}→${fp(d.b.p)}`,
      pitchfork: () => `Pitchfork ${dS(d.a.t)}`, fibfan: () => `Fib fan ${dS(d.a.t)}`, fibarc: () => `Fib arcs ${dS(d.b.t)}`, fibtime: () => `Fib time ${dS(d.a.t)}`,
      raff: () => `Raff ${dS(d.a.t)}→${dS(d.b.t)}`, speed: () => `Speed lines ${dS(d.a.t)}`, cycle: () => `Cycles ${dS(d.a.t)}` })[d.type]?.() || d.type;
    $("#ta-drawings").innerHTML = ds.length ? `<span class="sub">Drawings:</span> ${ds.map((d, i) => `<span class="chip-in">${esc(lbl(d))}<button data-i="${i}" title="Delete">×</button></span>`).join("")} <button class="linkbtn" id="ta-clear">clear all</button>` : "";
  }
  const dS = (iso) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "2-digit" }).format(new Date(iso + "T00:00:00"));

  // clicks each tool needs, and what to ask for next
  const NEED = { hline: 1, vwap: 1, fibtime: 1, trend: 2, fib: 2, measure: 2, fibfan: 2, fibarc: 2, raff: 2, speed: 2, cycle: 2, pitchfork: 3 };
  const NEXT = { trend: ["Click the second point"], fib: ["Click the swing end (0%)"], measure: ["Click the end point"],
    fibfan: ["Click the swing end — fan lines are drawn from the first point"], fibarc: ["Click the swing end — arcs are centred on it"],
    raff: ["Click the end of the regression period"], speed: ["Click the swing end"], cycle: ["Click where the next cycle starts"],
    pitchfork: ["Click the second pivot (B)", "Click the third pivot (C)"] };
  function onClick(p) {
    if (tool === "cursor" || !p.point || (p.paneIndex ?? 0) !== 0 || p.logical == null) return;
    const i = Math.max(0, Math.min(D.n - 1, Math.round(p.logical)));
    const pt = { t: D.t[i], p: main.coordinateToPrice(p.point.y) };
    if (pt.p == null) return;
    pt.p = +pt.p.toPrecision(7);
    pending = [...(pending || []), pt];
    if (pending.length < NEED[tool]) { hint(NEXT[tool][pending.length - 1]); ovVer++; return; }
    const ps = pending, add = (d) => setDrawings([...drawings(), d]);
    pending = null;
    const byTime = (a, b) => (a.t <= b.t ? [a, b] : [b, a]);
    switch (tool) {
      case "hline": add({ type: "h", p: ps[0].p }); break;
      case "vwap": saveTA({ vwap_anchor: { ...(S().vwap_anchor || {}), [view().sym]: ps[0].t } }); setCfg("vwap", { on: true }); syncPanel(); done(); return build();
      case "fibtime": add({ type: "fibtime", a: ps[0] }); break;
      case "trend": { const [a, b] = byTime(ps[0], ps[1]); add({ type: "trend", a, b }); break; }
      case "measure": { const [a, b] = byTime(ps[0], ps[1]); return measure(a, b); }
      case "raff": case "cycle": { const [a, b] = byTime(ps[0], ps[1]); add({ type: tool, a, b }); break; }
      case "fib": case "fibfan": case "fibarc": case "speed": add({ type: tool, a: ps[0], b: ps[1] }); break;   // click order matters
      case "pitchfork": add({ type: "pitchfork", a: ps[0], b: ps[1], c: ps[2] }); break;
    }
    done();
  }
  function measure(a, b) {
    if (measureLine) { try { chart.removeSeries(measureLine); } catch {} }
    measureLine = chart.addSeries(L.LineSeries, lineOpts("#ffd54f", { lineWidth: 2, lineStyle: L.LineStyle.Dashed, autoscaleInfoProvider: () => null }));
    measureLine.setData([{ time: a.t, value: a.p }, { time: b.t, value: b.p }]);
    const bars = idxOnOrBefore(b.t) - idxOnOrBefore(a.t), days = Math.round((new Date(b.t) - new Date(a.t)) / 864e5);
    hint(`Measure: ${fp(a.p)} → ${fp(b.p)} = <b class="${b.p >= a.p ? "up" : "down"}">${pc(b.p / a.p - 1)}</b> (${fp(b.p - a.p)}) over ${bars} bars · ${days} days <button class="linkbtn" id="ta-mclear">clear</button>`, true);
    setTool("cursor", true);
  }
  function done() { pending = null; setTool("cursor"); priceLines(); drawDrawings(); ovVer++; }
  function hint(html, keep) { $("#ta-hint").innerHTML = html; $("#ta-hint").dataset.keep = keep ? "1" : ""; }
  const TOOL_HINT = { hline: "Click on the price chart to place a horizontal line", trend: "Click the first point of the trend line",
    fib: "Click the swing start (100%), then the swing end (0%) — e.g. low then high for a rally", measure: "Click the start point", vwap: "Click the bar to anchor the VWAP at",
    pitchfork: "Andrews' Pitchfork: click the first pivot (A)", fibfan: "Fibonacci fan: click the swing start", fibarc: "Fibonacci arcs: click the swing start",
    fibtime: "Fibonacci time zones: click the starting bar (usually a major high or low)", raff: "Raff regression channel: click the start of the period",
    speed: "Speed resistance lines: click the swing start", cycle: "Cycle lines: click the start of a cycle" };
  function setTool(t, keepHint) {
    tool = t; pending = null; mouse = null; ovVer++;
    $$("#ta-tools button[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    if (!keepHint) hint(TOOL_HINT[t] || "");
    $("#ta-chart").classList.toggle("drawing", t !== "cursor");
  }

  // ------------------------------------------------------------------ canvas overlay on the price pane
  // Shapes the chart library has no series for (volume profile, gap boxes, chart patterns, pitchforks, arcs, time
  // lines…) are painted on a canvas over the price pane, re-projected whenever the zoom, scroll or price scale changes.
  let ov = null, ovSig = "", ovVer = 0, mouse = null;
  function ovInit(el) {
    ov = document.createElement("canvas");
    ov.className = "ta-ov";
    el.appendChild(ov);
    legends.push(ov);          // removed with the legends on rebuild
    ovSig = "";
  }
  (function ovTick() {
    requestAnimationFrame(ovTick);
    if (!chart || !main || !D || !ov || $("#view-ta").hidden) return;
    const ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
    if (!r) return;
    const w = ts.width(), h = chart.panes()[0].getHeight();
    const ref = D.c[D.n - 1], y1 = main.priceToCoordinate(ref), y2 = main.priceToCoordinate(ref * 1.07);
    const sig = [r.from.toFixed(2), r.to.toFixed(2), w, h, y1 && y1.toFixed(1), y2 && y2.toFixed(1), ovVer, mouse ? `${mouse.i},${(mouse.p || 0).toPrecision(5)}` : ""].join("|");
    if (sig === ovSig) return;
    ovSig = sig;
    drawOverlay(w, h, r);
  })();

  const FIB_FAN = [0.382, 0.5, 0.618], FIB_ARC = [0.382, 0.5, 0.618, 1], FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
  function drawOverlay(w, h, r) {
    const dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
    ov.style.width = `${w}px`; ov.style.height = `${h}px`;
    const g = ov.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip();
    const ts = chart.timeScale();
    const X = (i) => ts.logicalToCoordinate(i), Y = (p) => main.priceToCoordinate(p);
    const a = Math.max(0, Math.floor(r.from)), b = Math.min(D.n - 1, Math.ceil(r.to));
    const font = `11px ${css("--font") || "sans-serif"}`;
    const text = (s2, x, y, color, align = "left") => { g.font = font; g.fillStyle = color; g.textAlign = align; g.fillText(s2, x, y); };
    const line = (x1, y1, x2, y2, color, width = 1, dash = []) => {
      if ([x1, y1, x2, y2].some((v) => v == null || !isFinite(v))) return;
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
    };
    // ray from p0 through p1 to the right edge (screen space)
    const ray = (p0, p1, color, width = 1, dash = []) => {
      if (!p0 || !p1 || p0.x == null || p1.x == null || p0.y == null || p1.y == null) return;
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      if (Math.abs(dx) < 1e-6) return line(p0.x, p0.y, p1.x, p1.y, color, width, dash);
      const k = dx > 0 ? (w + 20 - p0.x) / dx : 1;
      line(p0.x, p0.y, p0.x + dx * Math.max(1, k), p0.y + dy * Math.max(1, k), color, width, dash);
    };
    const S2 = (pt) => (pt ? { x: X(pt.i ?? Math.max(0, idxOnOrBefore(pt.t))), y: Y(pt.p) } : null);

    // ---- volume by price (visible bars)
    if (cfg("vbp").on && D.hasVol && b > a) {
      const vp = T.volumeByPrice(D.o, D.h, D.l, D.c, D.v, a, b, cfg("vbp").b);
      if (vp) {
        const mx = Math.max(...vp.bins.map((x) => x.up + x.dn)) || 1, W = w * 0.24;
        vp.bins.forEach((x, k) => {
          const y1 = Y(x.hi), y2 = Y(x.lo);
          if (y1 == null || y2 == null) return;
          const hh = Math.max(1, Math.abs(y2 - y1) - 1), top = Math.min(y1, y2) + 0.5, wu = (x.up / mx) * W, wd = (x.dn / mx) * W;
          g.fillStyle = "rgba(38,166,154,.30)"; g.fillRect(0, top, wu, hh);
          g.fillStyle = "rgba(239,83,80,.30)"; g.fillRect(wu, top, wd, hh);
          if (k === vp.poc) { g.strokeStyle = "rgba(255,213,79,.9)"; g.lineWidth = 1; g.strokeRect(0.5, top, wu + wd, hh); text("POC", wu + wd + 4, top + hh / 2 + 4, "rgba(255,213,79,.9)"); }
        });
      }
    }
    // ---- gaps: shaded from the gap bar until filled (or to today)
    if (cfg("gaps").on) {
      for (const gp of PAT.gaps) {
        const end = gp.filled ?? D.n - 1 + 3;
        if (gp.i > b || end < a) continue;
        const x1 = X(gp.i - 0.5), x2 = X(end), y1 = Y(gp.top), y2 = Y(gp.bot);
        if ([x1, x2, y1, y2].some((v) => v == null)) continue;
        g.fillStyle = gp.dir > 0 ? "rgba(38,166,154,.14)" : "rgba(239,83,80,.14)";
        g.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1) || 1);
        if (gp.filled == null) { g.strokeStyle = gp.dir > 0 ? "rgba(38,166,154,.7)" : "rgba(239,83,80,.7)"; g.setLineDash([3, 3]); g.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1) || 1); g.setLineDash([]); }
      }
    }
    // ---- chart patterns
    if (cfg("cpat").on) {
      for (const pt of PAT.cp.patterns) {
        const i0 = Math.min(...pt.pts.map((q) => q.i)), i1 = pt.brk ?? pt.end;
        if (i1 < a - 5 || i0 > b + 5) continue;
        const col = pt.dir > 0 ? "38,166,154" : pt.dir < 0 ? "239,83,80" : "176,190,197", conf = pt.brk != null;
        const strokeC = `rgba(${col},${conf ? 0.95 : 0.6})`;
        g.strokeStyle = strokeC; g.lineWidth = 1.5; g.setLineDash(conf ? [] : [4, 3]); g.beginPath();
        pt.pts.forEach((q, k) => { const x = X(q.i), y = Y(q.p); if (x == null || y == null) return; k ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke(); g.setLineDash([]);
        for (const [ia, pa, ib, pb] of pt.lines) line(X(ia), Y(pa), X(ib), Y(pb), `rgba(${col},.8)`, 1, [5, 4]);
        const top = pt.pts.reduce((m, q) => (pt.dir < 0 ? (q.p > m.p ? q : m) : q.p < m.p ? q : m), pt.pts[0]);
        const lx = X(top.i), ly = Y(top.p);
        if (lx != null && ly != null) text(`${pt.type}${conf ? " ✓" : " (forming)"}`, lx, pt.dir < 0 ? ly - 8 : ly + 16, strokeC, "center");
        if (pt.target != null && conf) {
          const tx1 = X(pt.brk), tx2 = X(pt.brk + 12), ty = Y(pt.target);
          line(tx1, ty, tx2, ty, `rgba(${col},.9)`, 1, [2, 3]);
          if (tx2 != null && ty != null) text(`target ${fp(pt.target)}`, tx2 + 4, ty + 4, `rgba(${col},.9)`);
        }
      }
    }
    // ---- drawings that are not series / price lines (+ preview of the one being placed)
    const list = drawings().filter((d) => ["pitchfork", "fibfan", "fibarc", "fibtime", "raff", "speed", "cycle"].includes(d.type));
    if (pending && mouse && mouse.p != null && NEED[tool] > 1) {
      const pp2 = [...pending, { i: Math.max(0, Math.min(D.n - 1, mouse.i)), t: D.t[Math.max(0, Math.min(D.n - 1, mouse.i))], p: mouse.p }];
      const keys = { pitchfork: ["a", "b", "c"], fibfan: ["a", "b"], fibarc: ["a", "b"], raff: ["a", "b"], speed: ["a", "b"], cycle: ["a", "b"], trend: ["a", "b"], fib: ["a", "b"], measure: ["a", "b"] }[tool];
      if (keys) {
        const d = { type: tool, preview: true };
        keys.forEach((k, j) => { if (pp2[j]) d[k] = pp2[j]; });
        if (["trend", "fib", "measure"].includes(tool) || (tool === "pitchfork" && !d.c)) line(S2(d.a).x, S2(d.a).y, S2(pp2[pp2.length - 1]).x, S2(pp2[pp2.length - 1]).y, "rgba(255,255,255,.6)", 1, [4, 3]);
        else list.push(d);
      }
    }
    for (const d of list) {
      const alpha = d.preview ? 0.55 : 0.95, col = (c2) => c2.replace("ALPHA", alpha);
      const A = S2(d.a), B = S2(d.b);
      if (d.type === "pitchfork" && d.c) {
        const Cc = S2(d.c), M = { x: (B.x + Cc.x) / 2, y: (B.y + Cc.y) / 2 }, dir = { x: M.x - A.x, y: M.y - A.y };
        ray(A, M, col("rgba(255,213,79,ALPHA)"), 1.5);
        ray(B, { x: B.x + dir.x, y: B.y + dir.y }, col("rgba(144,202,249,ALPHA)"), 1.2);
        ray(Cc, { x: Cc.x + dir.x, y: Cc.y + dir.y }, col("rgba(144,202,249,ALPHA)"), 1.2);
        line(B.x, B.y, Cc.x, Cc.y, col("rgba(144,202,249,ALPHA)"), 1, [3, 3]);
      } else if (d.type === "fibfan") {
        line(A.x, A.y, B.x, B.y, col("rgba(255,255,255,ALPHA)"), 1, [3, 3]);
        for (const f of FIB_FAN) {
          const q = { x: B.x, y: Y(d.b.p - (d.b.p - d.a.p) * f) };
          ray(A, q, col("rgba(255,183,77,ALPHA)"), 1.2);
          if (q.y != null) text(`${(f * 100).toFixed(1)}%`, B.x + 4, q.y - 3, col("rgba(255,183,77,ALPHA)"));
        }
      } else if (d.type === "fibarc") {
        const R = Math.hypot(B.x - A.x, B.y - A.y), downward = A.y > B.y;   // arcs open towards the first point
        line(A.x, A.y, B.x, B.y, col("rgba(255,255,255,ALPHA)"), 1, [3, 3]);
        for (const f of FIB_ARC) {
          g.strokeStyle = col("rgba(255,183,77,ALPHA)"); g.lineWidth = 1.2; g.beginPath();
          g.arc(B.x, B.y, R * f, downward ? 0 : Math.PI, downward ? Math.PI : 2 * Math.PI); g.stroke();
          text(`${(f * 100).toFixed(1)}%`, B.x, B.y + (downward ? R * f + 12 : -R * f - 4), col("rgba(255,183,77,ALPHA)"), "center");
        }
      } else if (d.type === "fibtime") {
        const i0 = Math.max(0, idxOnOrBefore(d.a.t));
        for (const f of FIB_TIME) {
          const x = X(i0 + f);
          if (x == null || x > w + 2) continue;
          line(x, 0, x, h, col("rgba(255,183,77,ALPHA)"), 1, f ? [4, 4] : []);
          text(String(f), x + 3, 12, col("rgba(255,183,77,ALPHA)"));
        }
      } else if (d.type === "raff" && B) {
        const ia = Math.max(0, idxOnOrBefore(d.a.t)), ib = Math.max(0, idxOnOrBefore(d.b.t));
        const f = ib - ia >= 2 ? T.linFit(D.c, ia, ib, D.h, D.l) : null;
        if (f) for (const [k, w2, dsh] of [[0, 1.5, []], [1, 1.2, []], [-1, 1.2, []]]) {
          const p0 = { x: X(ia), y: Y(f.at(ia) + k * f.raff) }, p1 = { x: X(ib), y: Y(f.at(ib) + k * f.raff) };
          line(p0.x, p0.y, p1.x, p1.y, col("rgba(206,147,216,ALPHA)"), w2, dsh);
          ray(p1, { x: p1.x + (p1.x - p0.x), y: p1.y + (p1.y - p0.y) }, col("rgba(206,147,216,ALPHA)"), 1, [4, 4]);
        }
      } else if (d.type === "speed") {
        line(A.x, A.y, B.x, B.y, col("rgba(255,255,255,ALPHA)"), 1, [3, 3]);
        for (const f of [2 / 3, 1 / 3]) {
          const q = { x: B.x, y: Y(d.a.p + (d.b.p - d.a.p) * f) };
          ray(A, q, col("rgba(129,212,250,ALPHA)"), 1.2);
          if (q.y != null) text(f > 0.5 ? "2/3" : "1/3", B.x + 4, q.y - 3, col("rgba(129,212,250,ALPHA)"));
        }
      } else if (d.type === "cycle" && B) {
        const ia = Math.max(0, idxOnOrBefore(d.a.t)), per = Math.max(1, Math.max(0, idxOnOrBefore(d.b.t)) - ia);
        for (let k = 0; k < 400; k++) {
          const x = X(ia + k * per);
          if (x == null) continue;
          if (x > w + 2) break;
          line(x, 0, x, h, col("rgba(129,199,132,ALPHA)"), 1, [2, 4]);
        }
        text(`cycle ${per} bars`, X(ia) + 4, h - 6, col("rgba(129,199,132,ALPHA)"));
      }
    }
    g.restore();
  }

  // ------------------------------------------------------------------ charts without a time axis, volume-width charts, seasonality
  const ALT = new Set(["renko", "kagi", "lb", "pnf", "cvol", "evol", "season"]);
  const A_DEF = { renko: { mode: "atr", v: 0 }, kagi: { mode: "atr", v: 4 }, lb: { n: 3 }, pnf: { mode: "atr", v: 1, rev: 3 } };
  const altCfg = (k) => ({ ...A_DEF[k], ...((S().alt || {})[k] || {}) });
  const setAlt = (k, patch) => saveTA({ alt: { ...(S().alt || {}), [k]: { ...altCfg(k), ...patch } } });
  const atrBox = () => T.niceBox(T.atr(D.h, D.l, D.c, 14)[D.n - 1] || D.c[D.n - 1] * 0.02);
  function altParams() {
    const k = view().type, el = $("#ta-altp");
    const modeSel = (key, opts) => `<select data-alt="${key}" data-f="mode">${opts.map(([v, l]) => `<option value="${v}" ${altCfg(key).mode === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const num = (key, f, label, step = "any") => `<label class="ta-p">${label}<input type="number" data-alt="${key}" data-f="${f}" value="${altCfg(key)[f]}" step="${step}" min="0"></label>`;
    el.innerHTML = {
      renko: () => `<span class="sub">Box size</span> ${modeSel("renko", [["atr", `ATR(14) → ${fb(atrBox())}`], ["fixed", "Fixed price"], ["pct", "% of last price"]])} ${altCfg("renko").mode !== "atr" ? num("renko", "v", altCfg("renko").mode === "pct" ? "%" : "Box") : ""}`,
      kagi: () => `<span class="sub">Reversal</span> ${modeSel("kagi", [["atr", `ATR(14) → ${fb(atrBox())}`], ["pct", "%"], ["fixed", "Fixed price"]])} ${altCfg("kagi").mode !== "atr" ? num("kagi", "v", altCfg("kagi").mode === "pct" ? "%" : "Amount") : ""}`,
      lb: () => num("lb", "n", "Lines to break", 1),
      pnf: () => `<span class="sub">Box</span> ${modeSel("pnf", [["atr", `ATR(14) → ${fb(atrBox())}`], ["fixed", "Fixed price"], ["pct", "% (log scale)"]])} ${altCfg("pnf").mode !== "atr" ? num("pnf", "v", altCfg("pnf").mode === "pct" ? "%" : "Box") : ""} ${num("pnf", "rev", "Reversal boxes", 1)} <span class="sub">High/low method</span>`,
      cvol: () => `<span class="sub">Candle width ∝ volume. Uses the bars of the selected range (up to 300).</span>`,
      evol: () => `<span class="sub">Box height = high − low, width ∝ volume. Uses the bars of the selected range (up to 300).</span>`,
      season: () => `<span class="sub">Average monthly return over the ${Object.keys(T.seasonality(raw.bars.map(([t, , , , c]) => ({ t, c }))).years).length} years loaded (choose “All” for the full history)</span>`,
    }[k]();
  }
  const sizeFor = (k) => {
    const x = altCfg(k), last = D.c[D.n - 1];
    return x.mode === "fixed" && x.v > 0 ? x.v : x.mode === "pct" && x.v > 0 ? last * x.v / 100 : atrBox();
  };

  function altRender() {
    const el = $("#ta-alt"), d3 = window.d3, k = view().type;
    el.innerHTML = "";
    const W = Math.max(320, el.clientWidth || 900), H = window.innerWidth < 700 ? 420 : 540, M = { l: 10, r: 70, t: 26, b: 26 };
    const a0 = startIndexForRange();
    const sl = (arr) => arr.slice(a0);
    const t = sl(D.t), o = sl(D.o), h = sl(D.h), l = sl(D.l), c = sl(D.c), v = sl(D.v);
    const head = (html) => el.insertAdjacentHTML("beforeend", `<div class="ta-althead">${html}</div>`);
    const svg = () => d3.select(el).append("svg").attr("width", W).attr("height", H).attr("class", "ta-svg");
    const yScale = (lo, hi) => {
      const pad = (hi - lo) * 0.04 || hi * 0.01;
      return (view().log && lo > 0 ? d3.scaleLog() : d3.scaleLinear()).domain([Math.max(view().log ? lo * 0.97 : -Infinity, lo - pad), hi + pad]).range([H - M.b, M.t]);
    };
    const axes = (sv, Y, ticks) => {
      sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y).ticks(8).tickFormat(fp)).call((gg) => gg.selectAll("text").attr("fill", "var(--muted)")).call((gg) => gg.selectAll("line,path").attr("stroke", "var(--border)"));
      sv.append("g").selectAll("line").data(Y.ticks(8)).join("line").attr("x1", M.l).attr("x2", W - M.r).attr("y1", Y).attr("y2", Y).attr("stroke", "rgba(255,255,255,.05)");
      if (ticks) sv.append("g").selectAll("text").data(ticks).join("text").attr("x", (d) => d[0]).attr("y", H - 8).attr("fill", "var(--muted)").attr("font-size", 10.5).attr("text-anchor", "middle").text((d) => d[1]);
    };
    const MAXC = W < 700 ? 120 : 260, NT = Math.max(3, Math.floor((W - 80) / 120));   // max columns shown, x-axis labels
    const colTicks = (items, X) => {
      const step = Math.max(1, Math.ceil(items.length / NT));
      return items.filter((_, j) => j % step === 0).map((it, j) => [X(j * step) + X.bandwidth() / 2, dS(it.t || it.t0)]);
    };

    if (k === "renko" || k === "lb") {
      const box = sizeFor("renko");
      let items = k === "renko" ? T.renko(c, t, box) : T.lineBreak(c, t, altCfg("lb").n);
      const total = items.length; items = items.slice(-MAXC);
      if (!items.length) { head(`<span class="hint">No ${k === "renko" ? "bricks" : "lines"} in this range — try a smaller box or a longer range.</span>`); return; }
      const last = items[items.length - 1];
      head(`<b>${k === "renko" ? `Renko · box ${fb(box)}` : `Three Line Break · ${altCfg("lb").n} lines`}</b> <span class="sub">· ${total} ${k === "renko" ? "bricks" : "lines"}${total > items.length ? ` (last ${items.length} shown)` : ""} since ${dS(t[0])} · last ${last.up ? '<span class="up">up</span>' : '<span class="down">down</span>'} ${dS(last.t)}</span>`);
      const X = d3.scaleBand().domain(d3.range(items.length)).range([M.l, W - M.r]).padding(0.12);
      const Y = yScale(d3.min(items, (x) => Math.min(x.o, x.c)), d3.max(items, (x) => Math.max(x.o, x.c)));
      const sv = svg(); axes(sv, Y, colTicks(items, X));
      sv.append("g").selectAll("rect").data(items).join("rect").attr("x", (_, j) => X(j)).attr("width", X.bandwidth())
        .attr("y", (x) => Y(Math.max(x.o, x.c))).attr("height", (x) => Math.max(1, Math.abs(Y(x.o) - Y(x.c))))
        .attr("fill", (x) => (x.up ? C.up : "transparent")).attr("stroke", (x) => (x.up ? C.up : C.down)).attr("stroke-width", 1.2)
        .append("title").text((x) => `${dS(x.t)}: ${fp(x.o)} → ${fp(x.c)}`);
      return;
    }
    if (k === "kagi") {
      const rev = altCfg("kagi").mode === "pct" ? c[c.length - 1] * altCfg("kagi").v / 100 : sizeFor("kagi");
      let cols = T.kagi(c, t, rev);
      const total = cols.length; cols = cols.slice(-MAXC);
      if (!cols.length) { head('<span class="hint">No reversals in this range — lower the reversal amount.</span>'); return; }
      const lastThick = cols[cols.length - 1].seg.slice(-1)[0].thick;
      head(`<b>Kagi · reversal ${fb(rev)}</b> <span class="sub">· ${total} lines since ${dS(t[0])} · now <b class="${lastThick ? "up" : "down"}">${lastThick ? "yang (thick: above the last shoulder)" : "yin (thin: below the last waist)"}</b></span>`);
      const X = d3.scaleBand().domain(d3.range(cols.length)).range([M.l, W - M.r]).padding(0);
      const Y = yScale(d3.min(cols, (x) => Math.min(x.from, x.to)), d3.max(cols, (x) => Math.max(x.from, x.to)));
      const sv = svg(); axes(sv, Y, colTicks(cols, X));
      const cx = (j) => X(j) + X.bandwidth() / 2, gg = sv.append("g");
      cols.forEach((col, j) => {
        if (j) {
          const prevThick = cols[j - 1].seg.slice(-1)[0].thick;
          gg.append("line").attr("x1", cx(j - 1)).attr("x2", cx(j)).attr("y1", Y(col.from)).attr("y2", Y(col.from)).attr("stroke", prevThick ? C.up : C.down).attr("stroke-width", prevThick ? 3 : 1.3);
        }
        for (const sg of col.seg) gg.append("line").attr("x1", cx(j)).attr("x2", cx(j)).attr("y1", Y(sg.y1)).attr("y2", Y(sg.y2)).attr("stroke", sg.thick ? C.up : C.down).attr("stroke-width", sg.thick ? 3 : 1.3)
          .append("title").text(`${dS(col.t)}: ${fp(col.from)} → ${fp(col.to)} (${sg.thick ? "yang" : "yin"})`);
      });
      return;
    }
    if (k === "pnf") {
      const x = altCfg("pnf"), opts = x.mode === "pct" ? { pct: x.v || 1, rev: x.rev } : { box: sizeFor("pnf"), rev: x.rev };
      const r = T.pnf(h, l, t, opts);
      if (!r || !r.cols.length) { head('<span class="hint">No columns in this range — use a smaller box or a longer range.</span>'); return; }
      const off = Math.max(0, r.cols.length - MAXC), cols = r.cols.slice(off);
      const sig = r.signals[r.signals.length - 1];
      head(`<b>Point &amp; Figure · ${x.mode === "pct" ? `${opts.pct}% boxes` : `box ${fb(opts.box)}`} × ${x.rev} reversal</b> <span class="sub">· ${r.cols.length} columns since ${dS(t[0])}${off ? ` (last ${cols.length} shown)` : ""}</span>
        ${sig ? ` · last signal <b class="${sig.dir > 0 ? "up" : "down"}">${sig.type}</b> at ${fp(sig.level)} on ${dS(sig.t)}` : ""}${r.objective ? ` · <span title="Vertical count: length of the first column off the swing ${sig && sig.dir > 0 ? "low" : "high"} × box × reversal">objective ${fp(r.objective.level)}</span>` : ""}
        · now <b>${cols[cols.length - 1].type === "X" ? '<span class="up">X column (rising)</span>' : '<span class="down">O column (falling)</span>'}</b>`);
      const lo = d3.min(cols, (q) => q.bot) - 1, hi = d3.max(cols, (q) => q.top) + 1;
      const X = d3.scaleBand().domain(d3.range(cols.length)).range([M.l, W - M.r]).padding(0.05);
      const Y = (r.logm ? d3.scaleLog() : d3.scaleLinear()).domain([r.level(lo), r.level(hi)]).range([H - M.b, M.t]);
      const sv = svg(); axes(sv, Y, colTicks(cols.map((q) => ({ t: q.t0 })), X));
      const gg = sv.append("g");
      cols.forEach((col, j) => {
        const cx = X(j) + X.bandwidth() / 2;
        for (let b2 = col.bot; b2 <= col.top; b2++) {
          const y = Y(r.level(b2)), sz = Math.max(2, Math.min(X.bandwidth(), Math.abs(Y(r.level(b2 + 1)) - y)) * 0.42);
          if (col.type === "X") {
            gg.append("path").attr("d", `M${cx - sz},${y - sz}L${cx + sz},${y + sz}M${cx - sz},${y + sz}L${cx + sz},${y - sz}`).attr("stroke", C.up).attr("stroke-width", 1.3);
          } else gg.append("circle").attr("cx", cx).attr("cy", y).attr("r", sz).attr("fill", "none").attr("stroke", C.down).attr("stroke-width", 1.3);
        }
        gg.append("rect").attr("x", X(j)).attr("width", X.bandwidth()).attr("y", Y(r.level(col.top)) - 6).attr("height", Math.abs(Y(r.level(col.bot)) - Y(r.level(col.top))) + 12).attr("fill", "transparent")
          .append("title").text(`${col.type} column ${dS(col.t0)}: ${fp(r.level(col.bot))} – ${fp(r.level(col.top))}${col.sig ? `\n${col.sig.type} at ${fp(col.sig.level)} on ${dS(col.sig.t)}` : ""}`);
        if (col.sig) {
          const yy = col.sig.dir > 0 ? Y(r.level(col.top)) - 10 : Y(r.level(col.bot)) + 16;
          gg.append("text").attr("x", cx).attr("y", yy).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", col.sig.dir > 0 ? C.up : C.down)
            .text(col.sig.type.replace("Double top breakout", "DT↑").replace("Triple top breakout", "TT↑").replace("Double bottom breakdown", "DB↓").replace("Triple bottom breakdown", "TB↓"));
        }
      });
      if (r.objective) {
        const y = Y(r.objective.level), x0 = X(Math.max(0, r.objective.from - off)) ?? M.l;
        if (y >= M.t && y <= H - M.b) { gg.append("line").attr("x1", x0).attr("x2", W - M.r).attr("y1", y).attr("y2", y).attr("stroke", "#ffd54f").attr("stroke-dasharray", "4 4"); gg.append("text").attr("x", W - M.r - 4).attr("y", y - 4).attr("text-anchor", "end").attr("font-size", 10.5).attr("fill", "#ffd54f").text(`objective ${fp(r.objective.level)}`); }
      }
      return;
    }
    if (k === "cvol" || k === "evol") {
      if (!D.hasVol) { head('<span class="hint">Yahoo has no volume for this listing, so volume-width charts are not available.</span>'); return; }
      const n0 = Math.max(0, c.length - 300), idx = d3.range(n0, c.length), vt = d3.sum(idx, (j) => v[j]) || 1;
      head(`<b>${k === "cvol" ? "CandleVolume" : "EquiVolume"}</b> <span class="sub">· ${idx.length} bars · width ∝ volume (wide = heavy trading)</span>`);
      const Y = yScale(d3.min(idx, (j) => l[j]), d3.max(idx, (j) => h[j]));
      const plotW = W - M.r - M.l;
      let x = M.l;
      const pos = idx.map((j) => { const wv = Math.max(1, (v[j] / vt) * plotW); const p2 = { j, x, w: wv }; x += wv; return p2; });
      const step = Math.max(1, Math.ceil(pos.length / NT));
      const sv = svg(); axes(sv, Y, pos.filter((_, q) => q % step === 0).map((p2) => [p2.x + p2.w / 2, dS(t[p2.j])]));
      const gg = sv.append("g");
      for (const p2 of pos) {
        const j = p2.j, upb = k === "cvol" ? c[j] >= o[j] : j === 0 || c[j] >= c[j - 1], col = upb ? C.up : C.down;
        const tip = `${dS(t[j])}  O ${fp(o[j])} H ${fp(h[j])} L ${fp(l[j])} C ${fp(c[j])}  Vol ${fv(v[j])}`;
        if (k === "cvol") {
          gg.append("line").attr("x1", p2.x + p2.w / 2).attr("x2", p2.x + p2.w / 2).attr("y1", Y(h[j])).attr("y2", Y(l[j])).attr("stroke", col);
          gg.append("rect").attr("x", p2.x + 0.5).attr("width", Math.max(1, p2.w - 1)).attr("y", Y(Math.max(o[j], c[j]))).attr("height", Math.max(1, Math.abs(Y(o[j]) - Y(c[j]))))
            .attr("fill", col).append("title").text(tip);
        } else {
          gg.append("rect").attr("x", p2.x + 0.5).attr("width", Math.max(1, p2.w - 1)).attr("y", Y(h[j])).attr("height", Math.max(1, Y(l[j]) - Y(h[j])))
            .attr("fill", upb ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)").attr("stroke", col).append("title").text(tip);
        }
      }
      return;
    }
    if (k === "season") {
      const se = T.seasonality(raw.bars.map(([tt, , , , cc]) => ({ t: tt, c: cc })));
      const months = se.months, MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const years = Object.keys(se.years).sort();
      head(`<b>Seasonality</b> <span class="sub">· average and median monthly return, ${years[0]}–${years[years.length - 1]} · % of years the month was positive. Past seasonality is a tendency, not a rule.</span>`);
      const Hs = 300, X = d3.scaleBand().domain(d3.range(12)).range([M.l + 30, W - M.r]).padding(0.25);
      const ext = d3.max(months, (m) => Math.max(Math.abs(m.avg || 0), Math.abs(m.med || 0))) || 0.01;
      const Y = d3.scaleLinear().domain([-ext * 1.15, ext * 1.15]).range([Hs - 30, 20]);
      const sv = d3.select(el).append("svg").attr("width", W).attr("height", Hs).attr("class", "ta-svg");
      sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y).ticks(6).tickFormat((x) => `${(x * 100).toFixed(1)}%`)).call((gg) => gg.selectAll("text").attr("fill", "var(--muted)")).call((gg) => gg.selectAll("line,path").attr("stroke", "var(--border)"));
      sv.append("line").attr("x1", M.l + 30).attr("x2", W - M.r).attr("y1", Y(0)).attr("y2", Y(0)).attr("stroke", "var(--border)");
      const gg = sv.append("g");
      months.forEach((m, j) => {
        if (m.avg == null) return;
        gg.append("rect").attr("x", X(j)).attr("width", X.bandwidth()).attr("y", Y(Math.max(0, m.avg))).attr("height", Math.abs(Y(m.avg) - Y(0)) || 1).attr("fill", m.avg >= 0 ? C.up : C.down).attr("opacity", 0.8)
          .append("title").text(`${MN[j]}: average ${pc(m.avg)}, median ${pc(m.med)}, best ${pc(m.best)}, worst ${pc(m.worst)}, positive in ${Math.round(m.up * 100)}% of ${m.n} years`);
        gg.append("line").attr("x1", X(j)).attr("x2", X(j) + X.bandwidth()).attr("y1", Y(m.med)).attr("y2", Y(m.med)).attr("stroke", "#ffd54f").attr("stroke-width", 2);
        gg.append("text").attr("x", X(j) + X.bandwidth() / 2).attr("y", Hs - 14).attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "var(--text)").text(MN[j]);
        gg.append("text").attr("x", X(j) + X.bandwidth() / 2).attr("y", Hs - 2).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", m.up >= 0.5 ? C.up : C.down).text(`${Math.round(m.up * 100)}%↑`);
      });
      sv.append("text").attr("x", M.l).attr("y", 14).attr("font-size", 10.5).attr("fill", "var(--muted)").text("bars: average · yellow tick: median · bottom: % of years up");
      const cell = (r2) => (r2 == null ? "<td></td>" : `<td class="num" style="background:${r2 >= 0 ? `rgba(38,166,154,${Math.min(0.75, Math.abs(r2) * 6)})` : `rgba(239,83,80,${Math.min(0.75, Math.abs(r2) * 6)})`}">${(r2 * 100).toFixed(1)}</td>`);
      el.insertAdjacentHTML("beforeend", `<div class="table-wrap"><table class="grid ta-season"><thead><tr><th>Year</th>${MN.map((m) => `<th class="num">${m}</th>`).join("")}<th class="num">Year</th></tr></thead><tbody>
        ${years.slice().reverse().map((y) => { const row = se.years[y], yr = Object.values(row).reduce((acc, r2) => acc * (1 + r2), 1) - 1; return `<tr><td>${y}</td>${MN.map((_, j) => cell(row[j + 1])).join("")}${cell(yr)}</tr>`; }).join("")}
        <tr class="avg"><td>Avg</td>${months.map((m) => cell(m.avg)).join("")}<td></td></tr></tbody></table></div><p class="hint">Monthly returns in %, from month-end closes (the current month is month-to-date).</p>`);
    }
  }

  // ------------------------------------------------------------------ legends
  function makeLegends(leg) {
    const wrap = $("#ta-chart");
    const mk = (cls) => { const d = document.createElement("div"); d.className = `ta-legend ${cls}`; wrap.appendChild(d); legends.push(d); return d; };
    const mainEl = mk("main");
    const paneEls = leg.panes.map(() => mk("pane"));
    const place = () => {
      let y = 0;
      chart.panes().forEach((p, i) => { if (i > 0 && paneEls[i - 1]) paneEls[i - 1].style.top = `${y + 2}px`; y += p.getHeight() + 1; });
    };
    requestAnimationFrame(place);
    legendState = { leg, mainEl, paneEls, place };
    renderLegend(D.n - 1);
  }
  let legendState = null;
  function renderLegend(i) {
    if (!legendState || i == null || i < 0) return;
    const { leg, mainEl, paneEls } = legendState;
    const j = Math.min(i, D.n - 1);
    const prev = j ? D.c[j - 1] : null, ch = prev ? D.c[j] / prev - 1 : null;
    const it = (e) => `<span class="li"><i style="background:${e.color}"></i>${esc(e.label)} <b>${e.fmt(e.vals[i] ?? null)}</b></span>`;
    mainEl.innerHTML = `<div class="lh"><b>${esc(raw.symbol)}</b> <span class="sub">${view().iv} · ${dS(D.t[j])}</span>
      <span>O <b>${fp(D.o[j])}</b></span><span>H <b>${fp(D.h[j])}</b></span><span>L <b>${fp(D.l[j])}</b></span><span>C <b class="${ch >= 0 ? "up" : "down"}">${fp(D.c[j])}</b></span>
      <span class="${ch >= 0 ? "up" : "down"}">${pc(ch)}</span></div><div class="lr">${leg.main.map(it).join("")}</div>${patLegend(j)}`;
    leg.panes.forEach((p, k) => { paneEls[k].innerHTML = `<span class="lt">${esc(p.title)}</span>${p.items.map(it).join("")}`; });
  }
  function patLegend(j) {
    const ps = (cfg("cdl").on ? PAT.byI.get(j) || [] : []).filter((x) => x.kind !== "I" || cfg("cdlI").on);
    return ps.length ? `<div class="lp">${ps.map((x) => `<span class="${x.dir > 0 ? "up" : x.dir < 0 ? "down" : "sub"}">${esc(x.name)}</span>`).join(" · ")}</div>` : "";
  }
  function onMove(p) {
    if (!D) return;
    mouse = tool !== "cursor" && p.point && p.logical != null && (p.paneIndex ?? 0) === 0 ? { i: Math.round(p.logical), p: main.coordinateToPrice(p.point.y) } : null;
    const i = p.logical == null ? D.n - 1 : Math.round(p.logical);
    renderLegend(i < 0 ? 0 : i);
    if (legendState) legendState.place();
  }

  // ------------------------------------------------------------------ ranges
  function startIndexForRange() {
    const r = view().range, last = new Date(D.t[D.n - 1] + "T00:00:00Z");
    if (r === "All") return 0;
    const d = new Date(last);
    if (r === "YTD") d.setUTCMonth(0, 1);
    else { const m = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24, "5Y": 60, "10Y": 120 }[r] || 12; d.setUTCMonth(d.getUTCMonth() - m); }
    return Math.max(0, idxOnOrBefore(d.toISOString().slice(0, 10)) + 1);
  }
  function setRange(keep) {
    if (keep) { chart.timeScale().setVisibleLogicalRange(keep); return; }
    const a = startIndexForRange();
    chart.timeScale().setVisibleLogicalRange({ from: a, to: D.n - 1 + 6 });
  }

  // ------------------------------------------------------------------ signal table
  function signals() {
    const c = D.c, n = D.n, i = n - 1, px = c[i];
    const rows = [];
    const row = (g, name, value, reading, bias, tip = "") => rows.push({ g, name, value, reading, bias, tip });
    const last = (a) => a[i];
    const pctFrom = (a) => (a == null ? null : px / a - 1);
    const unit = { D: "day", W: "week", M: "month" }[view().iv];
    // trend
    for (const len of [20, 50, 200]) {
      const m = last(T.sma(c, len));
      if (m != null) row("Trend", `Price vs SMA ${len}`, `${fp(m)} (${pc(pctFrom(m), 1)})`, px > m ? "above" : "below", px > m ? 1 : -1);
    }
    const s50 = T.sma(c, 50), s200 = T.sma(c, 200);
    if (s200[i] != null) {
      const cr = T.crosses(s50, s200).pop();
      row("Trend", "SMA 50 vs SMA 200", cr ? `${cr[1] > 0 ? "golden" : "death"} cross ${dS(D.t[cr[0]])}` : "—", s50[i] > s200[i] ? "50 above 200" : "50 below 200", s50[i] > s200[i] ? 1 : -1);
    }
    const e9 = T.ema(c, 9), e21 = T.ema(c, 21);
    if (e21[i] != null) row("Trend", "EMA 9 vs EMA 21", `${fp(e9[i])} / ${fp(e21[i])}`, e9[i] > e21[i] ? "9 above 21" : "9 below 21", e9[i] > e21[i] ? 1 : -1);
    const ax = T.adx(D.h, D.l, D.c, cfg("adx").n);
    if (ax.adx[i] != null) {
      const a = ax.adx[i], dir = ax.pdi[i] > ax.mdi[i] ? 1 : -1;
      row("Trend", `ADX ${cfg("adx").n}`, `${fn(a, 1)} (+DI ${fn(ax.pdi[i], 1)} / −DI ${fn(ax.mdi[i], 1)})`,
        `${a >= 25 ? "strong" : a >= 20 ? "developing" : "weak / no"} trend, ${dir > 0 ? "+DI leads" : "−DI leads"}`, a >= 20 ? dir : 0, "ADX ≥ 25: trending; < 20: range-bound. Direction from +DI vs −DI.");
    }
    const st = T.supertrend(D.h, D.l, D.c, cfg("st").n, cfg("st").m);
    if (st.line[i] != null) row("Trend", "Supertrend", fp(st.line[i]), st.up[i] ? "up (line below price)" : "down (line above price)", st.up[i] ? 1 : -1);
    const sar = T.psar(D.h, D.l, cfg("sar").s, cfg("sar").m);
    if (sar.sar[i] != null) row("Trend", "Parabolic SAR", fp(sar.sar[i]), sar.up[i] ? "below price" : "above price", sar.up[i] ? 1 : -1);
    const ic = T.ichimoku(D.h, D.l, D.c, cfg("ichi").a, cfg("ichi").b, cfg("ichi").c), sh = cfg("ichi").b;
    const sa = ic.spanA[i - sh], sb = ic.spanB[i - sh];
    if (sa != null && sb != null) {
      const top = Math.max(sa, sb), bot = Math.min(sa, sb);
      row("Trend", "Ichimoku cloud", `${fp(bot)} – ${fp(top)}`, px > top ? "price above the cloud" : px < bot ? "price below the cloud" : "price inside the cloud", px > top ? 1 : px < bot ? -1 : 0);
    }
    // momentum
    const R = cfg("rsi"), rv = last(T.rsi(c, R.n));
    if (rv != null) row("Momentum", `RSI ${R.n}`, fn(rv, 1), rv >= R.ob ? "overbought" : rv <= R.os ? "oversold" : rv >= 50 ? "above 50" : "below 50", rv >= R.ob ? 0 : rv <= R.os ? 0 : rv >= 50 ? 1 : -1, "Overbought / oversold are counted as neutral: in a strong trend RSI can stay there for long.");
    const M = cfg("macd"), mc = T.macd(c, M.f, M.s, M.g);
    if (mc.signal[i] != null) {
      const cr = T.crosses(mc.macd, mc.signal).pop();
      row("Momentum", `MACD ${M.f},${M.s},${M.g}`, `${fn(mc.macd[i], 3)} / sig ${fn(mc.signal[i], 3)}`, `${mc.macd[i] > mc.signal[i] ? "above" : "below"} signal, ${mc.macd[i] > 0 ? "above" : "below"} zero${cr ? ` · crossed ${cr[1] > 0 ? "up" : "down"} ${dS(D.t[cr[0]])}` : ""}`, mc.macd[i] > mc.signal[i] ? 1 : -1);
      row("Momentum", "MACD histogram", fn(mc.hist[i], 3), mc.hist[i] > mc.hist[i - 1] ? "rising" : "falling", mc.hist[i] > mc.hist[i - 1] ? 1 : -1);
    }
    const SK = cfg("stoch"), so = T.stochastic(D.h, D.l, D.c, SK.n, SK.k, SK.d);
    if (so.d[i] != null) row("Momentum", `Stochastic ${SK.n},${SK.k},${SK.d}`, `%K ${fn(so.k[i], 1)} / %D ${fn(so.d[i], 1)}`, `${so.k[i] >= 80 ? "overbought, " : so.k[i] <= 20 ? "oversold, " : ""}%K ${so.k[i] > so.d[i] ? "above" : "below"} %D`, so.k[i] > so.d[i] ? 1 : -1);
    const cc = last(T.cci(D.h, D.l, D.c, cfg("cci").n));
    if (cc != null) row("Momentum", `CCI ${cfg("cci").n}`, fn(cc, 0), cc > 100 ? "above +100" : cc < -100 ? "below −100" : cc > 0 ? "above 0" : "below 0", cc > 0 ? 1 : -1);
    const wr = last(T.williamsR(D.h, D.l, D.c, cfg("wr").n));
    if (wr != null) row("Momentum", `Williams %R ${cfg("wr").n}`, fn(wr, 1), wr > -20 ? "overbought zone" : wr < -80 ? "oversold zone" : wr > -50 ? "upper half" : "lower half", wr > -20 || wr < -80 ? 0 : wr > -50 ? 1 : -1);
    const rc = last(T.roc(c, cfg("roc").n));
    if (rc != null) row("Momentum", `ROC ${cfg("roc").n}`, `${fn(rc, 2)}%`, rc > 0 ? "positive" : "negative", rc > 0 ? 1 : -1);
    // volatility
    const B = cfg("bb"), bb = T.bollinger(c, B.n, B.k);
    if (bb.up[i] != null) {
      const wp = T.percentile(bb.width, per52());
      row("Volatility", `Bollinger %B (${B.n},${B.k})`, fn(bb.pctB[i], 2), bb.pctB[i] > 1 ? "above the upper band" : bb.pctB[i] < 0 ? "below the lower band" : `inside the bands (${Math.round(bb.pctB[i] * 100)}% up)`, 0);
      if (wp != null) row("Volatility", "Bollinger bandwidth", pp(bb.width[i]), wp <= 0.1 ? `squeeze (lowest ${Math.round(wp * 100)}% of the year)` : wp >= 0.9 ? `very wide (top ${Math.round((1 - wp) * 100) || 1}% of the year)` : `${ord(Math.round(wp * 100))} percentile of the year`, 0, "A squeeze (very narrow bands) often comes before a large move, in either direction.");
    }
    const at = T.atr(D.h, D.l, D.c, cfg("atr").n), ap = at.map((v, k) => (v == null ? null : v / c[k]));
    if (at[i] != null) { const p = T.percentile(ap, per52()); row("Volatility", `ATR ${cfg("atr").n}`, `${fp(at[i])} (${pp(ap[i], 2)} of price)`, p == null ? "" : `${ord(Math.round(p * 100))} percentile of the year`, 0, `Typical ${unit} range.`); }
    const k52 = Math.max(0, n - per52()), h52 = Math.max(...D.h.slice(k52)), l52 = Math.min(...D.l.slice(k52));
    row("Volatility", "52-week range", `${fp(l52)} – ${fp(h52)}`, `${pc(px / h52 - 1, 1)} from high, ${pc(px / l52 - 1, 1)} from low`, 0);
    // volume
    if (D.hasVol) {
      const va = T.sma(D.v, 20)[i];
      if (va) row("Volume", `Volume vs 20-${unit} avg`, `${fv(D.v[i])} / ${fv(va)}`, `${fn(D.v[i] / va, 2)}×${D.v[i] > 1.5 * va ? " (heavy)" : D.v[i] < 0.5 * va ? " (light)" : ""}`, 0);
      const ob = T.obv(c, D.v), obs = T.sma(ob, cfg("obv").n);
      if (obs[i] != null) row("Volume", "OBV vs its average", fv(ob[i]), ob[i] > obs[i] ? "above (accumulation)" : "below (distribution)", ob[i] > obs[i] ? 1 : -1);
      const mf = last(T.mfi(D.h, D.l, D.c, D.v, cfg("mfi").n));
      if (mf != null) row("Volume", `MFI ${cfg("mfi").n}`, fn(mf, 1), mf >= 80 ? "overbought" : mf <= 20 ? "oversold" : mf >= 50 ? "above 50" : "below 50", mf >= 80 || mf <= 20 ? 0 : mf >= 50 ? 1 : -1);
      const cm = last(T.cmf(D.h, D.l, D.c, D.v, cfg("cmf").n));
      if (cm != null) row("Volume", `CMF ${cfg("cmf").n}`, fn(cm, 3), cm > 0.05 ? "buying pressure" : cm < -0.05 ? "selling pressure" : "flat", cm > 0.05 ? 1 : cm < -0.05 ? -1 : 0);
    }
    // levels
    const z = raw.zones;
    if (z) {
      const r0 = (z.resistance || [])[0], s0 = (z.support || [])[0];
      if (r0) row("Levels", "Nearest resistance", `${fp(r0.level)} (${r0.touches}×)`, `${pc(r0.level / px - 1, 1)} away`, 0);
      if (s0) row("Levels", "Nearest support", `${fp(s0.level)} (${s0.touches}×)`, `${pc(s0.level / px - 1, 1)} away`, 0);
      if (z.breakout) row("Levels", "Breakout", fp(z.breakout.level), "closed above a resistance recently", 1);
      if (z.breakdown) row("Levels", "Breakdown", fp(z.breakdown.level), "closed below a support recently", -1);
    }
    const pv = prevPeriodPivots();
    if (pv) row("Levels", `Pivot (${pv.label})`, `P ${fp(pv.p.P)} · R1 ${fp(pv.p.R1)} · S1 ${fp(pv.p.S1)}`, px > pv.p.P ? "above the pivot" : "below the pivot", px > pv.p.P ? 1 : -1);

    // patterns & price action
    const imp = T.elderImpulse(c)[i];
    if (imp != null) row("Patterns", "Elder impulse", imp > 0 ? "green" : imp < 0 ? "red" : "blue", imp > 0 ? "EMA 13 and MACD histogram both rising" : imp < 0 ? "EMA 13 and MACD histogram both falling" : "mixed — no impulse", imp);
    const rc3 = PAT.cdl.filter((x) => x.i >= n - 3 && x.kind !== "I");
    if (rc3.length) {
      const sum = rc3.reduce((acc, x) => acc + x.dir, 0);
      row("Patterns", "Candlesticks (last 3 bars)", rc3.map((x) => `${x.name} ${dS(D.t[x.i])}`).join(" · "), rc3.map((x) => `${x.dir > 0 ? "bullish" : x.dir < 0 ? "bearish" : "neutral"} ${x.kind === "R" ? "reversal" : "continuation"}`).filter((v2, k2, arr) => arr.indexOf(v2) === k2).join(", "), Math.sign(sum), "Single candlestick patterns are weak signals on their own; they matter most at support / resistance and with confirmation on the next bar.");
    }
    const lastI = PAT.cdl.filter((x) => x.i === i && x.kind === "I");
    if (lastI.length) row("Patterns", "Indecision candle", lastI.map((x) => x.name).join(", "), "buyers and sellers balanced on the last bar", 0);
    for (const pt of PAT.cp.patterns.filter((x) => (x.brk ?? x.end) >= n - 120).slice(-3)) {
      row("Patterns", pt.type, pt.brk != null ? `confirmed ${dS(D.t[pt.brk])}` : `forming since ${dS(D.t[pt.pts[0].i])}`,
        pt.brk != null ? `${pt.dir > 0 ? "broke up" : "broke down"}${pt.target != null ? `, target ${fp(pt.target)} (${pc(pt.target / px - 1, 1)})` : ""}` : "no breakout yet", pt.brk != null ? pt.dir : 0, "Detected automatically from ZigZag swings — check it on the chart (Chart patterns overlay).");
    }
    const ug = PAT.gaps.filter((g2) => g2.filled == null);
    const gUp = ug.filter((g2) => g2.bot > px).sort((x, y) => x.bot - y.bot)[0], gDn = ug.filter((g2) => g2.top < px).sort((x, y) => y.top - x.top)[0];
    if (gUp) row("Patterns", "Unfilled gap above", `${fp(gUp.bot)} – ${fp(gUp.top)}`, `from ${dS(D.t[gUp.i])}, ${pc(gUp.bot / px - 1, 1)} away`, 0, "Unfilled gaps often act as resistance (above) or support (below).");
    if (gDn) row("Patterns", "Unfilled gap below", `${fp(gDn.bot)} – ${fp(gDn.top)}`, `from ${dS(D.t[gDn.i])}, ${pc(gDn.top / px - 1, 1)} away`, 0);
    const zz = T.zigzag(D.h, D.l, cfg("zz").pct);
    if (zz.length >= 2) { const zp = zz[zz.length - 2]; row("Patterns", `Last swing (ZigZag ${cfg("zz").pct}%)`, `${zp.k === "L" ? "low" : "high"} ${fp(zp.p)} on ${dS(D.t[zp.i])}`, `${pc(px / zp.p - 1, 1)} since`, px > zp.p ? 1 : -1); }
    const lrN = Math.min(n, cfg("lrc").n), lf = T.linFit(c, n - lrN, i);
    if (lf) row("Patterns", `Regression, last ${lrN} ${unit}s`, `${pc(lf.slope / lf.at(i), 2)} per ${unit} · R² ${fn(lf.r2, 2)}`, `price ${fn((px - lf.at(i)) / (lf.sd || 1), 1)} σ from the line`, Math.sign(lf.slope), "Slope of the least-squares line through closes; R² near 1 = a clean trend.");
    const box = atrBox(), pf = T.pnf(D.h, D.l, D.t, { box, rev: 3 });
    if (pf && pf.signals.length) { const sg = pf.signals[pf.signals.length - 1], cur = pf.cols[pf.cols.length - 1]; row("Patterns", `Point & Figure (box ${fb(box)} × 3)`, `${sg.type} ${dS(sg.t)}`, `now in ${cur.type === "X" ? "an X (rising)" : "an O (falling)"} column${pf.objective ? `, objective ${fp(pf.objective.level)}` : ""}`, sg.dir); }
    const kg = T.kagi(c, D.t, box);
    if (kg.length) { const th = kg[kg.length - 1].seg.slice(-1)[0].thick; row("Patterns", `Kagi (reversal ${fb(box)})`, th ? "yang (thick)" : "yin (thin)", th ? "above the last shoulder" : "below the last waist", th ? 1 : -1); }

    const groups = ["Trend", "Momentum", "Volatility", "Volume", "Levels", "Patterns"];
    const tally = (g) => { const r = rows.filter((x) => !g || x.g === g); return { up: r.filter((x) => x.bias > 0).length, dn: r.filter((x) => x.bias < 0).length, nt: r.filter((x) => !x.bias).length }; };
    const all = tally();
    const kpi = (g) => { const t = tally(g); return `<div class="kpi"><div class="k">${g}</div><div class="v"><span class="up">${t.up}↑</span> <span class="down">${t.dn}↓</span> <small class="sub">${t.nt} neutral</small></div></div>`; };
    const bias = (b) => (b > 0 ? '<span class="up">↑</span>' : b < 0 ? '<span class="down">↓</span>' : '<span class="sub">·</span>');
    $("#ta-signals").innerHTML = `
      <h3 class="sub-h">Readings on the last ${unit} (${dS(D.t[i])}) <span class="sub">· ${all.up} bullish, ${all.dn} bearish, ${all.nt} neutral readings — a summary of what the indicators show, not a forecast</span></h3>
      <div class="kpis small">${["Trend", "Momentum", "Volume", "Patterns"].map(kpi).join("")}</div>
      <div class="table-wrap"><table class="grid ta-sig"><thead><tr><th>Group</th><th>Indicator</th><th class="num">Value</th><th>Reading</th><th></th></tr></thead><tbody>
      ${groups.map((g) => rows.filter((r) => r.g === g).map((r, k) => `<tr${r.tip ? ` title="${esc(r.tip)}"` : ""}><td class="sub">${k ? "" : g}</td><td>${esc(r.name)}</td><td class="num">${esc(r.value)}</td><td>${esc(r.reading)}</td><td class="num">${bias(r.bias)}</td></tr>`).join("")).join("")}
      </tbody></table></div>`;
  }

  // ------------------------------------------------------------------ valuation: is it expensive or cheap?
  let valFor = null, valTimer = null;
  async function loadVal(sym, attempt = 0) {
    clearTimeout(valTimer);
    const el = $("#ta-val");
    if (attempt === 0) { valFor = sym; el.innerHTML = '<h3 class="sub-h">Valuation</h3><p class="hint">Loading valuation data…</p>'; }
    let v;
    try { v = await api(`/api/valuation?symbol=${encodeURIComponent(sym)}`); } catch (e) { if (valFor === sym) el.innerHTML = `<h3 class="sub-h">Valuation</h3><p class="hint">${esc(e.message)}</p>`; return; }
    if (valFor !== sym) return;
    renderVal(v);
    // sector peers come from the screener universe, fetched in the background the first time
    if (v.peers && v.peers.pending > 0 && attempt < 12) valTimer = setTimeout(() => loadVal(sym, attempt + 1), 6000);
  }
  const x2 = (v, d = 1) => (v == null || !isFinite(v) ? "—" : fn(v, d));
  // stock vs a reference: cheaper (green) when ≥ 15% below, pricier (red) when ≥ 15% above
  const cmpCls = (mine, ref) => (mine == null || ref == null || !(ref > 0) || !(mine > 0) ? "" : mine < ref * 0.85 ? "v-cheap" : mine > ref * 1.15 ? "v-dear" : "v-inline");
  function renderVal(v) {
    const el = $("#ta-val");
    const glossary = `<details class="ta-gloss"><summary>What do these ratios mean?</summary><dl>
      <dt>P/E (price-to-earnings ratio)</dt><dd>Share price ÷ earnings per share (EPS). How many years of current profits you pay for. Higher = more expensive, unless profits grow fast.</dd>
      <dt>Trailing P/E</dt><dd>Uses the EPS actually earned over the last 12 months (TTM, trailing twelve months).</dd>
      <dt>Forward P/E</dt><dd>Uses analysts' EPS estimate for the next 12 months. Below the trailing P/E = earnings are expected to grow.</dd>
      <dt>PEG (P/E-to-growth ratio)</dt><dd>P/E ÷ expected yearly EPS growth in %. Around 1 = the growth is fairly priced; below 1 = cheap for its growth.</dd>
      <dt>Earnings yield</dt><dd>EPS ÷ price (the inverse of P/E), in %. Handy to compare with government bond yields.</dd>
      <dt>P/S (price-to-sales ratio)</dt><dd>Market value ÷ yearly revenue. Useful when a company has little or no profit.</dd>
      <dt>P/B (price-to-book ratio)</dt><dd>Price ÷ book value (assets minus debts) per share. Most meaningful for banks and insurers.</dd>
      <dt>EV/EBITDA</dt><dd>Enterprise value (market value + net debt) ÷ EBITDA (earnings before interest, taxes, depreciation and amortisation). Compares companies with different debt levels.</dd>
      <dt>Percentile</dt><dd>Share of the period with a lower P/E than today: 20th percentile = cheaper than 80% of the time.</dd></dl></details>`;
    if (!v.applicable) { el.innerHTML = `<h3 class="sub-h">Valuation</h3><p class="hint">${esc(v.reason || "Not available.")}</p>`; return; }
    const H = v.history, s5 = H && H.stats5, s10 = H && H.stats10, P = v.peers, ps = P && P.stats, is_ = P && P.industry_stats;
    const mk = v.markets || [], spx = mk.find((m) => m.symbol === "SPY");
    const growth = v.pe && v.fpe ? v.pe / v.fpe - 1 : null, ey = v.pe ? 1 / v.pe : null;
    const loss = !v.pe && v.eps != null && v.eps < 0;
    const tile = (k, val, what, extra = "", cls = "") => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${val}</div><div class="d">${what}${extra ? `<br>${extra}` : ""}</div></div>`;
    const refs = (mine, own, sec, mkt, ownLbl = "own 5-y median") => [own != null ? `<span class="${cmpCls(mine, own)}">${ownLbl} ${x2(own)}</span>` : "", sec != null ? `<span class="${cmpCls(mine, sec)}">sector ${x2(sec)}</span>` : "", mkt != null ? `<span class="${cmpCls(mine, mkt.pe)}">${esc(mkt.label)} ${x2(mkt.pe)}</span>` : ""].filter(Boolean).join(" · ");
    const tiles = [
      tile("Trailing P/E", loss ? '<span class="down">loss</span>' : x2(v.pe), "price ÷ EPS (earnings per share) of the last 12 months", v.pe ? refs(v.pe, s5 && s5.median, ps && ps.pe, spx) : loss ? "negative earnings: P/E not meaningful" : ""),
      v.fpe ? tile("Forward P/E", x2(v.fpe), "price ÷ analysts' EPS estimate, next 12 months", [growth != null ? `EPS expected <b class="${growth >= 0 ? "up" : "down"}">${pc(growth, 0)}</b>` : "", ps && ps.fpe ? `<span class="${cmpCls(v.fpe, ps.fpe)}">sector ${x2(ps.fpe)}</span>` : ""].filter(Boolean).join(" · ")) : "",
      v.peg ? tile("PEG", x2(v.peg, 2), "P/E ÷ expected EPS growth (% a year)", v.peg < 1 ? '<span class="v-cheap">below 1: cheap for its growth</span>' : v.peg > 2 ? '<span class="v-dear">above 2: growth looks fully priced</span>' : "around 1–2: growth roughly priced in") : "",
      ey ? tile("Earnings yield", pp(ey, 1), "EPS ÷ price (inverse of P/E)", "compare with government bond yields") : "",
      v.ps ? tile("P/S", x2(v.ps), "price ÷ sales (revenue) per share") : "",
      v.pb ? tile("P/B", x2(v.pb), "price ÷ book value per share", ps && ps.pb ? `<span class="${cmpCls(v.pb, ps.pb)}">sector ${x2(ps.pb)}</span>` : "") : "",
      v.ev_ebitda ? tile("EV/EBITDA", x2(v.ev_ebitda), "enterprise value ÷ operating cash earnings", ps && ps.ev_ebitda ? `<span class="${cmpCls(v.ev_ebitda, ps.ev_ebitda)}">sector ${x2(ps.ev_ebitda)}</span>` : "") : "",
    ].join("");

    // plain-language readings
    const notes = [];
    if (v.proxy) notes.push(`This fund has no P/E of its own on Yahoo, so these are the figures of <b>${esc(v.proxy.symbol)}</b>, an ETF (exchange-traded fund) on the same index (${esc(v.proxy.label)}). They describe the index the fund holds.`);
    if (loss) notes.push("The company lost money over the last 12 months, so the trailing P/E is not meaningful. Look at the forward P/E (if analysts expect a profit) and P/S.");
    if (s5 && v.pe) {
      const pct = Math.round(s5.pctile), fair = H.ttm * s5.median, lvl = pct <= 25 ? "v-cheap" : pct >= 75 ? "v-dear" : "v-inline";
      notes.push(`<span class="${lvl}">${lvl === "v-cheap" ? "Cheap" : lvl === "v-dear" ? "Expensive" : "Normal"} versus its own history:</span> today's P/E of ${x2(H.pe_now)} is higher than ${pct}% of the last 5 years (median ${x2(s5.median)}, usual range ${x2(s5.p25)}–${x2(s5.p75)}). At the median P/E the price would be ${fp(fair)} (${pc(fair / raw.price - 1, 0)} from now).`);
    }
    if (ps && ps.pe && v.pe) {
      const r = v.pe / ps.pe, lvl = cmpCls(v.pe, ps.pe);
      notes.push(`<span class="${lvl}">${lvl === "v-cheap" ? "Cheaper than" : lvl === "v-dear" ? "More expensive than" : "In line with"} its sector:</span> P/E ${x2(v.pe)} vs a median of ${x2(ps.pe)} for ${ps.n} ${esc(P.sector)} large caps (${pc(r - 1, 0)}).${is_ && is_.pe ? ` Same industry (${esc(P.industry)}, ${is_.n} companies): ${x2(is_.pe)}.` : ""}`);
    }
    if (spx && v.pe && !v.proxy) notes.push(`<span class="${cmpCls(v.pe, spx.pe)}">Versus the market:</span> the S&amp;P 500 (through the SPY ETF) trades at a P/E of ${x2(spx.pe)}${mk.length > 1 ? `; ${mk.filter((m) => m !== spx).map((m) => `${esc(m.label)} ${x2(m.pe)}`).join(", ")}` : ""}.`);
    if (growth != null) notes.push(`Forward P/E ${growth >= 0 ? "below" : "above"} the trailing P/E: analysts expect earnings per share to ${growth >= 0 ? "grow" : "fall"} about ${pc(Math.abs(growth), 0).replace("+", "")} over the next 12 months. A high P/E is easier to justify when growth is high (see PEG).`);
    notes.push("A low P/E can mean the market expects profits to fall (a “value trap”); a high one can be justified by fast growth. Cyclical companies often look cheapest at the top of their cycle. Use these as context, not as a buy or sell signal.");

    // comparison table
    const row = (lbl, mine, own, sec, ind, f = x2) => `<tr><td>${lbl}</td><td class="num"><b>${f(mine)}</b></td><td class="num ${cmpCls(mine, own)}">${f(own)}</td><td class="num ${cmpCls(mine, sec)}">${f(sec)}</td>${P && P.industry_stats ? `<td class="num ${cmpCls(mine, ind)}">${f(ind)}</td>` : ""}${mk.map((m) => `<td class="num ${lbl === "Trailing P/E" ? cmpCls(mine, m.pe) : lbl === "Forward P/E" ? cmpCls(mine, m.fpe) : ""}">${lbl === "Trailing P/E" ? f(m.pe) : lbl === "Forward P/E" ? f(m.fpe) : "—"}</td>`).join("")}</tr>`;
    const table = `<div class="table-wrap"><table class="grid ta-valtab"><thead><tr><th></th><th class="num">${esc(v.proxy ? v.proxy.symbol : raw.symbol)}</th><th class="num" title="Median of its own weekly P/E over the last 5 years">Own 5-y median</th><th class="num">Sector median${ps ? ` <span class="sub">(${ps.n})</span>` : ""}</th>${P && P.industry_stats ? `<th class="num">Industry <span class="sub">(${is_.n})</span></th>` : ""}${mk.map((m) => `<th class="num" title="Through the ${esc(m.symbol)} ETF">${esc(m.label)}</th>`).join("")}</tr></thead><tbody>
      ${row("Trailing P/E", v.pe, s5 && s5.median, ps && ps.pe, is_ && is_.pe)}${row("Forward P/E", v.fpe, null, ps && ps.fpe, is_ && is_.fpe)}${row("P/B", v.pb, null, ps && ps.pb, is_ && is_.pb)}${row("EV/EBITDA", v.ev_ebitda, null, ps && ps.ev_ebitda, is_ && is_.ev_ebitda)}
      </tbody></table></div><p class="hint"><span class="v-cheap">green</span> = this stock is at least 15% cheaper than the reference; <span class="v-dear">red</span> = at least 15% more expensive.${P && P.pending ? ` Loading peer data (${P.pending} companies left)…` : ""}</p>`;
    const peerList = P && P.list.length ? `<details class="ta-peers"><summary>Largest ${esc(P.sector)} peers in the screener (${P.list.length})</summary><div class="table-wrap"><table class="grid"><thead><tr><th>Company</th><th>Industry</th><th class="num">P/E</th><th class="num">Fwd P/E</th><th class="num">P/B</th><th class="num">EV/EBITDA</th></tr></thead><tbody>
      ${P.list.map((q) => `<tr><td><button class="linkbtn ta-peer" data-sym="${esc(q.symbol)}">${esc(q.symbol)}</button> <span class="sub">${esc(q.name || "")}</span></td><td class="sub">${esc(q.industry || "")}</td><td class="num">${x2(q.pe)}</td><td class="num">${x2(q.fpe)}</td><td class="num">${x2(q.pb)}</td><td class="num">${x2(q.ev_ebitda)}</td></tr>`).join("")}</tbody></table></div></details>` : "";

    el.innerHTML = `<h3 class="sub-h">Valuation — expensive or cheap? <span class="sub">${esc(v.proxy ? `${v.proxy.symbol} (${v.proxy.label})` : v.name || "")}</span></h3>
      <div class="kpis small ta-valk">${tiles}</div>
      <div class="ta-valgrid"><div class="ta-pechart" id="ta-pechart">${H ? "" : `<p class="hint">${v.quote_type === "EQUITY" ? "No P/E history: Yahoo has too few quarterly earnings reports for this stock." : "P/E history is only available for individual stocks."}</p>`}</div>
        <div><ul class="ta-valnotes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul></div></div>
      ${table}${peerList}${glossary}`;
    if (H) peChart(H);
  }
  // trailing P/E over time with its 5-year median and usual range (25th–75th percentile)
  function peChart(H) {
    const el = $("#ta-pechart"), d3 = window.d3;
    const pts = H.series.filter((r) => r[2] != null).map((r) => ({ t: new Date(r[0] + "T00:00:00"), pe: r[2] }));
    if (pts.length < 10) return;
    const W = Math.max(300, el.clientWidth || 520), Hh = 240, M = { l: 8, r: 46, t: 22, b: 22 };
    const s5 = H.stats5, s10 = H.stats10 || s5;
    const X = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([M.l, W - M.r]);
    const lo = d3.min(pts, (p) => p.pe), hi = d3.max(pts, (p) => p.pe);
    const Y = d3.scaleLinear().domain([Math.max(0, lo * 0.9), hi * 1.05]).range([Hh - M.b, M.t]);
    const sv = d3.select(el).append("svg").attr("width", W).attr("height", Hh).attr("class", "ta-svg");
    sv.append("text").attr("x", M.l).attr("y", 13).attr("font-size", 11).attr("fill", "var(--muted)").text(`Trailing P/E, weekly, since ${dS(pts[0].t.toISOString().slice(0, 10))} · band: 5-year usual range (25th–75th percentile) · dashed: median`);
    if (s5) {
      sv.append("rect").attr("x", M.l).attr("width", W - M.r - M.l).attr("y", Y(s5.p75)).attr("height", Math.max(1, Y(s5.p25) - Y(s5.p75))).attr("fill", "rgba(57,135,229,.12)");
      sv.append("line").attr("x1", M.l).attr("x2", W - M.r).attr("y1", Y(s5.median)).attr("y2", Y(s5.median)).attr("stroke", "#3987e5").attr("stroke-dasharray", "5 4");
    }
    sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y).ticks(6)).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("g").attr("transform", `translate(0,${Hh - M.b})`).call(d3.axisBottom(X).ticks(Math.max(3, Math.floor(W / 110)))).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("path").datum(pts).attr("fill", "none").attr("stroke", "#e0e0e0").attr("stroke-width", 1.4).attr("d", d3.line().defined((p) => p.pe != null).x((p) => X(p.t)).y((p) => Y(p.pe)));
    const last = pts[pts.length - 1];
    sv.append("circle").attr("cx", X(last.t)).attr("cy", Y(last.pe)).attr("r", 3.5).attr("fill", "#ffd54f");
    // hover read-out
    const hl = sv.append("line").attr("y1", M.t).attr("y2", Hh - M.b).attr("stroke", "rgba(255,255,255,.3)").style("display", "none");
    const tx = sv.append("text").attr("y", M.t + 12).attr("font-size", 11).attr("fill", "var(--text)").style("display", "none");
    sv.append("rect").attr("x", M.l).attr("y", M.t).attr("width", W - M.r - M.l).attr("height", Hh - M.t - M.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const [mx] = d3.pointer(e), t = X.invert(mx), i = Math.min(pts.length - 1, d3.bisector((p) => p.t).left(pts, t));
        const p = pts[i], x = X(p.t);
        hl.attr("x1", x).attr("x2", x).style("display", null);
        tx.attr("x", Math.min(x + 6, W - M.r - 130)).text(`${dS(p.t.toISOString().slice(0, 10))}: P/E ${fn(p.pe, 1)}`).style("display", null);
      })
      .on("mouseleave", () => { hl.style("display", "none"); tx.style("display", "none"); });
    if (H.scaled) el.insertAdjacentHTML("beforeend", `<p class="hint">Rescaled ×${fn(H.scaled, 2)} to match Yahoo's trailing P/E (the reported EPS is in another currency or per a different share class).</p>`);
    el.insertAdjacentHTML("beforeend", `<p class="hint">Built from ${esc(H.basis)}, so it can differ a little from Yahoo's trailing P/E, which uses accounting (GAAP/IFRS) EPS.${s10 && s10.years === 10 ? ` 10-year median: ${fn(s10.median, 1)}.` : ""}</p>`);
  }

  // ------------------------------------------------------------------ latest results vs the previous three
  let finFor = null, finData = null;
  async function loadFin(sym) {
    finFor = sym; finData = null;
    const el = $("#ta-fin");
    el.innerHTML = '<h3 class="sub-h">Latest results</h3><p class="hint">Loading financial statements…</p>';
    let f;
    try { f = await api(`/api/financials?symbol=${encodeURIComponent(sym)}`); } catch (e) { if (finFor === sym) el.innerHTML = `<h3 class="sub-h">Latest results</h3><p class="hint">${esc(e.message)}</p>`; return; }
    if (finFor !== sym) return;
    finData = f;
    renderFin();
  }
  const finFreq = () => (S().fin_freq === "annual" ? "annual" : "quarterly");
  function fm(x, ccy) {      // compact money: 1.23B USD
    if (x == null || !isFinite(x)) return "—";
    const a = Math.abs(x), sgn = x < 0 ? "−" : "";
    const v = a >= 1e12 ? `${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(2);
    return `${sgn}${v}${ccy ? ` <span class="sub">${esc(ccy)}</span>` : ""}`;
  }
  const mY = (iso) => new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(iso + "T00:00:00"));
  function renderFin() {
    const el = $("#ta-fin"), f = finData;
    if (!f) return;
    if (!f.applicable) { el.innerHTML = `<h3 class="sub-h">Latest results</h3><p class="hint">${esc(f.reason)}</p>`; return; }
    let fr = finFreq(), d = f[fr];
    if (!d || d.periods.length < 2) { fr = fr === "annual" ? "quarterly" : "annual"; d = f[fr]; }
    if (!d || d.periods.length < 2) { el.innerHTML = '<h3 class="sub-h">Latest results</h3><p class="hint">Yahoo has too few reported periods for this company.</p>'; return; }
    const Q = fr === "quarterly", n = d.periods.length, L = n - 1, ccy = f.currency || "";
    const R = d.rows, get = (k, i) => (R[k] && i >= 0 ? R[k][i] : null);
    const ratio = (a, b) => (a == null || b == null || !b ? null : a / b);
    // derived rows
    const der = {
      gm: (i) => ratio(get("gross", i), get("revenue", i)), om: (i) => ratio(get("operating", i), get("revenue", i)),
      nm: (i) => ratio(get("net", i), get("revenue", i)), fcfm: (i) => ratio(get("fcf", i), get("revenue", i)),
      netdebt: (i) => (get("debt", i) == null && get("cash", i) == null ? null : (get("debt", i) || 0) - (get("cash", i) || 0)),
    };
    // EPS estimate / surprise: the report that came out within ~100 days after the period end
    const sur = (i) => {
      if (!Q) return null;
      const end = new Date(d.periods[i] + "T00:00:00");
      return (f.surprises || []).find((h) => { const t = new Date(h.date + "T00:00:00"); return t > end && t - end <= 100 * 864e5; }) || null;
    };
    const val = (key, i) => (key in der ? der[key](i) : key === "eps_rep" ? sur(i)?.eps ?? null : key === "eps_est" ? sur(i)?.eps_est ?? null : key === "surprise" ? (sur(i)?.surprise != null ? sur(i).surprise / 100 : null) : get(key, i));
    const prev3 = [L - 1, L - 2, L - 3].filter((i) => i >= 0);
    const avg = (key) => { const xs = prev3.map((i) => val(key, i)).filter((x) => x != null && isFinite(x)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    const yoyI = Q ? L - 4 : null;
    // [key, label, kind (money | pct | eps | shares), better (1 higher is better, -1 lower is better, 0 neutral), tooltip]
    const ROWS = [
      ["revenue", "Revenue", "money", 1, "Total sales in the period."],
      ["gross", "Gross profit", "money", 1, "Revenue minus the direct cost of what was sold."],
      ["gm", "Gross margin", "pct", 1, "Gross profit ÷ revenue."],
      ["operating", "Operating income", "money", 1, "Profit from the business itself, before interest and taxes."],
      ["om", "Operating margin", "pct", 1, "Operating income ÷ revenue: how much of each sale is operating profit."],
      ["ebitda", "EBITDA", "money", 1, "Earnings before interest, taxes, depreciation and amortisation."],
      ["net", "Net income", "money", 1, "Profit attributable to shareholders after everything."],
      ["nm", "Net margin", "pct", 1, "Net income ÷ revenue."],
      ["eps", "Diluted EPS (accounting)", "eps", 1, "Earnings per share from the income statement (GAAP/IFRS accounting rules), counting all shares that options and convertibles could create."],
      ["eps_rep", "EPS as announced", "eps", 1, "EPS in the earnings release, usually adjusted (excludes one-off items). This is the figure analysts forecast (quarters only)."],
      ["eps_est", "EPS estimate", "eps", 0, "Analysts' average forecast of the announced EPS before the report (quarters only)."],
      ["surprise", "EPS surprise", "pct", 1, "Announced EPS vs the estimate: positive = beat, negative = miss."],
      ["rnd", "R&D", "money", 0, "Research and development spending."],
      ["ocf", "Operating cash flow", "money", 1, "Cash generated by the business in the period."],
      ["capex", "Capex", "money", 0, "Capital expenditure: cash spent on equipment, buildings, etc. (shown negative)."],
      ["fcf", "Free cash flow", "money", 1, "Operating cash flow minus capex: cash left for dividends, buybacks or debt."],
      ["fcfm", "FCF margin", "pct", 1, "Free cash flow ÷ revenue."],
      ["cash", "Cash & short-term investments", "money", 1, "At the end of the period."],
      ["debt", "Total debt", "money", -1, "At the end of the period."],
      ["netdebt", "Net debt", "delta", -1, "Debt minus cash. Negative = more cash than debt (net cash). Changes are shown as amounts, since % changes of a figure that can cross zero mislead."],
      ["shares", "Diluted shares", "shares", -1, "Average share count; falling = buybacks."],
    ].filter(([k]) => d.periods.some((_, i) => val(k, i) != null));
    const show = (kind, x) => (x == null || !isFinite(x) ? "—" : kind === "money" || kind === "delta" ? fm(x) : kind === "pct" ? pp(x, 1) : kind === "eps" ? fn(x, 2) : fv(x));
    // change cells: % for amounts, percentage points (pp) for margins
    const chg = (kind, better, a, b) => {
      if (a == null || b == null || !isFinite(a) || !isFinite(b)) return '<td class="num sub">—</td>';
      let txt, delta;
      if (kind === "pct") { delta = a - b; txt = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta * 100).toFixed(1)} pp`; }
      else if (kind === "delta") { delta = a - b; txt = `${delta > 0 ? "+" : ""}${fm(delta)}`; }
      else { if (!b) return '<td class="num sub">—</td>'; delta = (a - b) / Math.abs(b); txt = pc(delta, 1); }
      const cls = !better || Math.abs(delta) < 0.0005 ? "" : delta * better > 0 ? "v-cheap" : "v-dear";
      return `<td class="num ${cls}">${txt}</td>`;
    };
    const cols = [L - 3, L - 2, L - 1, L].filter((i) => i >= 0);
    const head = `<tr><th></th>${cols.map((i) => `<th class="num${i === L ? " ta-last" : ""}">${mY(d.periods[i])}${i === L ? '<div class="sub">latest</div>' : ""}</th>`).join("")}
      <th class="num" title="Latest vs the period just before">vs previous</th><th class="num" title="Latest vs the average of the 3 periods before it">vs avg of previous ${prev3.length}</th>${Q && yoyI >= 0 ? `<th class="num" title="Latest quarter vs the same quarter a year earlier (year over year)">vs year ago</th>` : ""}</tr>`;
    const body = ROWS.map(([k, lbl, kind, better, tip]) => `<tr title="${esc(tip)}"><td>${esc(lbl)}</td>${cols.map((i) => `<td class="num${i === L ? " ta-last" : ""}">${show(kind, val(k, i))}</td>`).join("")}
      ${k === "eps_est" || k === "surprise" ? '<td class="num sub">—</td><td class="num sub">—</td>' : chg(kind, better, val(k, L), val(k, L - 1)) + chg(kind, better, val(k, L), avg(k))}${Q && yoyI >= 0 ? (k === "eps_est" || k === "surprise" ? '<td class="num sub">—</td>' : chg(kind, better, val(k, L), val(k, yoyI))) : ""}</tr>`).join("");
    const beatTxt = (h) => `announced ${fn(h.eps, 2)} vs estimate ${fn(h.eps_est, 2)}: <b class="${h.surprise >= 0 ? "up" : "down"}">${h.surprise >= 0 ? "beat" : "missed"} by ${Math.abs(h.surprise).toFixed(1)}%</b>`;

    // tiles
    const pct1 = (a, b) => (a == null || b == null || !b ? null : (a - b) / Math.abs(b));
    const ppd = (a, b) => (a == null || b == null ? null : a - b);
    const tag = (x, kind = "pc", better = 1) => (x == null || !isFinite(x) ? "" : `<b class="${x * better > 0.0005 ? "up" : x * better < -0.0005 ? "down" : ""}">${kind === "pp" ? `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)} pp` : pc(x, 1)}</b>`);
    const tl = (k, v2, a, b, c2) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v2}</div><div class="d">${[a, b, c2].filter(Boolean).join("<br>")}</div></div>`;
    const qn = Q ? "quarter" : "year";
    const s0 = sur(L);
    const tiles = [
      val("revenue", L) != null ? tl("Revenue", fm(val("revenue", L), ccy), `${tag(pct1(val("revenue", L), val("revenue", L - 1)))} vs previous ${qn}`, avg("revenue") != null ? `${tag(pct1(val("revenue", L), avg("revenue")))} vs avg of previous ${prev3.length}` : "", Q && yoyI >= 0 && val("revenue", yoyI) != null ? `${tag(pct1(val("revenue", L), val("revenue", yoyI)))} vs same quarter last year` : "") : "",
      val("om", L) != null ? tl("Operating margin", pp(val("om", L), 1), `${tag(ppd(val("om", L), val("om", L - 1)), "pp")} vs previous ${qn}`, avg("om") != null ? `${tag(ppd(val("om", L), avg("om")), "pp")} vs avg of previous ${prev3.length}` : "") : "",
      val("net", L) != null ? tl("Net income", fm(val("net", L), ccy), val("nm", L) != null ? `net margin ${pp(val("nm", L), 1)}` : "", `${tag(pct1(val("net", L), val("net", L - 1)))} vs previous ${qn}`, Q && yoyI >= 0 && val("net", yoyI) != null ? `${tag(pct1(val("net", L), val("net", yoyI)))} vs same quarter last year` : "") : "",
      val("eps", L) != null ? tl("Diluted EPS", fn(val("eps", L), 2), `${tag(pct1(val("eps", L), val("eps", L - 1)))} vs previous ${qn}`, s0 && s0.eps_est != null && s0.surprise != null ? beatTxt(s0) : "", Q && yoyI >= 0 && val("eps", yoyI) != null ? `${tag(pct1(val("eps", L), val("eps", yoyI)))} vs same quarter last year` : "") : "",
      val("fcf", L) != null ? tl("Free cash flow", fm(val("fcf", L), ccy), val("fcfm", L) != null ? `${pp(val("fcfm", L), 1)} of revenue` : "", `${tag(pct1(val("fcf", L), val("fcf", L - 1)))} vs previous ${qn}`) : "",
      val("netdebt", L) != null ? tl(val("netdebt", L) <= 0 ? "Net cash" : "Net debt", fm(Math.abs(val("netdebt", L)), ccy), val("netdebt", L) <= 0 ? "more cash than debt" : "debt minus cash", val("ebitda", L) && val("netdebt", L) > 0 ? `${fn(val("netdebt", L) / (val("ebitda", L) * (Q ? 4 : 1)), 1)}× annualised EBITDA` : "") : "",
    ].join("");

    // plain-language summary
    const notes = [];
    const p1 = (x) => (x == null ? null : pc(x, 1));
    const rv = val("revenue", L), rp = pct1(rv, val("revenue", L - 1)), ry = Q && yoyI >= 0 ? pct1(rv, val("revenue", yoyI)) : null, ra = pct1(rv, avg("revenue"));
    if (rv != null) notes.push(`<b>Revenue</b> ${fm(rv, ccy)}: ${p1(rp)} vs the previous ${qn}${ry != null ? `, ${p1(ry)} vs the same quarter last year` : ""}${ra != null ? ` and ${p1(ra)} vs the average of the previous ${prev3.length}` : ""}.`);
    const om0 = val("om", L), omp = val("om", L - 1), oma = avg("om");
    if (om0 != null) notes.push(`<b>Operating margin</b> ${pp(om0, 1)}: ${ppd(om0, omp) >= 0 ? "up" : "down"} ${Math.abs((ppd(om0, omp) || 0) * 100).toFixed(1)} pp (percentage points) vs the previous ${qn}${oma != null ? `, ${ppd(om0, oma) >= 0 ? "above" : "below"} its recent average of ${pp(oma, 1)}` : ""}. ${ppd(om0, oma) > 0.01 ? "Each sale is turning into more profit." : ppd(om0, oma) < -0.01 ? "Costs are growing faster than sales, or prices came down." : "Profitability is stable."}`);
    const e0 = val("eps", L);
    if (e0 != null) notes.push(`<b>EPS</b> (earnings per share) ${fn(e0, 2)}: ${p1(pct1(e0, val("eps", L - 1)))} vs the previous ${qn}${Q && yoyI >= 0 && val("eps", yoyI) != null ? `, ${p1(pct1(e0, val("eps", yoyI)))} year over year` : ""}${s0 && s0.eps_est != null && s0.surprise != null ? `. The EPS announced in the earnings release (usually adjusted for one-off items) was ${fn(s0.eps, 2)} against an analysts' estimate of ${fn(s0.eps_est, 2)}: it ${s0.surprise >= 0 ? "beat" : "missed"} by ${Math.abs(s0.surprise).toFixed(1)}%` : ""}.`);
    if (Q) {
      const beats = (f.surprises || []).slice(-4).filter((h) => h.surprise != null);
      if (beats.length >= 2) notes.push(`<b>Track record:</b> beat the EPS estimate in ${beats.filter((h) => h.surprise > 0).length} of the last ${beats.length} reports (average surprise ${pc(beats.reduce((a, h) => a + h.surprise, 0) / beats.length / 100, 1)}).`);
    }
    const fc = val("fcf", L);
    if (fc != null) notes.push(`<b>Free cash flow</b> (cash left after investments) ${fm(fc, ccy)}${val("fcfm", L) != null ? `, ${pp(val("fcfm", L), 1)} of revenue` : ""}${val("net", L) ? ` — ${fn(fc / val("net", L), 2)}× net income${fc / val("net", L) < 0.7 ? " (profit is not fully turning into cash this period)" : ""}` : ""}.`);
    const sh0 = val("shares", L), shA = val("shares", Math.max(0, L - (Q ? 4 : 1)));
    if (sh0 && shA && Math.abs(sh0 / shA - 1) > 0.005) notes.push(`<b>Share count</b> ${sh0 < shA ? "down" : "up"} ${Math.abs((sh0 / shA - 1) * 100).toFixed(1)}% in a year (${sh0 < shA ? "buybacks raise each share's slice of the profit" : "new shares dilute existing holders"}).`);
    if (Q) notes.push("Many businesses are seasonal, so the comparison with the same quarter last year is usually fairer than with the previous quarter.");

    el.innerHTML = `<div class="ta-finhead"><h3 class="sub-h">Latest results — ${Q ? "quarter" : "fiscal year"} ended ${dS(d.periods[L])} vs the previous ${prev3.length}</h3>
        <span class="seg" id="ta-finfreq"><button data-v="quarterly" class="${Q ? "active" : ""}" ${f.quarterly ? "" : "disabled"}>Quarterly</button><button data-v="annual" class="${Q ? "" : "active"}" ${f.annual ? "" : "disabled"}>Annual</button></span>
        ${f.next ? `<span class="sub">next report: <b>${dS(f.next)}</b>${f.eps_est != null ? ` · EPS estimate ${fn(f.eps_est, 2)}` : ""}</span>` : ""}</div>
      <div class="kpis small">${tiles}</div>
      <div class="ta-valgrid"><div class="ta-pechart" id="ta-finchart"></div><div><ul class="ta-valnotes">${notes.map((x) => `<li>${x}</li>`).join("")}</ul></div></div>
      <div class="table-wrap"><table class="grid ta-fintab"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <p class="hint">Amounts in ${esc(ccy || "the company's reporting currency")}, as reported (from Yahoo). <span class="v-cheap">Green</span> = better, <span class="v-dear">red</span> = worse (for debt and share count, lower is better). Margins change in pp (percentage points). Hover a row for what it means.</p>
      <details class="ta-gloss"><summary>What do these terms mean?</summary><dl>
        <dt>QoQ / vs previous</dt><dd>Quarter over quarter: the latest period vs the one just before.</dd>
        <dt>YoY / vs year ago</dt><dd>Year over year: the latest quarter vs the same quarter a year earlier (removes seasonal effects).</dd>
        <dt>pp (percentage points)</dt><dd>The difference between two percentages: a margin going from 30% to 32% is +2 pp (and +6.7%).</dd>
        <dt>EPS</dt><dd>Earnings per share: net income ÷ number of shares. “Diluted” counts shares that options and convertibles could create.</dd>
        <dt>Accounting vs announced EPS</dt><dd>The diluted EPS follows accounting rules (GAAP in the US, IFRS in Europe). The EPS announced in the earnings release is usually “adjusted” (excludes one-off items) and is the one analysts estimate, so beats and misses are measured on it.</dd>
        <dt>EBITDA</dt><dd>Earnings before interest, taxes, depreciation and amortisation: an approximation of operating cash earnings.</dd>
        <dt>Capex</dt><dd>Capital expenditure: money spent on long-lived assets (factories, data centres, equipment).</dd>
        <dt>FCF (free cash flow)</dt><dd>Operating cash flow minus capex: the cash the company can return to shareholders or use to pay debt.</dd>
        <dt>R&amp;D</dt><dd>Research and development spending.</dd>
        <dt>Net debt / net cash</dt><dd>Total debt minus cash. “× annualised EBITDA” = years of current EBITDA needed to repay it; above ~3× is usually considered high.</dd>
      </dl></details>`;
    finChart(d, Q, val, sur, ccy);
  }
  // revenue bars with operating margin line, and reported vs estimated EPS (quarters)
  function finChart(d, Q, val, sur, ccy) {
    const el = $("#ta-finchart"), d3 = window.d3;
    const idx = d.periods.map((_, i) => i).slice(-8);
    const W = Math.max(300, el.clientWidth || 520), Hh = 230, M = { l: 50, r: 44, t: 24, b: 22 };
    const sv = d3.select(el).append("svg").attr("width", W).attr("height", Hh).attr("class", "ta-svg");
    const X = d3.scaleBand().domain(idx).range([M.l, W - M.r]).padding(0.3);
    const rev = idx.map((i) => val("revenue", i)), om = idx.map((i) => val("om", i));
    const Y = d3.scaleLinear().domain([0, (d3.max(rev) || 1) * 1.1]).range([Hh - M.b, M.t]);
    const okOm = om.filter((x) => x != null);
    const Y2 = d3.scaleLinear().domain([Math.min(0, d3.min(okOm) ?? 0), Math.max(0.05, (d3.max(okOm) ?? 0.1) * 1.25)]).range([Hh - M.b, M.t]);
    sv.append("text").attr("x", 8).attr("y", 13).attr("font-size", 11).attr("fill", "var(--muted)").text(`Revenue (bars, ${ccy}) and operating margin (line, right axis)${Q ? " — dots above bars: EPS beat (green) / miss (red)" : ""}`);
    sv.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(Y).ticks(5).tickFormat((x) => fm(x).replace(/<[^>]+>/g, ""))).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y2).ticks(5).tickFormat((x) => `${(x * 100).toFixed(0)}%`)).call((g) => g.selectAll("text").attr("fill", "#ffd54f")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("g").attr("transform", `translate(0,${Hh - M.b})`).call(d3.axisBottom(X).tickFormat((i) => mY(d.periods[i]))).call((g) => g.selectAll("text").attr("fill", "var(--muted)").attr("font-size", 10)).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    const last = idx[idx.length - 1];
    sv.append("g").selectAll("rect").data(idx).join("rect").attr("x", (i) => X(i)).attr("width", X.bandwidth()).attr("y", (i) => Y(val("revenue", i) || 0)).attr("height", (i) => Y(0) - Y(val("revenue", i) || 0))
      .attr("fill", (i) => (i === last ? "#3987e5" : "rgba(57,135,229,.45)")).append("title").text((i) => `${mY(d.periods[i])}: revenue ${fm(val("revenue", i)).replace(/<[^>]+>/g, "")}, operating margin ${pp(val("om", i), 1)}`);
    const line = d3.line().defined((i) => val("om", i) != null).x((i) => X(i) + X.bandwidth() / 2).y((i) => Y2(val("om", i)));
    sv.append("path").datum(idx).attr("fill", "none").attr("stroke", "#ffd54f").attr("stroke-width", 2).attr("d", line);
    sv.append("g").selectAll("circle").data(idx.filter((i) => val("om", i) != null)).join("circle").attr("cx", (i) => X(i) + X.bandwidth() / 2).attr("cy", (i) => Y2(val("om", i))).attr("r", 3).attr("fill", "#ffd54f");
    if (Q) {
      sv.append("g").selectAll("circle").data(idx.filter((i) => sur(i) && sur(i).surprise != null)).join("circle")
        .attr("cx", (i) => X(i) + X.bandwidth() / 2).attr("cy", (i) => Y(val("revenue", i) || 0) - 8).attr("r", 4).attr("fill", (i) => (sur(i).surprise >= 0 ? C.up : C.down))
        .append("title").text((i) => `EPS ${fn(sur(i).eps, 2)} vs estimate ${fn(sur(i).eps_est, 2)} (${sur(i).surprise >= 0 ? "+" : ""}${sur(i).surprise.toFixed(1)}%)`);
    }
  }

  // ------------------------------------------------------------------ revenue vs net income, long history
  let rnFor = null, rnData = null;
  async function loadRevNi(sym) {
    rnFor = sym; rnData = null;
    const el = $("#ta-revni");
    el.innerHTML = '<h3 class="sub-h">Revenue vs net income</h3><p class="hint">Loading filings…</p>';
    let d;
    try { d = await api(`/api/fin_history?symbol=${encodeURIComponent(sym)}`); } catch (e) { if (rnFor === sym) el.innerHTML = `<h3 class="sub-h">Revenue vs net income</h3><p class="hint">${esc(e.message)}</p>`; return; }
    if (rnFor !== sym) return;
    rnData = d;
    renderRevNi();
  }
  // trailing twelve months: sum of 4 consecutive quarters (each ~3 months apart)
  function ttmRows(q) {
    const out = [];
    for (let k = 3; k < q.length; k++) {
      const w = q.slice(k - 3, k + 1);
      const ok = w.every((r, j) => !j || (new Date(r[0]) - new Date(w[j - 1][0])) / 864e5 < 110);
      if (!ok) continue;
      const sum = (c) => (w.every((r) => r[c] != null) ? w.reduce((a, r) => a + r[c], 0) : null);
      out.push([w[3][0], sum(1), sum(2), sum(3)]);
    }
    return out;
  }
  function renderRevNi() {
    const el = $("#ta-revni"), d = rnData, d3 = window.d3;
    if (!d) return;
    if (!d.applicable) { el.innerHTML = `<h3 class="sub-h">Revenue vs net income</h3><p class="hint">${esc(d.reason)}</p>${d.note ? `<p class="hint">${esc(d.note)}</p>` : ""}`; return; }
    const ttm = ttmRows(d.quarterly);
    let mode = S().rn_mode || (ttm.length >= 8 ? "ttm" : "annual");
    const avail = { ttm: ttm.length >= 2, annual: d.annual.length >= 2, quarterly: d.quarterly.length >= 2 };
    if (!avail[mode]) mode = ["ttm", "annual", "quarterly"].find((m) => avail[m]);
    if (!mode) { el.innerHTML = '<h3 class="sub-h">Revenue vs net income</h3><p class="hint">Not enough reported periods.</p>'; return; }
    const rows = (mode === "ttm" ? ttm : mode === "annual" ? d.annual : d.quarterly).filter((r) => r[1] != null || r[2] != null);
    const showOp = !!S().rn_op && rows.some((r) => r[3] != null), smooth = S().rn_smooth !== false, ccy = d.currency || "";
    const lbl = (iso) => (mode === "annual" ? `fiscal year to ${mY(iso)}` : mode === "ttm" ? `12 months to ${mY(iso)}` : `quarter to ${mY(iso)}`);
    // summary: growth (CAGR = compound annual growth rate), margins, losses
    const ann = d.annual.filter((r) => r[1] > 0), yrs = (a, b) => (new Date(b[0]) - new Date(a[0])) / 864e5 / 365.25;
    const cagr = (a, b) => (a && b && a[1] > 0 && b[1] > 0 && yrs(a, b) >= 1 ? (b[1] / a[1]) ** (1 / yrs(a, b)) - 1 : null);
    const full = ann.length >= 2 ? cagr(ann[0], ann[ann.length - 1]) : null;
    const a5 = ann.length >= 6 ? cagr(ann[ann.length - 6], ann[ann.length - 1]) : null;
    const margins = rows.filter((r) => r[1] > 0 && r[2] != null).map((r) => r[2] / r[1]);
    const lastR = rows[rows.length - 1], lastM = lastR && lastR[1] > 0 && lastR[2] != null ? lastR[2] / lastR[1] : null;
    const avgM = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
    const losses = rows.filter((r) => r[2] != null && r[2] < 0);
    const unit = mode === "annual" ? "years" : mode === "ttm" ? "12-month periods" : "quarters";
    const sum = [
      full != null ? `Revenue grew <b class="${full >= 0 ? "up" : "down"}">${pc(full, 1)} a year</b> from ${mY(ann[0][0])} to ${mY(ann[ann.length - 1][0])} (CAGR, compound annual growth rate)${a5 != null ? `; ${pc(a5, 1)} a year over the last 5 years` : ""}.` : "",
      lastM != null ? `Net margin (net income ÷ revenue) in the latest ${mode === "quarterly" ? "quarter" : "12 months"}: <b class="${lastM >= 0 ? "up" : "down"}">${pp(lastM, 1)}</b>, vs an average of ${pp(avgM, 1)} over the period shown (range ${pp(Math.min(...margins), 1)} to ${pp(Math.max(...margins), 1)}).` : "",
      losses.length ? `Losses in ${losses.length} of ${rows.length} ${unit}${losses.length <= 6 ? ` (${losses.map((r) => mY(r[0])).join(", ")})` : ""} — a sign of a cyclical or still-unprofitable business.` : `Profitable in every one of the ${rows.length} ${unit} shown.`,
    ].filter(Boolean);
    el.innerHTML = `<div class="ta-finhead"><h3 class="sub-h">Revenue vs net income <span class="sub">· ${esc(mY(rows[0][0]))} → ${esc(mY(lastR[0]))}</span></h3>
        <span class="seg" id="ta-rnmode">${[["ttm", "TTM", "Trailing twelve months: each point adds up the last 4 quarters (smooths seasonality)"], ["annual", "Annual", "Fiscal years"], ["quarterly", "Quarterly", "Single quarters"]].map(([k, t, tip]) => `<button data-v="${k}" title="${tip}" class="${k === mode ? "active" : ""}" ${avail[k] ? "" : "disabled"}>${t}</button>`).join("")}</span>
        <label class="ctl check"><input type="checkbox" id="ta-rnop" ${showOp ? "checked" : ""} ${rows.some((r) => r[3] != null) ? "" : "disabled"}> Operating income</label>
        <label class="ctl check"><input type="checkbox" id="ta-rnsmooth" ${smooth ? "checked" : ""}> Smooth</label></div>
      <div class="ta-rnchart" id="ta-rnchart"><div class="ta-rntip" hidden></div></div>
      <ul class="ta-valnotes">${sum.map((x) => `<li>${x}</li>`).join("")}</ul>
      <p class="hint">Source: ${esc(d.source)}. Amounts in ${esc(ccy || "the reporting currency")}. Net income = profit attributable to shareholders after all costs, interest and taxes.${d.note ? ` ${esc(d.note)}` : ""}</p>`;

    const box = $("#ta-rnchart"), W = Math.max(320, box.clientWidth || 900), Hh = window.innerWidth < 700 ? 280 : 360, M = { l: 10, r: 74, t: 14, b: 26 };
    const pts = rows.map((r) => ({ t: new Date(r[0] + "T00:00:00"), iso: r[0], rev: r[1], net: r[2], op: r[3] }));
    const X = d3.scaleTime().domain(d3.extent(pts, (p) => p.t)).range([M.l, W - M.r]);
    const lo = Math.min(0, d3.min(pts, (p) => Math.min(p.net ?? 0, showOp ? p.op ?? 0 : 0)));
    const hi = Math.max(1, d3.max(pts, (p) => Math.max(p.rev ?? 0, p.net ?? 0)));
    const Y = d3.scaleLinear().domain([lo * 1.1, hi * 1.08]).nice().range([Hh - M.b, M.t]);
    const curve = smooth ? d3.curveMonotoneX : d3.curveLinear;
    const sv = d3.select(box).append("svg").attr("width", W).attr("height", Hh).attr("class", "ta-svg");
    const uid = `rn${Math.random().toString(36).slice(2, 8)}`;
    const defs = sv.append("defs");
    defs.append("clipPath").attr("id", `${uid}a`).append("rect").attr("x", 0).attr("y", 0).attr("width", W).attr("height", Y(0));
    defs.append("clipPath").attr("id", `${uid}b`).append("rect").attr("x", 0).attr("y", Y(0)).attr("width", W).attr("height", Hh);
    sv.append("g").selectAll("line").data(Y.ticks(6)).join("line").attr("x1", M.l).attr("x2", W - M.r).attr("y1", Y).attr("y2", Y).attr("stroke", "rgba(255,255,255,.05)");
    sv.append("g").attr("transform", `translate(${W - M.r},0)`).call(d3.axisRight(Y).ticks(6).tickFormat((x) => fm(x).replace(/<[^>]+>/g, ""))).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    sv.append("g").attr("transform", `translate(0,${Hh - M.b})`).call(d3.axisBottom(X).ticks(Math.max(3, Math.floor(W / 100)))).call((g) => g.selectAll("text").attr("fill", "var(--muted)")).call((g) => g.selectAll("line,path").attr("stroke", "var(--border)"));
    const area = (key) => d3.area().defined((p) => p[key] != null).curve(curve).x((p) => X(p.t)).y0(Y(0)).y1((p) => Y(p[key]));
    const line = (key) => d3.line().defined((p) => p[key] != null).curve(curve).x((p) => X(p.t)).y((p) => Y(p[key]));
    sv.append("path").datum(pts).attr("fill", "rgba(239,83,80,.30)").attr("d", area("rev"));
    sv.append("path").datum(pts).attr("fill", "none").attr("stroke", "#e57373").attr("stroke-width", 1.6).attr("d", line("rev"));
    for (const [clip, fill, stroke] of [[`${uid}a`, "rgba(102,187,106,.45)", "#81c784"], [`${uid}b`, "rgba(229,57,53,.55)", "#ef5350"]]) {
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", fill).attr("d", area("net"));
      sv.append("path").datum(pts).attr("clip-path", `url(#${clip})`).attr("fill", "none").attr("stroke", stroke).attr("stroke-width", 1.6).attr("d", line("net"));
    }
    if (showOp) sv.append("path").datum(pts).attr("fill", "none").attr("stroke", "#ffd54f").attr("stroke-width", 1.4).attr("stroke-dasharray", "5 4").attr("d", line("op"));
    sv.append("line").attr("x1", M.l).attr("x2", W - M.r).attr("y1", Y(0)).attr("y2", Y(0)).attr("stroke", "rgba(255,255,255,.35)");
    // last-value badges on the axis, like the example
    const last = pts[pts.length - 1];
    const badge = (v, color, txt) => {
      if (v == null) return;
      const g = sv.append("g").attr("transform", `translate(${W - M.r + 1},${Y(v)})`);
      g.append("rect").attr("x", 0).attr("y", -9).attr("width", M.r - 2).attr("height", 18).attr("rx", 3).attr("fill", color);
      g.append("text").attr("x", 4).attr("y", 4).attr("font-size", 10.5).attr("fill", "#fff").text(txt);
    };
    badge(last.rev, "#c62828", `R ${fm(last.rev).replace(/<[^>]+>/g, "")}`);
    badge(last.net, last.net >= 0 ? "#2e7d32" : "#b71c1c", `NI ${fm(last.net).replace(/<[^>]+>/g, "")}`);
    // legend
    const lg = sv.append("g").attr("transform", `translate(${M.l + 4},${M.t + 4})`);
    [["#e57373", "Revenue"], ["#81c784", "Net income (red below zero = loss)"], ...(showOp ? [["#ffd54f", "Operating income"]] : [])].forEach(([c, t], k) => {
      lg.append("rect").attr("x", 0).attr("y", k * 15).attr("width", 10).attr("height", 10).attr("fill", c);
      lg.append("text").attr("x", 15).attr("y", k * 15 + 9).attr("font-size", 11).attr("fill", "var(--text)").text(t);
    });
    // hover read-out
    const tip = box.querySelector(".ta-rntip"), hl = sv.append("line").attr("y1", M.t).attr("y2", Hh - M.b).attr("stroke", "rgba(255,255,255,.35)").style("display", "none");
    const dot = sv.append("g").style("display", "none");
    const dr = dot.append("circle").attr("r", 3.5).attr("fill", "#e57373"), dn = dot.append("circle").attr("r", 3.5).attr("fill", "#81c784");
    sv.append("rect").attr("x", M.l).attr("y", M.t).attr("width", W - M.r - M.l).attr("height", Hh - M.t - M.b).attr("fill", "transparent")
      .on("mousemove", (e) => {
        const [mx] = d3.pointer(e), t = X.invert(mx);
        let i = d3.bisector((p) => p.t).center(pts, t);
        const p = pts[i], x = X(p.t);
        hl.attr("x1", x).attr("x2", x).style("display", null);
        dot.style("display", null); dr.attr("cx", x).attr("cy", Y(p.rev ?? 0)); dn.attr("cx", x).attr("cy", Y(p.net ?? 0));
        const m = p.rev > 0 && p.net != null ? p.net / p.rev : null, om = p.rev > 0 && p.op != null ? p.op / p.rev : null;
        tip.innerHTML = `<b>${esc(lbl(p.iso))}</b><br>Revenue ${fm(p.rev, ccy)}<br>Net income <span class="${p.net >= 0 ? "up" : "down"}">${fm(p.net, ccy)}</span>${m != null ? ` · margin ${pp(m, 1)}` : ""}${p.op != null ? `<br>Operating income ${fm(p.op, ccy)}${om != null ? ` · margin ${pp(om, 1)}` : ""}` : ""}`;
        tip.hidden = false;
        tip.style.left = `${Math.min(x + 12, W - 230)}px`; tip.style.top = `${M.t + 30}px`;
      })
      .on("mouseleave", () => { hl.style("display", "none"); dot.style("display", "none"); tip.hidden = true; });
  }

  // ------------------------------------------------------------------ header, symbol chips, indicator panel
  function header() {
    const x = raw;
    $("#ta-head").innerHTML = `<b class="ta-sym">${esc(x.symbol)}</b> <span>${esc(x.name || "")}</span>
      <span class="sub">${esc([x.exchange, x.currency, x.quote_type, x.sector].filter(Boolean).join(" · "))}</span>
      <b class="ta-px">${fp(x.price)}</b> ${x.day != null ? `<span class="${x.day >= 0 ? "up" : "down"}">${x.day > 0 ? "+" : ""}${x.day.toFixed(2)}%</span>` : ""}
      ${x.source ? `<span class="pill" title="Yahoo's data for ${esc(x.symbol)} is short or stale, so prices come from ${esc(x.source)}, another listing of the same fund">via ${esc(x.source)}</span>` : ""}
      ${!x.has_volume ? '<span class="pill" title="Yahoo has no volume for this listing; volume indicators are hidden">no volume data</span>' : ""}`;
  }
  async function chips() {
    if (!state.port) { try { state.port = await api(`/api/portfolio?base=${encodeURIComponent(ctx.base())}`); } catch {} }
    const held = [...new Set((state.port?.positions || []).filter((p) => p.symbol && p.quote_type !== "MANUAL").map((p) => p.symbol))];
    const watch = ((state.settings.ranges || {}).extra || []).filter((s) => !held.includes(s));
    const recent = (S().recent || []).filter((s) => !held.includes(s) && !watch.includes(s));
    const chip = (s, cls) => `<button class="chip ${cls} ${s === view().sym ? "active" : ""}" data-sym="${esc(s)}">${esc(s)}</button>`;
    $("#ta-chips").innerHTML = held.map((s) => chip(s, "")).join("") + watch.map((s) => chip(s, "watch")).join("") + recent.map((s) => chip(s, "recent")).join("");
  }
  function panel() {
    const groups = [...new Set(IND.map((x) => x.g))];
    $("#ta-ind").innerHTML = groups.map((g) => `<div class="ta-grp"><div class="ta-gh">${g}</div>${IND.filter((x) => x.g === g).map((d) => {
      const x = cfg(d.key);
      const params = d.p.map((p) => `<label class="ta-p">${p.l}<input type="number" data-k="${d.key}" data-p="${p.k}" value="${x[p.k]}" min="${p.min}" max="${p.max}" step="${p.step}"></label>`).join("");
      const type = d.ma ? `<select data-k="${d.key}" data-type="1">${MA_TYPES.map((t) => `<option ${t === x.type ? "selected" : ""}>${t}</option>`).join("")}</select>` : "";
      return `<div class="ta-row" ${d.hint ? `title="${esc(d.hint)}"` : ""}><label class="ta-on"><input type="checkbox" data-k="${d.key}" ${x.on ? "checked" : ""}><i style="background:${d.color || "transparent"}"></i>${esc(d.l)}</label>${type}${params}</div>`;
    }).join("")}</div>`).join("");
  }
  function syncPanel() { panel(); }
  function controls() {
    const vw = view();
    $$("#ta-iv button").forEach((b) => b.classList.toggle("active", b.dataset.v === vw.iv));
    $$("#ta-range button").forEach((b) => b.classList.toggle("active", b.dataset.v === vw.range));
    $("#ta-type").value = vw.type;
    $("#ta-log").checked = vw.log;
  }

  async function open(sym) {
    sym = (sym || "").trim().toUpperCase();
    if (!sym) return;
    if (sym !== rawSym) {
      const recent = [sym, ...(S().recent || []).filter((s) => s !== sym)].slice(0, 8);
      saveTA({ symbol: sym, recent });
    }
    $("#ta-search").value = "";
    if (measureLine) measureLine = null;
    hint("");
    chips();
    if (!(await load(sym))) return;
    header(); controls();
    build(true);
    loadVal(sym);
    loadFin(sym);
    loadRevNi(sym);
  }

  // ------------------------------------------------------------------ events
  attachSearch($("#ta-search"), (it) => open(it.symbol));
  $("#ta-search").addEventListener("keydown", (e) => { if (e.key === "Enter" && $("#ta-search").value.trim()) setTimeout(() => $("#ta-search").value.trim() && open($("#ta-search").value), 0); });
  $("#ta-chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-sym]"); if (b) open(b.dataset.sym); });
  $("#ta-iv").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; saveTA({ interval: b.dataset.v }); controls(); if (raw) build(true); });
  $("#ta-range").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    saveTA({ range: b.dataset.v }); controls();
    if (!raw) return;
    if (b.dataset.v === "All" && rawYears < 30) { await load(view().sym, 30); }
    build(true);
  });
  $("#ta-type").addEventListener("change", (e) => { saveTA({ type: e.target.value }); if (raw) build(); });
  $("#ta-log").addEventListener("change", (e) => { saveTA({ log: e.target.checked }); if (main) main.priceScale().applyOptions({ mode: e.target.checked ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal }); });
  $("#ta-ind").addEventListener("change", (e) => {
    const t = e.target, k = t.dataset.k;
    if (!k) return;
    if (t.type === "checkbox") setCfg(k, { on: t.checked });
    else if (t.dataset.type) setCfg(k, { type: t.value });
    else if (t.dataset.p) { const v = +t.value; if (!isFinite(v)) return; setCfg(k, { [t.dataset.p]: v }); }
    if (raw) build();
  });
  $("#ta-reset").addEventListener("click", () => { saveTA({ ind: {} }); panel(); if (raw) build(); });
  $("#ta-revni").addEventListener("click", (e) => { const b = e.target.closest("#ta-rnmode button"); if (b && !b.disabled) { saveTA({ rn_mode: b.dataset.v }); renderRevNi(); } });
  $("#ta-revni").addEventListener("change", (e) => {
    if (e.target.id === "ta-rnop") { saveTA({ rn_op: e.target.checked }); renderRevNi(); }
    if (e.target.id === "ta-rnsmooth") { saveTA({ rn_smooth: e.target.checked }); renderRevNi(); }
  });
  $("#ta-fin").addEventListener("click", (e) => {
    const b = e.target.closest("#ta-finfreq button");
    if (b && !b.disabled) { saveTA({ fin_freq: b.dataset.v }); renderFin(); }
  });
  $("#ta-val").addEventListener("click", (e) => { const b = e.target.closest(".ta-peer"); if (b) { open(b.dataset.sym); window.scrollTo(0, 0); } });
  $("#ta-altp").addEventListener("change", (e) => {
    const t2 = e.target, k = t2.dataset.alt, f = t2.dataset.f;
    if (!k || !f) return;
    setAlt(k, { [f]: f === "mode" ? t2.value : +t2.value });
    altParams(); altRender();
  });
  $("#ta-tools").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.tool) setTool(tool === b.dataset.tool ? "cursor" : b.dataset.tool);
    if (b.id === "ta-fit" && chart) chart.timeScale().fitContent();
    if (b.id === "ta-reload" && view().sym) { raw = null; open(view().sym); }
  });
  $("#ta-hint").addEventListener("click", (e) => {
    if (e.target.id === "ta-mclear") { if (measureLine) { try { chart.removeSeries(measureLine); } catch {} measureLine = null; } hint(""); }
  });
  $("#ta-drawings").addEventListener("click", (e) => {
    if (e.target.id === "ta-clear") { if (confirm("Delete all drawings on this chart?")) { setDrawings([]); priceLines(); drawDrawings(); } return; }
    const b = e.target.closest("button[data-i]"); if (!b) return;
    const ds = drawings().slice(); ds.splice(+b.dataset.i, 1); setDrawings(ds); priceLines(); drawDrawings();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tool !== "cursor" && !$("#view-ta").hidden) setTool("cursor"); });

  async function show() {
    panel(); controls();
    if (!view().sym) {
      await chips();                      // loads the portfolio if it isn't yet
      const first = [...(state.port?.positions || [])].sort((a, b) => (b.value || 0) - (a.value || 0)).find((p) => p.symbol && p.quote_type !== "MANUAL");
      if (first) saveTA({ symbol: first.symbol });
    }
    if (view().sym) await open(view().sym);
    else { chips(); $("#ta-head").innerHTML = '<span class="hint">Search a ticker to start.</span>'; }
  }
  // periodic / manual refresh: refetch at most every 5 minutes (or on demand) and redraw keeping the zoom
  let loadedAt = 0;
  async function refresh(silent) {
    if (!view().sym || (silent && Date.now() - loadedAt < 5 * 60e3)) return;
    const prevLast = raw?.bars?.[raw.bars.length - 1]?.join();
    raw = null;
    if (!(await load(view().sym))) return;
    header();
    if (!silent || raw.bars[raw.bars.length - 1].join() !== prevLast) build();
  }
  if (location.search.includes("debug")) window.__ta = { chart: () => chart, main: () => main, D: () => D };
  return { show, open, refresh };
};
