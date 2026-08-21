// ============================================================================
// CONFIG — the one thing you MUST edit before this works
// ============================================================================
const WORKER_URL = "https://market-dashboard-proxy.lopezdunn90.workers.dev";
const REFRESH_MS = 15000; // 15s. Alpaca free tier allows 200 req/min — plenty of headroom.

// ============================================================================
// STATE — persisted only in this browser, never sent to GitHub
// ============================================================================
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

let state = {
  focusTicker: store.get("md_focus_ticker", "AMC"),
  watchlist: store.get("md_watchlist", ["AAPL", "NVDA", "SPY", "TSLA", "AMD"]),
  stocks: store.get("md_stocks", []),       // {ticker, shares, costBasis}
  options: store.get("md_options", []),     // {ticker, expiry, strike, type, contracts, premium}
  // {type: "price", ticker, direction, level}
  // {type: "volume", ticker, multiple}
  // {type: "iv", optionKey, label, thresholdPts, ivBaseline}
  // {type: "dte", optionKey, label, thresholdDays}
  // migration: legacy entries predate `type` — they're always price alerts.
  alerts: store.get("md_alerts", []).map(a => ({ type: "price", ...a })),
};

function persist() {
  store.set("md_focus_ticker", state.focusTicker);
  store.set("md_watchlist", state.watchlist);
  store.set("md_stocks", state.stocks);
  store.set("md_options", state.options);
  store.set("md_alerts", state.alerts);
}

// ============================================================================
// DATA FETCH
// ============================================================================
async function fetchQuotes(symbols) {
  if (!symbols.length) return {};
  const res = await fetch(`${WORKER_URL}/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!res.ok) throw new Error(`quotes fetch failed: ${res.status}`);
  const data = await res.json();
  const snapshots = data.snapshots || data; // tolerate either response shape
  const out = {};
  for (const [sym, snap] of Object.entries(snapshots || {})) {
    if (!snap) continue;
    const q = snap.latestQuote || {};
    const bid = parseFloat(q.bp || 0), ask = parseFloat(q.ap || 0);
    const trade = snap.latestTrade && snap.latestTrade.p ? parseFloat(snap.latestTrade.p) : 0;
    const price = bid && ask ? (bid + ask) / 2 : (ask || bid || trade);
    const prevClose = snap.prevDailyBar && snap.prevDailyBar.c != null ? parseFloat(snap.prevDailyBar.c) : null;
    // Cumulative volume for *today so far* — partial during market hours, so a
    // volume-spike check against a full prior-day average under-fires early in
    // the session and is most meaningful later in the day. That's an inherent
    // property of comparing a running total to a historical average, not a bug.
    const todayVolume = snap.dailyBar && snap.dailyBar.v != null ? snap.dailyBar.v : null;
    // Today's daily bar so far — gives an intraday high/low for the day-range
    // meter, same partial-day caveat as todayVolume above.
    const dayHigh = snap.dailyBar && snap.dailyBar.h != null ? parseFloat(snap.dailyBar.h) : null;
    const dayLow = snap.dailyBar && snap.dailyBar.l != null ? parseFloat(snap.dailyBar.l) : null;
    out[sym] = { price, bid, ask, prevClose, todayVolume, dayHigh, dayLow };
  }
  return out;
}

function occSymbol(ticker, expiry, strike, type) {
  const [y, m, d] = expiry.split("-");
  const yy = y.slice(2);
  const cp = type === "call" ? "C" : "P";
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker}${yy}${m}${d}${cp}${strikeStr}`;
}

// Stable identity for an option position — array index shifts when positions
// are added/removed, so iv/dte alerts reference this instead.
function optionKeyFor(o) {
  return `${o.ticker}|${o.expiry}|${o.strike}|${o.type}`;
}
function optionLabelFor(o) {
  return `${o.ticker} $${o.strike} ${o.type.toUpperCase()} ${o.expiry}`;
}

async function fetchOptionSnapshot(ticker, expiry) {
  const res = await fetch(`${WORKER_URL}/api/options?symbol=${encodeURIComponent(ticker)}&expiration=${expiry}`);
  if (!res.ok) throw new Error(`options fetch failed: ${res.status}`);
  const data = await res.json();
  return data.snapshots || {};
}

function markFromSnapshot(snap) {
  if (!snap) return 0;
  const q = snap.latestQuote;
  if (q && q.bp && q.ap) return (parseFloat(q.bp) + parseFloat(q.ap)) / 2;
  if (snap.latestTrade && snap.latestTrade.p) return parseFloat(snap.latestTrade.p);
  return 0;
}

// Alpaca returns impliedVolatility as a fraction (0.2476) — we track/display
// it in percentage points (24.76) since that's the natural unit for a
// "moved more than N points" threshold.
function ivFromSnapshot(snap) {
  return snap && snap.impliedVolatility != null ? parseFloat(snap.impliedVolatility) * 100 : null;
}

// ============================================================================
// RENDERING
// ============================================================================
const money = (x) => (x < 0 ? `-$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pnlClass = (x) => (x > 0 ? "gain" : x < 0 ? "loss" : "");

function renderWatchlist(quotes) {
  const body = document.getElementById("watchlist-body");
  body.innerHTML = state.watchlist.map(t => {
    const q = quotes[t];
    if (!q) return `<tr><td class="tk">${t}</td><td class="num muted" colspan="2">no data</td></tr>`;
    const chg = q.prevClose ? q.price - q.prevClose : 0;
    const pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
    return `<tr>
      <td class="tk">${t}</td>
      <td class="num">${money(q.price)}</td>
      <td class="num ${pnlClass(chg)}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</td>
    </tr>`;
  }).join("");
}

function allKnownTickers() {
  // price/volume alerts carry a bare `.ticker`; iv/dte alerts carry `.optionKey`
  // instead, so this naturally excludes them.
  const alertTickers = state.alerts.filter(a => a.ticker).map(a => a.ticker);
  return [...new Set([state.focusTicker, ...state.watchlist, ...state.stocks.map(s => s.ticker), ...alertTickers])];
}

function renderTickerTape(quotes) {
  const track = document.getElementById("ticker-track");
  const symbols = allKnownTickers();
  if (!symbols.length) { track.innerHTML = ""; return; }
  const items = symbols.map(sym => {
    const q = quotes[sym];
    if (!q) return `<span class="ticker-item"><span class="tk">${sym}</span><span class="muted">—</span></span>`;
    const chg = q.prevClose ? q.price - q.prevClose : 0;
    const pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
    const cls = pnlClass(chg);
    const arrow = chg > 0 ? "&#9650;" : chg < 0 ? "&#9660;" : "&#8226;";
    return `<span class="ticker-item">
      <span class="tk">${sym}</span>
      <span>${money(q.price)}</span>
      <span class="${cls}"><span class="arrow">${arrow}</span> ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>
    </span>`;
  }).join("");
  // duplicated once so the marquee loop (translateX -50%) is seamless
  track.innerHTML = items + items;
}

function renderStocks(quotes) {
  const body = document.getElementById("stocks-body");
  let totalPnl = 0;
  body.innerHTML = state.stocks.map((s, i) => {
    const q = quotes[s.ticker];
    const price = q ? q.price : s.costBasis;
    const pnl = (price - s.costBasis) * s.shares;
    totalPnl += pnl;
    const pct = ((price - s.costBasis) / s.costBasis) * 100;
    return `<tr>
      <td class="tk">${s.ticker}</td>
      <td class="num">${s.shares}</td>
      <td class="num">${money(s.costBasis)}</td>
      <td class="num">${money(price)}</td>
      <td class="num ${pnlClass(pnl)}">${money(pnl)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</td>
      <td><button class="btn-remove" data-remove-stock="${i}">&times;</button></td>
    </tr>`;
  }).join("");
  return totalPnl;
}

function renderOptions(quotes, optionMarks) {
  const body = document.getElementById("options-body");
  let totalPnl = 0;
  body.innerHTML = state.options.map((o, i) => {
    const spot = quotes[o.ticker] ? quotes[o.ticker].price : null;
    const mark = optionMarks[i] ?? 0;
    const cost = o.premium * 100 * o.contracts;
    const value = mark * 100 * o.contracts;
    const pnl = value - cost;
    totalPnl += pnl;
    const pnlPct = cost ? (pnl / cost) * 100 : 0;
    const breakeven = o.type === "call" ? o.strike + o.premium : o.strike - o.premium;
    const beDist = spot ? (o.type === "call" ? ((spot - breakeven) / breakeven) * 100
                                              : ((breakeven - spot) / breakeven) * 100) : 0;
    const marker = Math.max(0, Math.min(100, (beDist + 10) / 20 * 100));
    const dte = Math.max(0, Math.round((new Date(o.expiry) - new Date()) / 86400000));
    return `<div class="opt-card">
      <div class="opt-head">
        <span class="tk">${o.ticker} $${o.strike} ${o.type.toUpperCase()} ${o.expiry}</span>
        <span class="num ${pnlClass(pnl)}">${money(pnl)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)</span>
        <button class="btn-remove" data-remove-option="${i}">&times;</button>
      </div>
      <div class="opt-grid">
        <div><span class="lbl">Contracts</span>${o.contracts}</div>
        <div><span class="lbl">Paid</span>${money(o.premium)}/sh</div>
        <div><span class="lbl">Mark</span>${money(mark)}/sh</div>
        <div><span class="lbl">Value</span>${money(value)}</div>
        <div><span class="lbl">Spot</span>${spot ? money(spot) : "—"}</div>
        <div><span class="lbl">DTE</span>${dte}d</div>
      </div>
      <div class="be-wrap">
        <div class="be-labels"><span>Break-even ${money(breakeven)}</span>
        <span>${Math.abs(beDist).toFixed(1)}% ${beDist >= 0 ? "past" : "below"} break-even</span></div>
        <div class="be-strip"><div class="be-zero"></div>
        <div class="be-marker ${pnlClass(beDist)}" style="left:${marker}%"></div></div>
      </div>
    </div>`;
  }).join("") || `<p class="muted">No option positions yet — click + Add.</p>`;
  return totalPnl;
}

function renderAlerts(quotes, optionIVs) {
  const body = document.getElementById("alerts-body");
  const fired = [];
  let baselinesChanged = false;

  body.innerHTML = state.alerts.map((a, i) => {
    let isFired = false;
    let label = a.ticker || a.label || a.optionKey || "—";
    let condText = "";

    if (a.type === "volume") {
      const q = quotes[a.ticker];
      const avgVol = trendCache[a.ticker] && trendCache[a.ticker].avgVolume20;
      condText = `Volume &ge; ${a.multiple}&times; 20d avg`;
      if (q && q.todayVolume != null && avgVol) {
        isFired = q.todayVolume >= avgVol * a.multiple;
        if (isFired) {
          fired.push(`${a.ticker} volume is ${(q.todayVolume / avgVol).toFixed(1)}&times; its 20-day average`);
        }
      } else {
        condText += ` <span class="muted">(building history…)</span>`;
      }
    } else if (a.type === "iv") {
      const currentIV = optionIVs ? optionIVs[a.optionKey] : null;
      condText = `IV &Delta; &gt; ${a.thresholdPts}pt`;
      if (currentIV != null) {
        if (a.ivBaseline == null) {
          a.ivBaseline = currentIV; // first observation becomes the baseline
          baselinesChanged = true;
        } else {
          const delta = currentIV - a.ivBaseline;
          isFired = Math.abs(delta) >= a.thresholdPts;
          if (isFired) {
            fired.push(`${label} IV moved ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pt `
              + `(${a.ivBaseline.toFixed(1)}% &rarr; ${currentIV.toFixed(1)}%)`);
          }
        }
        condText += ` <span class="muted">(base ${a.ivBaseline != null ? a.ivBaseline.toFixed(1) : "—"}%, now ${currentIV.toFixed(1)}%)</span>`;
      } else {
        condText += ` <span class="muted">(no quote yet)</span>`;
      }
    } else if (a.type === "dte") {
      const opt = state.options.find(o => optionKeyFor(o) === a.optionKey);
      condText = `Warn at &le; ${a.thresholdDays}d`;
      if (opt) {
        const dte = Math.max(0, Math.round((new Date(opt.expiry) - new Date()) / 86400000));
        isFired = dte <= a.thresholdDays;
        condText += ` <span class="muted">(${dte}d left)</span>`;
        if (isFired) fired.push(`${label} expires in ${dte}d (&le; ${a.thresholdDays}d threshold)`);
      } else {
        condText += ` <span class="muted">(position removed)</span>`;
      }
    } else { // "price"
      const q = quotes[a.ticker];
      condText = `${a.direction} ${money(a.level)}`;
      isFired = q && ((a.direction === "above" && q.price >= a.level) || (a.direction === "below" && q.price <= a.level));
      if (isFired) fired.push(`${a.ticker} is ${a.direction} ${money(a.level)} — now ${money(q.price)}`);
    }

    return `<tr>
      <td class="tk">${escapeHtml(label)}</td>
      <td class="${isFired ? "warn" : ""}">${condText}</td>
      <td><button class="btn-remove" data-remove-alert="${i}">&times;</button></td>
    </tr>`;
  }).join("");

  document.getElementById("alerts-section").innerHTML = fired.length
    ? fired.map(f => `<div class="alert-item">&#9650; ${f}</div>`).join("")
    : "";

  // IV alerts capture their baseline lazily (see above) — persist it so a
  // page reload doesn't re-baseline against a different moment.
  if (baselinesChanged) persist();
}

function bindRemoveButtons() {
  document.querySelectorAll("[data-remove-stock]").forEach(btn =>
    btn.onclick = () => { state.stocks.splice(+btn.dataset.removeStock, 1); persist(); refresh(); });
  document.querySelectorAll("[data-remove-option]").forEach(btn =>
    btn.onclick = () => {
      const idx = +btn.dataset.removeOption;
      const removed = state.options[idx];
      state.options.splice(idx, 1);
      // iv/dte alerts reference a specific position — drop any left orphaned.
      if (removed) {
        const key = optionKeyFor(removed);
        state.alerts = state.alerts.filter(a => !((a.type === "iv" || a.type === "dte") && a.optionKey === key));
      }
      persist(); refresh();
    });
  document.querySelectorAll("[data-remove-alert]").forEach(btn =>
    btn.onclick = () => { state.alerts.splice(+btn.dataset.removeAlert, 1); persist(); refresh(); });
}

// ============================================================================
// CANDLESTICK CHART
// ============================================================================
// intervalLabel is shown on the button itself and in the chart stats bar —
// the range presets bundle a lookback AND a bar size together, but nothing
// in the UI surfaced the bar size before, which read as "no 5-min option"
// even though 1D/5D already use 5-minute bars.
const CHART_RANGES = [
  { id: "1D", label: "1D", timeframe: "5Min", intervalLabel: "5m", lookbackDays: 6, intraday: true, singleSession: true },
  { id: "5D", label: "5D", timeframe: "5Min", intervalLabel: "5m", lookbackDays: 8, intraday: true },
  { id: "1W", label: "1W", timeframe: "15Min", intervalLabel: "15m", lookbackDays: 9, intraday: true },
  { id: "1M", label: "1M", timeframe: "1Day", intervalLabel: "1d", lookbackDays: 35 },
  { id: "3M", label: "3M", timeframe: "1Day", intervalLabel: "1d", lookbackDays: 100 },
  { id: "6M", label: "6M", timeframe: "1Day", intervalLabel: "1d", lookbackDays: 200 },
  { id: "YTD", label: "YTD", timeframe: "1Day", intervalLabel: "1d", ytd: true },
  { id: "1Y", label: "1Y", timeframe: "1Day", intervalLabel: "1d", lookbackDays: 370 },
  { id: "5Y", label: "5Y", timeframe: "1Week", intervalLabel: "1wk", lookbackDays: 1830 },
];
const CHART_TYPES = [
  { id: "candle", label: "Candles" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
];
const MA_PERIODS = [
  { period: 20, color: "#f4b860" },
  { period: 50, color: "#6d8bff" },
  { period: 200, color: "#ff7a6e" },
];

let chart, priceSeries, volumeSeries;
let chartSymbol = null;
let chartRangeId = "6M";
let chartType = "candle";
let maEnabled = { 20: false, 50: false, 200: false };
let maSeriesMap = {};
let currentBars = [];
let currentRange = null;

function toChartTime(iso, range) {
  return range && range.intraday ? Math.floor(new Date(iso).getTime() / 1000) : iso.slice(0, 10);
}

async function fetchBars(symbol, range) {
  const limit = range.intraday ? 1000 : 500;
  const start = range.ytd
    ? `${new Date().getFullYear()}-01-01`
    : new Date(Date.now() - range.lookbackDays * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${WORKER_URL}/api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${range.timeframe}&limit=${limit}&start=${start}`);
  if (!res.ok) throw new Error(`bars fetch failed: ${res.status}`);
  const data = await res.json();
  let bars = data.bars || [];
  if (range.singleSession && bars.length) {
    const lastDay = bars[bars.length - 1].t.slice(0, 10);
    bars = bars.filter(b => b.t.slice(0, 10) === lastDay);
  }
  return bars;
}

function createPriceSeries() {
  if (priceSeries) { chart.removeSeries(priceSeries); priceSeries = null; }
  if (chartType === "line") {
    priceSeries = chart.addLineSeries({ color: "#6d8bff", lineWidth: 2 });
  } else if (chartType === "area") {
    priceSeries = chart.addAreaSeries({
      lineColor: "#6d8bff", lineWidth: 2,
      topColor: "rgba(109, 139, 255, 0.35)", bottomColor: "rgba(109, 139, 255, 0.02)",
    });
  } else {
    priceSeries = chart.addCandlestickSeries({
      upColor: "#3ecfb2", downColor: "#ff7a6e",
      borderUpColor: "#3ecfb2", borderDownColor: "#ff7a6e",
      wickUpColor: "#3ecfb2", wickDownColor: "#ff7a6e",
    });
  }
}

function ensureChart() {
  if (chart || typeof LightweightCharts === "undefined") return;
  const el = document.getElementById("chart-container");
  chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad", fontFamily: "'JetBrains Mono', Consolas, monospace" },
    grid: {
      vertLines: { color: "rgba(37, 49, 80, 0.5)" },
      horzLines: { color: "rgba(37, 49, 80, 0.5)" },
    },
    rightPriceScale: { borderColor: "#253150" },
    timeScale: { borderColor: "#253150" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });
  createPriceSeries();
  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    color: "#253150",
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  chart.subscribeCrosshairMove(param => {
    if (!currentBars.length) return;
    if (!param || !param.time) { updateLegend(currentBars[currentBars.length - 1]); return; }
    const match = currentBars.find(b => toChartTime(b.t, currentRange) === param.time);
    updateLegend(match || currentBars[currentBars.length - 1]);
  });
}

function computeSMA(bars, period) {
  if (bars.length < period) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out.push({ time: toChartTime(bars[i].t, currentRange), value: sum / period });
  }
  return out;
}

function updateMAs() {
  MA_PERIODS.forEach(m => {
    const key = m.period;
    const shouldShow = maEnabled[key] && currentBars.length >= key;
    if (shouldShow) {
      if (!maSeriesMap[key]) {
        maSeriesMap[key] = chart.addLineSeries({
          color: m.color, lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
      }
      maSeriesMap[key].applyOptions({ visible: true });
      maSeriesMap[key].setData(computeSMA(currentBars, key));
    } else if (maSeriesMap[key]) {
      maSeriesMap[key].applyOptions({ visible: false });
    }
  });
}

let refLines = [];
function updateReferenceLines() {
  refLines.forEach(pl => { try { priceSeries.removePriceLine(pl); } catch { /* series was swapped */ } });
  refLines = [];
  const pos = state.stocks.find(s => s.ticker === chartSymbol);
  if (pos) {
    refLines.push(priceSeries.createPriceLine({
      price: pos.costBasis, color: "#f4b860", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "cost basis",
    }));
  }
  state.alerts.filter(a => a.ticker === chartSymbol).forEach(a => {
    refLines.push(priceSeries.createPriceLine({
      price: a.level, color: "#8b96ad", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: `alert ${a.direction}`,
    }));
  });
}

function updateStatsBar() {
  const el = document.getElementById("chart-stats");
  if (!currentBars.length) { el.innerHTML = ""; return; }
  const rangeHigh = Math.max(...currentBars.map(b => b.h));
  const rangeLow = Math.min(...currentBars.map(b => b.l));
  const first = currentBars[0].o, last = currentBars[currentBars.length - 1].c;
  const chg = last - first, pct = first ? (chg / first) * 100 : 0;
  el.innerHTML = `
    <span>Interval <strong class="mono">${currentRange.intervalLabel}</strong></span>
    <span>Range <strong class="mono">${money(rangeLow)}–${money(rangeHigh)}</strong></span>
    <span>Period <strong class="mono ${pnlClass(chg)}">${chg >= 0 ? "+" : ""}${money(chg)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</strong></span>`;
}

function updateLegend(bar) {
  const el = document.getElementById("chart-legend");
  if (!bar) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="tk">${chartSymbol}</span>
    <span>O <strong class="mono">${money(bar.o)}</strong></span>
    <span>H <strong class="mono">${money(bar.h)}</strong></span>
    <span>L <strong class="mono">${money(bar.l)}</strong></span>
    <span>C <strong class="mono ${pnlClass(bar.c - bar.o)}">${money(bar.c)}</strong></span>
    <span>Vol <strong class="mono">${Number(bar.v).toLocaleString()}</strong></span>`;
}

function drawChart() {
  if (!chart || !currentRange) return;
  chart.applyOptions({ timeScale: { timeVisible: !!currentRange.intraday, borderColor: "#253150" } });
  if (chartType === "candle") {
    priceSeries.setData(currentBars.map(b => ({ time: toChartTime(b.t, currentRange), open: b.o, high: b.h, low: b.l, close: b.c })));
  } else {
    priceSeries.setData(currentBars.map(b => ({ time: toChartTime(b.t, currentRange), value: b.c })));
  }
  volumeSeries.setData(currentBars.map(b => ({
    time: toChartTime(b.t, currentRange), value: b.v,
    color: b.c >= b.o ? "rgba(62, 207, 178, 0.5)" : "rgba(255, 122, 110, 0.5)",
  })));
  updateMAs();
  updateReferenceLines();
  updateStatsBar();
  updateLegend(currentBars[currentBars.length - 1]);
  chart.timeScale().fitContent();
}

// Applies only the bars that changed since the last draw, via lightweight-charts'
// incremental `.update()` — unlike drawChart(), this never calls fitContent(),
// so the user's zoom/pan stays put while fresh ticks stream in. This is what
// makes the live-poll loop below feel live instead of jarring.
function applyIncrementalBars(newBars, range) {
  if (!newBars.length) return;
  const prevLastTime = currentBars.length ? toChartTime(currentBars[currentBars.length - 1].t, range) : null;
  let startIdx = 0;
  if (prevLastTime != null) {
    const idx = newBars.findIndex(b => toChartTime(b.t, range) === prevLastTime);
    startIdx = idx >= 0 ? idx : Math.max(0, newBars.length - 1);
  }
  for (let i = startIdx; i < newBars.length; i++) {
    const b = newBars[i];
    const t = toChartTime(b.t, range);
    if (chartType === "candle") {
      priceSeries.update({ time: t, open: b.o, high: b.h, low: b.l, close: b.c });
    } else {
      priceSeries.update({ time: t, value: b.c });
    }
    volumeSeries.update({
      time: t, value: b.v,
      color: b.c >= b.o ? "rgba(62, 207, 178, 0.5)" : "rgba(255, 122, 110, 0.5)",
    });
  }
  currentBars = newBars;
  updateMAs();
  updateReferenceLines();
  updateStatsBar();
  updateLegend(currentBars[currentBars.length - 1]);
}

// Fast polling for the actively-viewed chart, "as live as possible" without
// a WebSocket relay: Alpaca allows only one streaming connection per API
// key, so a true live feed would need a Durable Object to fan out a single
// shared upstream connection — real infra for a single-user dashboard.
// Polling one symbol's bars every few seconds (well under the 200/min free
// tier limit) gets most of the benefit with none of that risk. Only runs
// for intraday ranges — daily/weekly bars don't change fast enough to
// justify it, and the main 15s refresh loop already keeps those current.
const LIVE_POLL_MS = 5000;
let liveChartTimer = null;

function stopLiveChartPolling() {
  if (liveChartTimer) { clearInterval(liveChartTimer); liveChartTimer = null; }
  const badge = document.getElementById("chart-live-badge");
  if (badge) badge.hidden = true;
}

function startLiveChartPolling() {
  stopLiveChartPolling();
  if (!currentRange || !currentRange.intraday || !chartSymbol) return;
  document.getElementById("chart-live-badge").hidden = false;
  const symbol = chartSymbol, range = currentRange;
  liveChartTimer = setInterval(async () => {
    if (chartSymbol !== symbol || currentRange !== range) { stopLiveChartPolling(); return; }
    try {
      applyIncrementalBars(await fetchBars(symbol, range), range);
    } catch (e) {
      console.warn(`live chart poll failed for ${symbol}:`, e);
    }
  }, LIVE_POLL_MS);
}

async function loadChart() {
  ensureChart();
  if (!chart || !chartSymbol) { stopLiveChartPolling(); return; }
  currentRange = CHART_RANGES.find(r => r.id === chartRangeId) || CHART_RANGES[4];
  try {
    currentBars = await fetchBars(chartSymbol, currentRange);
  } catch (e) {
    console.warn(`chart data failed for ${chartSymbol}:`, e);
    currentBars = [];
  }
  drawChart();
  startLiveChartPolling();
}

function selectChartSymbol(sym) {
  chartSymbol = sym.trim().toUpperCase();
  renderChartSymbolPicker();
  loadChart();
}

function renderChartSymbolPicker() {
  const wrap = document.getElementById("chart-symbols");
  let symbols = allKnownTickers();
  if (!chartSymbol) chartSymbol = symbols[0] || null;
  if (chartSymbol && !symbols.includes(chartSymbol)) symbols = [...symbols, chartSymbol];
  if (!symbols.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = symbols.map(s =>
    `<button class="chip ${s === chartSymbol ? "active" : ""}" data-sym="${s}">${s}</button>`
  ).join("");
  wrap.querySelectorAll("[data-sym]").forEach(btn => btn.onclick = () => selectChartSymbol(btn.dataset.sym));
}

function renderRangeSelector() {
  const wrap = document.getElementById("chart-ranges");
  wrap.innerHTML = CHART_RANGES.map(r =>
    `<button data-range="${r.id}" class="${r.id === chartRangeId ? "active" : ""}" title="${r.intervalLabel} bars">${r.label}<span class="range-interval">${r.intervalLabel}</span></button>`
  ).join("");
  wrap.querySelectorAll("[data-range]").forEach(btn => btn.onclick = () => {
    chartRangeId = btn.dataset.range;
    renderRangeSelector();
    loadChart();
  });
}

function renderTypeSelector() {
  const wrap = document.getElementById("chart-types");
  wrap.innerHTML = CHART_TYPES.map(t =>
    `<button data-type="${t.id}" class="${t.id === chartType ? "active" : ""}">${t.label}</button>`
  ).join("");
  wrap.querySelectorAll("[data-type]").forEach(btn => btn.onclick = () => {
    chartType = btn.dataset.type;
    renderTypeSelector();
    createPriceSeries();
    drawChart();
  });
}

function renderMaToggles() {
  const wrap = document.getElementById("chart-mas");
  wrap.innerHTML = MA_PERIODS.map(m =>
    `<button data-ma="${m.period}" class="ma-toggle ${maEnabled[m.period] ? "active" : ""}" style="--ma-color:${m.color}">MA${m.period}</button>`
  ).join("");
  wrap.querySelectorAll("[data-ma]").forEach(btn => btn.onclick = () => {
    const p = btn.dataset.ma;
    maEnabled[p] = !maEnabled[p];
    renderMaToggles();
    updateMAs();
  });
}

document.getElementById("chart-search-form").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("chart-search-input");
  const sym = input.value.trim();
  if (!sym) return;
  input.value = "";
  selectChartSymbol(sym);
};

// ============================================================================
// TREND TRACKER — technical indicators computed from price history.
// Informational signals only, not financial advice or a recommendation.
// ============================================================================
function seriesEMA(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let ema;
  values.forEach((v, i) => {
    ema = i === 0 ? v : v * k + ema * (1 - k);
    out.push(ema);
  });
  return out;
}

function latestRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function latestMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = seriesEMA(closes, 12);
  const ema26 = seriesEMA(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = seriesEMA(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  const last = hist.length - 1;
  return { macd: macdLine[last], signal: signalLine[last], hist: hist[last], prevHist: hist[last - 1] };
}

function smaAt(closes, period, endIndexExclusive) {
  if (endIndexExclusive < period) return null;
  const slice = closes.slice(endIndexExclusive - period, endIndexExclusive);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Combines trend (price vs. a moving average + its slope), momentum (RSI),
// and MACD into a single read. `continuationWarning` fires only when
// several bearish signals line up AND RSI isn't already deeply oversold
// (extreme oversold often precedes a bounce, not more downside).
// `periodLabel` only affects the wording of the moving-average reasons —
// the math is identical whether `bars` is daily or intraday; the caller
// decides what a "50-period" average means by what it fetches.
function analyzeTrend(bars, periodLabel = "50-day") {
  const closes = bars.map(b => b.c);
  if (closes.length < 30) return null;

  const price = closes[closes.length - 1];
  const sma50 = smaAt(closes, Math.min(50, closes.length), closes.length);
  const sma50Prev = closes.length >= 60 ? smaAt(closes, Math.min(50, closes.length - 10), closes.length - 10) : null;
  const rsi = latestRSI(closes, 14);
  const macd = latestMACD(closes);

  const recentLow = Math.min(...bars.slice(-10).map(b => b.l));
  const priorLow = bars.length >= 20 ? Math.min(...bars.slice(-20, -10).map(b => b.l)) : null;
  const makingLowerLows = priorLow != null && recentLow < priorLow;

  let bearish = 0, bullish = 0;
  const reasons = [];

  if (sma50 != null) {
    if (price < sma50) { bearish++; reasons.push(`Below ${periodLabel} average`); }
    else { bullish++; reasons.push(`Above ${periodLabel} average`); }
  }
  if (sma50Prev != null && sma50 != null) {
    if (sma50 < sma50Prev) { bearish++; reasons.push(`${periodLabel} average declining`); }
    else { bullish++; }
  }
  if (macd) {
    if (macd.hist < 0) {
      bearish += macd.hist < macd.prevHist ? 1 : 0.5;
      reasons.push(macd.hist < macd.prevHist ? "MACD bearish & widening" : "MACD below signal line");
    } else {
      bullish++;
    }
  }
  if (rsi != null) {
    if (rsi < 30) reasons.push(`RSI ${rsi.toFixed(0)} — oversold (reversal risk)`);
    else if (rsi < 45) { bearish++; reasons.push(`RSI ${rsi.toFixed(0)} — weak momentum`); }
    else if (rsi > 55) { bullish++; }
  }
  if (makingLowerLows) { bearish++; reasons.push("Making lower lows"); }

  let trend = "Sideways";
  if (bearish >= 3) trend = "Downtrend";
  else if (bullish >= 3) trend = "Uptrend";

  const deeplyOversold = rsi != null && rsi < 25;
  const continuationWarning = trend === "Downtrend" && bearish >= 3.5 && !deeplyOversold;

  // 20-day average volume, for volume-spike alerts — excludes today's bar
  // (still accumulating intraday, would skew a "typical day" baseline low).
  const volBars = bars.slice(0, -1).slice(-20);
  const avgVolume20 = volBars.length ? volBars.reduce((s, b) => s + b.v, 0) / volBars.length : null;

  return { trend, bearish, bullish, reasons, rsi, macd, continuationWarning, avgVolume20 };
}

async function fetchHistBars(symbol, timeframe, lookbackDays, limit) {
  const start = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${WORKER_URL}/api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&start=${start}`);
  if (!res.ok) throw new Error(`bars fetch failed: ${res.status}`);
  const data = await res.json();
  return data.bars || [];
}
const fetchDailyBars = (symbol, lookbackDays = 220) => fetchHistBars(symbol, "1Day", lookbackDays, 250);
// 5 calendar days comfortably covers 2-3 trading sessions of 5-min bars —
// plenty for the 60-bar lookback analyzeTrend wants for its slope check.
const fetchPulseBars = (symbol, lookbackDays = 5) => fetchHistBars(symbol, "5Min", lookbackDays, 500);

let trendCache = {};
let pulseCache = {};

async function updateCache(setCache, render, fetchBarsFor, periodLabel) {
  const symbols = allKnownTickers();
  const entries = await Promise.all(symbols.map(async sym => {
    try { return [sym, analyzeTrend(await fetchBarsFor(sym), periodLabel)]; }
    catch (e) { console.warn(`trend fetch failed for ${sym}:`, e); return [sym, null]; }
  }));
  setCache(Object.fromEntries(entries));
  render();
}
const updateTrends = () => updateCache(c => (trendCache = c), renderTrends, fetchDailyBars, "50-day");
const updatePulse = () => updateCache(c => (pulseCache = c), renderPulse, fetchPulseBars, "50-bar");

function trendRank(t) {
  if (t.continuationWarning) return 0;
  if (t.trend === "Downtrend") return 1;
  if (t.trend === "Sideways") return 2;
  return 3;
}

function renderTrendCache(cache, bodyId, stampId) {
  const body = document.getElementById(bodyId);
  const rows = Object.entries(cache)
    .filter(([, t]) => t)
    .sort((a, b) => trendRank(a[1]) - trendRank(b[1]));

  if (!rows.length) {
    body.innerHTML = `<p class="muted">Tracking — need a bit more price history to compute signals.</p>`;
    return;
  }

  body.innerHTML = rows.map(([sym, t]) => {
    const badgeClass = t.trend === "Downtrend" ? "loss" : t.trend === "Uptrend" ? "gain" : "muted";
    const macdLabel = t.macd ? (t.macd.hist < 0 ? "Bearish" : "Bullish") : "—";
    const macdClass = t.macd ? (t.macd.hist < 0 ? "loss" : "gain") : "muted";
    return `<div class="trend-item ${t.continuationWarning ? "warn" : ""}">
      <div class="trend-head">
        <span class="tk">${escapeHtml(sym)}</span>
        <span class="trend-badge ${badgeClass}">${t.trend}</span>
      </div>
      <div class="trend-meta">
        <span>RSI <strong class="mono">${t.rsi != null ? t.rsi.toFixed(0) : "—"}</strong></span>
        <span>MACD <strong class="mono ${macdClass}">${macdLabel}</strong></span>
      </div>
      <div class="trend-reasons">${t.reasons.map(r => `<span class="news-tag">${escapeHtml(r)}</span>`).join("")}</div>
      ${t.continuationWarning ? `<div class="trend-warn">&#9650; Signals suggest the downtrend may continue — a technical read, not a recommendation to sell.</div>` : ""}
    </div>`;
  }).join("");
  document.getElementById(stampId).textContent = `Updated ${new Date().toLocaleTimeString()}`;
}
const renderTrends = () => renderTrendCache(trendCache, "trends-body", "trends-stamp");
const renderPulse = () => renderTrendCache(pulseCache, "pulse-body", "pulse-stamp");

function makeThrottledUpdater(intervalMs, updateFn, label) {
  let last = 0;
  return async () => {
    if (last !== 0 && Date.now() - last < intervalMs) return;
    last = Date.now();
    try { await updateFn(); } catch (e) { console.warn(`${label} update failed:`, e); }
  };
}
const maybeUpdateTrends = makeThrottledUpdater(5 * 60000, updateTrends, "trend");
// 5-min bars only gain a new bar every 5 min, so recomputing more often
// than that just re-fetches an unchanged latest bar — matches the request
// to "track charts every 5 minutes."
const maybeUpdatePulse = makeThrottledUpdater(5 * 60000, updatePulse, "pulse");

// ============================================================================
// FOCUS TICKER — one symbol tracked at finer granularity than the watchlist.
// Quote strip refreshes on the normal 15s cycle (reuses the same /api/quotes
// call every other section already makes); bars and options are their own,
// slower-cadence fetches so this panel doesn't multiply request volume.
// ============================================================================
const FOCUS_BARS_MS = 60000;    // 1-minute bars don't change faster than this
const FOCUS_OPTIONS_MS = 150000; // 2.5 min — options chain moves slowly
const FOCUS_CHART_RANGE_1M = { timeframe: "1Min", intraday: true, singleSession: true, lookbackDays: 5, intervalLabel: "1m" };
const FOCUS_CHART_RANGE_5M = { timeframe: "5Min", intraday: true, singleSession: true, lookbackDays: 5, intervalLabel: "5m" };
const FOCUS_OPTIONS_NEAR_COUNT = 16; // nearest-to-spot contracts kept before sorting by volume

let lastQuotes = {};
let focusBars = [];
let focusChartRange = FOCUS_CHART_RANGE_1M;
let focusOptionsChain = null;
let focusChart, focusPriceSeries, focusVolumeSeries, focusVwapSeries;
let focusRefLines = [];

function computeSessionVWAP(bars, range) {
  let cumPV = 0, cumV = 0;
  return bars.map(b => {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumV += b.v;
    return { time: toChartTime(b.t, range), value: cumV ? cumPV / cumV : tp };
  });
}

function detectVolumeSurge(bars) {
  if (!bars.length) return { flagged: false, count: 0 };
  const avg = bars.reduce((s, b) => s + b.v, 0) / bars.length;
  const surges = avg > 0 ? bars.filter(b => b.v > avg * 3) : [];
  return { flagged: surges.length > 0, count: surges.length, avg };
}

// ---- Quote strip ----------------------------------------------------------
function renderFocusQuote(quotes) {
  document.getElementById("focus-ticker-label").textContent = state.focusTicker;
  const el = document.getElementById("focus-quote");
  const q = quotes[state.focusTicker];
  if (!q) { el.innerHTML = `<p class="muted">No quote yet for ${escapeHtml(state.focusTicker)}.</p>`; return; }

  const chg = q.prevClose ? q.price - q.prevClose : 0;
  const pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
  const hasQuote = !!(q.bid && q.ask);
  const spreadCents = hasQuote ? (q.ask - q.bid) * 100 : null;
  const spreadPct = hasQuote && q.price ? ((q.ask - q.bid) / q.price) * 100 : null;
  const avgVol20 = trendCache[state.focusTicker] && trendCache[state.focusTicker].avgVolume20;
  const volRatio = q.todayVolume != null && avgVol20 ? q.todayVolume / avgVol20 : null;
  const hasRange = q.dayHigh != null && q.dayLow != null && q.dayHigh > q.dayLow;
  const rangePos = hasRange ? Math.max(0, Math.min(100, ((q.price - q.dayLow) / (q.dayHigh - q.dayLow)) * 100)) : 50;

  el.innerHTML = `
    <div class="focus-price-row">
      <span class="focus-price mono ${pnlClass(chg)}">${money(q.price)}</span>
      <span class="focus-chg mono ${pnlClass(chg)}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</span>
    </div>
    <div class="focus-metrics">
      <div class="focus-metric"><span class="lbl">Bid &times; Ask</span><span class="mono">${q.bid ? money(q.bid) : "—"} &times; ${q.ask ? money(q.ask) : "—"}</span></div>
      <div class="focus-metric"><span class="lbl">Spread</span><span class="mono">${spreadCents != null ? `${spreadCents.toFixed(1)}&cent; (${spreadPct.toFixed(2)}%)` : "—"}</span></div>
      <div class="focus-metric"><span class="lbl">Volume vs 20d avg</span><span class="mono">${volRatio != null ? `${volRatio.toFixed(1)}&times; avg` : "—"}</span></div>
    </div>
    <div class="focus-range">
      <div class="focus-range-labels">
        <span class="mono">${hasRange ? money(q.dayLow) : "—"}</span>
        <span class="muted">Day range</span>
        <span class="mono">${hasRange ? money(q.dayHigh) : "—"}</span>
      </div>
      <div class="focus-range-strip"><div class="focus-range-marker" style="left:${rangePos}%"></div></div>
    </div>`;
}

// ---- Intraday chart ---------------------------------------------------
function ensureFocusChart() {
  if (focusChart || typeof LightweightCharts === "undefined") return;
  const el = document.getElementById("focus-chart-container");
  focusChart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8b96ad", fontFamily: "'JetBrains Mono', Consolas, monospace" },
    grid: {
      vertLines: { color: "rgba(37, 49, 80, 0.5)" },
      horzLines: { color: "rgba(37, 49, 80, 0.5)" },
    },
    rightPriceScale: { borderColor: "#253150" },
    timeScale: { borderColor: "#253150", timeVisible: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });
  focusPriceSeries = focusChart.addCandlestickSeries({
    upColor: "#3ecfb2", downColor: "#ff7a6e",
    borderUpColor: "#3ecfb2", borderDownColor: "#ff7a6e",
    wickUpColor: "#3ecfb2", wickDownColor: "#ff7a6e",
  });
  focusVolumeSeries = focusChart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    color: "#253150",
  });
  focusVolumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  focusVwapSeries = focusChart.addLineSeries({
    color: "#f4b860", lineWidth: 1.5,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  focusChart.subscribeCrosshairMove(param => {
    if (!focusBars.length) return;
    if (!param || !param.time) { updateFocusLegend(focusBars[focusBars.length - 1]); return; }
    const match = focusBars.find(b => toChartTime(b.t, focusChartRange) === param.time);
    updateFocusLegend(match || focusBars[focusBars.length - 1]);
  });
}

function updateFocusLegend(bar) {
  const el = document.getElementById("focus-chart-legend");
  if (!bar) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="tk">${escapeHtml(state.focusTicker)}</span>
    <span>${escapeHtml(focusChartRange.intervalLabel)}</span>
    <span>O <strong class="mono">${money(bar.o)}</strong></span>
    <span>H <strong class="mono">${money(bar.h)}</strong></span>
    <span>L <strong class="mono">${money(bar.l)}</strong></span>
    <span>C <strong class="mono ${pnlClass(bar.c - bar.o)}">${money(bar.c)}</strong></span>
    <span>Vol <strong class="mono">${Number(bar.v).toLocaleString()}</strong></span>`;
}

function drawFocusChart() {
  if (!focusChart) return;
  focusRefLines.forEach(pl => { try { focusPriceSeries.removePriceLine(pl); } catch { /* series was swapped */ } });
  focusRefLines = [];

  if (!focusBars.length) {
    focusPriceSeries.setData([]); focusVolumeSeries.setData([]); focusVwapSeries.setData([]);
    updateFocusLegend(null);
    return;
  }

  focusPriceSeries.setData(focusBars.map(b => ({ time: toChartTime(b.t, focusChartRange), open: b.o, high: b.h, low: b.l, close: b.c })));
  focusVolumeSeries.setData(focusBars.map(b => ({
    time: toChartTime(b.t, focusChartRange), value: b.v,
    color: b.c >= b.o ? "rgba(62, 207, 178, 0.5)" : "rgba(255, 122, 110, 0.5)",
  })));
  focusVwapSeries.setData(computeSessionVWAP(focusBars, focusChartRange));

  const sessionHigh = Math.max(...focusBars.map(b => b.h));
  const sessionLow = Math.min(...focusBars.map(b => b.l));
  focusRefLines.push(focusPriceSeries.createPriceLine({
    price: sessionHigh, color: "#8b96ad", lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "session high",
  }));
  focusRefLines.push(focusPriceSeries.createPriceLine({
    price: sessionLow, color: "#8b96ad", lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "session low",
  }));

  updateFocusLegend(focusBars[focusBars.length - 1]);
  focusChart.timeScale().fitContent();
}

// ---- Technicals ---------------------------------------------------------
function renderFocusTechnicals() {
  const el = document.getElementById("focus-technicals");
  if (!focusBars.length) {
    el.innerHTML = `<p class="muted">Tracking — waiting on intraday bars for ${escapeHtml(state.focusTicker)}.</p>`;
    return;
  }
  const closes = focusBars.map(b => b.c);
  const rsiFast = latestRSI(closes, 14);
  const rsi5m = pulseCache[state.focusTicker] ? pulseCache[state.focusTicker].rsi : null;
  const vwapSeries = computeSessionVWAP(focusBars, focusChartRange);
  const vwap = vwapSeries.length ? vwapSeries[vwapSeries.length - 1].value : null;
  const price = closes[closes.length - 1];
  const vwapDist = vwap ? ((price - vwap) / vwap) * 100 : null;
  const surge = detectVolumeSurge(focusBars);
  const fastLabel = focusChartRange.intervalLabel;

  el.innerHTML = `<div class="trend-item ${surge.flagged ? "warn" : ""}">
    <div class="trend-head">
      <span class="tk">${escapeHtml(state.focusTicker)} &middot; intraday</span>
      <span class="trend-badge ${surge.flagged ? "loss" : "muted"}">${surge.flagged ? "Volume surge" : "Normal volume"}</span>
    </div>
    <div class="trend-meta">
      <span>RSI ${fastLabel} <strong class="mono">${rsiFast != null ? rsiFast.toFixed(0) : "—"}</strong></span>
      <span>RSI 5m <strong class="mono">${rsi5m != null ? rsi5m.toFixed(0) : "—"}</strong></span>
      <span>VWAP dist <strong class="mono ${vwapDist != null ? pnlClass(vwapDist) : ""}">${vwapDist != null ? `${vwapDist >= 0 ? "+" : ""}${vwapDist.toFixed(2)}%` : "—"}</strong></span>
    </div>
    ${surge.flagged ? `<div class="trend-warn">&#9650; ${surge.count} one-minute bar${surge.count > 1 ? "s" : ""} exceeded 3&times; the session's average 1-min volume — describes momentum, not a prediction.</div>` : ""}
  </div>`;
}

// ---- Options activity snapshot ------------------------------------------
function nextFridayExpiry(weeksAhead = 0) {
  const d = new Date();
  const diff = (5 - d.getDay() + 7) % 7; // days until (or including) this week's Friday
  d.setDate(d.getDate() + diff + weeksAhead * 7);
  return d.toISOString().slice(0, 10);
}

async function fetchOptionContracts(ticker, expiry) {
  const res = await fetch(`${WORKER_URL}/api/option-contracts?symbol=${encodeURIComponent(ticker)}&expiration=${expiry}`);
  if (!res.ok) throw new Error(`option contracts fetch failed: ${res.status}`);
  const data = await res.json();
  return data.option_contracts || [];
}

// Tries the next few Fridays until one actually has listed contracts (not
// every ticker has weeklies every week) — merges Trading-API contract
// reference data (open interest) with the Data-API snapshot (volume), then
// keeps only the strikes nearest the current spot before sorting by volume.
async function fetchFocusOptionsChain(ticker, spot) {
  for (let weeksAhead = 0; weeksAhead < 3; weeksAhead++) {
    const expiry = nextFridayExpiry(weeksAhead);
    try {
      const contracts = await fetchOptionContracts(ticker, expiry);
      if (!contracts.length) continue;
      const snaps = await fetchOptionSnapshot(ticker, expiry);
      const rows = contracts
        .map(c => ({
          symbol: c.symbol,
          strike: parseFloat(c.strike_price),
          type: c.type,
          oi: parseInt(c.open_interest || "0", 10),
        }))
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
        .slice(0, FOCUS_OPTIONS_NEAR_COUNT)
        .map(c => {
          const snap = snaps[c.symbol];
          const volume = snap && snap.dailyBar && snap.dailyBar.v != null ? snap.dailyBar.v : 0;
          return { ...c, volume };
        })
        .sort((a, b) => b.volume - a.volume);
      return { expiry, rows };
    } catch (e) {
      console.warn(`options chain fetch failed for ${ticker} @ ${expiry}:`, e);
    }
  }
  return null;
}

function renderFocusOptions(chain) {
  const stamp = document.getElementById("focus-options-stamp");
  const body = document.getElementById("focus-options-body");
  if (!chain || !chain.rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No near-the-money options data available.</td></tr>`;
    stamp.textContent = "";
    return;
  }
  stamp.textContent = `Expiry ${chain.expiry} · Updated ${new Date().toLocaleTimeString()}`;
  body.innerHTML = chain.rows.map(r => `
    <tr>
      <td class="mono">${money(r.strike)}</td>
      <td>${r.type === "call" ? "Call" : "Put"}</td>
      <td class="num mono">${r.volume.toLocaleString()}</td>
      <td class="num mono">${r.oi.toLocaleString()}</td>
      <td>${r.volume > r.oi ? `<span class="news-tag warn-tag">vol &gt; OI</span>` : ""}</td>
    </tr>`).join("");
}

// ---- Update cycles (own cadence, independent of the 15s quote refresh) ---
async function updateFocusBars() {
  const symbol = state.focusTicker;
  let bars = [], range = FOCUS_CHART_RANGE_1M;
  try {
    bars = await fetchBars(symbol, FOCUS_CHART_RANGE_1M);
  } catch (e) {
    console.warn(`1m bars failed for ${symbol}, falling back to 5m:`, e);
    try {
      bars = await fetchBars(symbol, FOCUS_CHART_RANGE_5M);
      range = FOCUS_CHART_RANGE_5M;
    } catch (e2) {
      console.warn(`5m bars fallback failed for ${symbol}:`, e2);
    }
  }
  if (symbol !== state.focusTicker) return; // user switched tickers mid-fetch
  focusBars = bars;
  focusChartRange = range;
  ensureFocusChart();
  drawFocusChart();
  renderFocusTechnicals();
}

async function updateFocusOptions() {
  const symbol = state.focusTicker;
  const spot = lastQuotes[symbol] ? lastQuotes[symbol].price : null;
  if (!spot) return;
  const chain = await fetchFocusOptionsChain(symbol, spot);
  if (symbol !== state.focusTicker) return;
  focusOptionsChain = chain;
  renderFocusOptions(chain);
}

const maybeUpdateFocusBars = makeThrottledUpdater(FOCUS_BARS_MS, updateFocusBars, "focus bars");
const maybeUpdateFocusOptions = makeThrottledUpdater(FOCUS_OPTIONS_MS, updateFocusOptions, "focus options");

function selectFocusTicker(sym) {
  state.focusTicker = sym.trim().toUpperCase();
  if (!state.focusTicker) return;
  persist();
  focusBars = [];
  focusOptionsChain = null;
  drawFocusChart();
  renderFocusTechnicals();
  renderFocusOptions(null);
  updateFocusBars();
  updateFocusOptions();
  refresh();
}

document.getElementById("focus-ticker-form").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("focus-ticker-input");
  const sym = input.value.trim();
  if (!sym) return;
  input.value = "";
  selectFocusTicker(sym);
};

// ============================================================================
// NEWS
// ============================================================================
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function timeAgo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

async function fetchNews() {
  const symbols = allKnownTickers();
  const qs = symbols.length ? `&symbols=${encodeURIComponent(symbols.join(","))}` : "";
  const res = await fetch(`${WORKER_URL}/api/news?limit=25${qs}`);
  if (!res.ok) throw new Error(`news fetch failed: ${res.status}`);
  const data = await res.json();
  return data.news || [];
}

function renderNews(items) {
  const body = document.getElementById("news-body");
  if (!items.length) { body.innerHTML = `<p class="muted">No recent news.</p>`; return; }
  body.innerHTML = items.map(n => {
    const img = (n.images || []).find(i => i.size === "thumb") || (n.images || [])[0];
    const tags = (n.symbols || []).slice(0, 4).map(s => `<span class="news-tag">${escapeHtml(s)}</span>`).join("");
    const safeUrl = /^https?:\/\//.test(n.url || "") ? escapeHtml(n.url) : "#";
    return `<div class="news-item">
      <a class="news-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
        <div class="news-thumb ${img ? "" : "empty"}"${img ? ` style="background-image:url('${escapeHtml(img.url)}')"` : ""}></div>
        <div class="news-body">
          <div class="news-headline">${escapeHtml(n.headline)}</div>
          <div class="news-meta">
            <span class="news-source">${escapeHtml(n.source)}</span>
            <span>·</span>
            <span>${timeAgo(n.created_at)}</span>
            ${tags}
          </div>
        </div>
      </a>
    </div>`;
  }).join("");
  document.getElementById("news-stamp").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

let lastNewsFetch = 0;
async function maybeLoadNews() {
  if (lastNewsFetch !== 0 && Date.now() - lastNewsFetch < 60000) return; // refresh at most once/min
  lastNewsFetch = Date.now();
  try {
    renderNews(await fetchNews());
  } catch (e) {
    console.warn("news fetch failed:", e);
  }
}

// ============================================================================
// MAIN REFRESH LOOP
// ============================================================================
async function refresh() {
  try {
    const alertTickers = state.alerts.filter(a => a.ticker).map(a => a.ticker);
    const allTickers = [...new Set([
      state.focusTicker,
      ...state.watchlist,
      ...state.stocks.map(s => s.ticker),
      ...state.options.map(o => o.ticker),
      ...alertTickers,
    ])];
    const quotes = await fetchQuotes(allTickers);
    lastQuotes = quotes;

    // Option marks + IV: fetch each unique (ticker, expiry) chain once, then
    // pull each contract's mark/IV out of that shared snapshot.
    const optionMarks = [];
    const optionIVs = {};
    const chainCache = {};
    for (const o of state.options) {
      const key = `${o.ticker}|${o.expiry}`;
      if (!chainCache[key]) {
        try { chainCache[key] = await fetchOptionSnapshot(o.ticker, o.expiry); }
        catch (e) { console.warn(e); chainCache[key] = {}; }
      }
      const sym = occSymbol(o.ticker, o.expiry, o.strike, o.type);
      const snap = chainCache[key][sym];
      optionMarks.push(markFromSnapshot(snap));
      optionIVs[optionKeyFor(o)] = ivFromSnapshot(snap);
    }

    renderFocusQuote(quotes);
    renderWatchlist(quotes);
    renderTickerTape(quotes);
    const stockPnl = renderStocks(quotes);
    const optionPnl = renderOptions(quotes, optionMarks);
    renderAlerts(quotes, optionIVs);
    bindRemoveButtons();
    renderChartSymbolPicker();
    renderRangeSelector();
    renderTypeSelector();
    renderMaToggles();
    if (chartSymbol) loadChart();
    maybeLoadNews();
    maybeUpdateTrends();
    maybeUpdatePulse();
    maybeUpdateFocusBars();
    maybeUpdateFocusOptions();

    const total = stockPnl + optionPnl;
    const totalEl = document.getElementById("total-pnl");
    totalEl.textContent = money(total);
    totalEl.className = `mono ${pnlClass(total)}`;

    document.getElementById("stamp").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    document.getElementById("stamp").textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

// ============================================================================
// MODALS (add stock / option / alert / edit watchlist)
// ============================================================================
function openModal(html, onSubmit, onRender) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector(".cancel").onclick = () => (root.innerHTML = "");
  if (onRender) onRender(root);
  root.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    onSubmit(new FormData(e.target));
    root.innerHTML = "";
    persist();
    refresh();
  };
}

document.getElementById("add-stock").onclick = () => openModal(`
  <h3>Add stock position</h3>
  <form>
    <label>Ticker</label><input name="ticker" required style="text-transform:uppercase">
    <label>Shares</label><input name="shares" type="number" step="any" required>
    <label>Cost basis (per share)</label><input name="costBasis" type="number" step="any" required>
    <div class="actions"><button type="button" class="cancel">Cancel</button>
    <button type="submit" class="primary">Add</button></div>
  </form>`,
  (fd) => state.stocks.push({
    ticker: fd.get("ticker").toUpperCase(),
    shares: parseFloat(fd.get("shares")),
    costBasis: parseFloat(fd.get("costBasis")),
  }));

document.getElementById("add-option").onclick = () => openModal(`
  <h3>Add option position</h3>
  <form>
    <label>Ticker</label><input name="ticker" required style="text-transform:uppercase">
    <label>Expiration</label><input name="expiry" type="date" required>
    <label>Strike</label><input name="strike" type="number" step="any" required>
    <label>Type</label>
    <select name="type"><option value="call">Call</option><option value="put">Put</option></select>
    <label>Contracts</label><input name="contracts" type="number" value="1" required>
    <label>Premium paid (per share)</label><input name="premium" type="number" step="any" required>
    <div class="actions"><button type="button" class="cancel">Cancel</button>
    <button type="submit" class="primary">Add</button></div>
  </form>`,
  (fd) => state.options.push({
    ticker: fd.get("ticker").toUpperCase(),
    expiry: fd.get("expiry"),
    strike: parseFloat(fd.get("strike")),
    type: fd.get("type"),
    contracts: parseInt(fd.get("contracts"), 10),
    premium: parseFloat(fd.get("premium")),
  }));

document.getElementById("add-alert").onclick = () => {
  const optionOptions = state.options.length
    ? state.options.map(o => `<option value="${optionKeyFor(o)}">${optionLabelFor(o)}</option>`).join("")
    : `<option value="" disabled selected>Add an option position first</option>`;

  openModal(`
    <h3>Add alert</h3>
    <form>
      <label>Alert type</label>
      <select name="type" id="alert-type-select">
        <option value="price">Price</option>
        <option value="volume">Volume spike</option>
        <option value="iv">Option IV change</option>
        <option value="dte">Option days-to-expiration</option>
      </select>

      <div class="alert-fieldset" data-for="price">
        <label>Ticker</label><input name="ticker" data-required style="text-transform:uppercase">
        <label>Condition</label>
        <select name="direction"><option value="above">Price above</option><option value="below">Price below</option></select>
        <label>Level</label><input name="level" type="number" step="any" data-required>
      </div>

      <div class="alert-fieldset" data-for="volume" hidden>
        <label>Ticker</label><input name="volTicker" data-required style="text-transform:uppercase">
        <label>Surge multiple (current volume &ge; N &times; 20-day average)</label>
        <input name="multiple" type="number" step="any" value="2" min="1" data-required>
      </div>

      <div class="alert-fieldset" data-for="iv" hidden>
        <label>Option position</label>
        <select name="optionKeyIv" data-required>${optionOptions}</select>
        <label>Alert when IV moves more than this many points (e.g. 5 = 5%)</label>
        <input name="ivThreshold" type="number" step="any" value="5" min="0" data-required>
      </div>

      <div class="alert-fieldset" data-for="dte" hidden>
        <label>Option position</label>
        <select name="optionKeyDte" data-required>${optionOptions}</select>
        <label>Warn me at N days to expiration</label>
        <input name="dteThreshold" type="number" step="1" value="7" min="0" data-required>
      </div>

      <div class="actions"><button type="button" class="cancel">Cancel</button>
      <button type="submit" class="primary">Add</button></div>
    </form>`,
    (fd) => {
      const type = fd.get("type");
      if (type === "volume") {
        const ticker = (fd.get("volTicker") || "").trim().toUpperCase();
        const multiple = parseFloat(fd.get("multiple"));
        if (!ticker || !Number.isFinite(multiple) || multiple <= 0) return;
        state.alerts.push({ type: "volume", ticker, multiple });
      } else if (type === "iv") {
        const optionKey = fd.get("optionKeyIv");
        const thresholdPts = parseFloat(fd.get("ivThreshold"));
        const opt = state.options.find(o => optionKeyFor(o) === optionKey);
        if (!opt || !Number.isFinite(thresholdPts)) return;
        state.alerts.push({ type: "iv", optionKey, label: optionLabelFor(opt), thresholdPts, ivBaseline: null });
      } else if (type === "dte") {
        const optionKey = fd.get("optionKeyDte");
        const thresholdDays = parseInt(fd.get("dteThreshold"), 10);
        const opt = state.options.find(o => optionKeyFor(o) === optionKey);
        if (!opt || !Number.isFinite(thresholdDays)) return;
        state.alerts.push({ type: "dte", optionKey, label: optionLabelFor(opt), thresholdDays });
      } else {
        const ticker = (fd.get("ticker") || "").trim().toUpperCase();
        const level = parseFloat(fd.get("level"));
        if (!ticker || !Number.isFinite(level)) return;
        state.alerts.push({ type: "price", ticker, direction: fd.get("direction"), level });
      }
    },
    (root) => {
      const select = root.querySelector("#alert-type-select");
      const groups = root.querySelectorAll(".alert-fieldset");
      // `hidden` alone doesn't exempt a field from constraint validation —
      // a required-but-hidden field from an inactive type would silently
      // block submission — so toggle `.required` itself with visibility.
      const sync = () => groups.forEach(g => {
        const active = g.dataset.for === select.value;
        g.hidden = !active;
        g.querySelectorAll("[data-required]").forEach(el => { el.required = active; });
      });
      select.onchange = sync;
      sync();
    }
  );
};

document.getElementById("edit-watchlist").onclick = () => openModal(`
  <h3>Edit watchlist</h3>
  <form>
    <label>Tickers (comma-separated)</label>
    <input name="tickers" value="${state.watchlist.join(", ")}" required>
    <div class="actions"><button type="button" class="cancel">Cancel</button>
    <button type="submit" class="primary">Save</button></div>
  </form>`,
  (fd) => { state.watchlist = fd.get("tickers").split(",").map(t => t.trim().toUpperCase()).filter(Boolean); });

// ============================================================================
// BOOT
// ============================================================================
if (WORKER_URL.includes("YOUR-SUBDOMAIN")) {
  document.getElementById("stamp").textContent = "⚠ Set WORKER_URL in app.js first — see README";
} else {
  refresh();
  setInterval(refresh, REFRESH_MS);
}
