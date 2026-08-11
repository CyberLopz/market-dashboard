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
  watchlist: store.get("md_watchlist", ["AAPL", "NVDA", "SPY", "TSLA", "AMD"]),
  stocks: store.get("md_stocks", []),       // {ticker, shares, costBasis}
  options: store.get("md_options", []),     // {ticker, expiry, strike, type, contracts, premium}
  alerts: store.get("md_alerts", []),       // {ticker, direction, level}
};

function persist() {
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
    out[sym] = { price, bid, ask, prevClose };
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
  return [...new Set([...state.watchlist, ...state.stocks.map(s => s.ticker)])];
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

function renderAlerts(quotes) {
  const body = document.getElementById("alerts-body");
  const fired = [];
  body.innerHTML = state.alerts.map((a, i) => {
    const q = quotes[a.ticker];
    const isFired = q && ((a.direction === "above" && q.price >= a.level) ||
                           (a.direction === "below" && q.price <= a.level));
    if (isFired) fired.push(`${a.ticker} is ${a.direction} ${money(a.level)} — now ${money(q.price)}`);
    return `<tr>
      <td class="tk">${a.ticker}</td>
      <td class="${isFired ? "warn" : ""}">${a.direction} ${money(a.level)}</td>
      <td><button class="btn-remove" data-remove-alert="${i}">&times;</button></td>
    </tr>`;
  }).join("");
  document.getElementById("alerts-section").innerHTML = fired.length
    ? fired.map(f => `<div class="alert-item">&#9650; ${f}</div>`).join("")
    : "";
}

function bindRemoveButtons() {
  document.querySelectorAll("[data-remove-stock]").forEach(btn =>
    btn.onclick = () => { state.stocks.splice(+btn.dataset.removeStock, 1); persist(); refresh(); });
  document.querySelectorAll("[data-remove-option]").forEach(btn =>
    btn.onclick = () => { state.options.splice(+btn.dataset.removeOption, 1); persist(); refresh(); });
  document.querySelectorAll("[data-remove-alert]").forEach(btn =>
    btn.onclick = () => { state.alerts.splice(+btn.dataset.removeAlert, 1); persist(); refresh(); });
}

// ============================================================================
// CANDLESTICK CHART
// ============================================================================
const CHART_RANGES = [
  { id: "1D", label: "1D", timeframe: "5Min", lookbackDays: 6, intraday: true, singleSession: true },
  { id: "1W", label: "1W", timeframe: "15Min", lookbackDays: 9, intraday: true },
  { id: "1M", label: "1M", timeframe: "1Day", lookbackDays: 35 },
  { id: "3M", label: "3M", timeframe: "1Day", lookbackDays: 100 },
  { id: "6M", label: "6M", timeframe: "1Day", lookbackDays: 200 },
  { id: "YTD", label: "YTD", timeframe: "1Day", ytd: true },
  { id: "1Y", label: "1Y", timeframe: "1Day", lookbackDays: 370 },
  { id: "5Y", label: "5Y", timeframe: "1Week", lookbackDays: 1830 },
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

async function loadChart() {
  ensureChart();
  if (!chart || !chartSymbol) return;
  currentRange = CHART_RANGES.find(r => r.id === chartRangeId) || CHART_RANGES[4];
  try {
    currentBars = await fetchBars(chartSymbol, currentRange);
  } catch (e) {
    console.warn(`chart data failed for ${chartSymbol}:`, e);
    currentBars = [];
  }
  drawChart();
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
    `<button data-range="${r.id}" class="${r.id === chartRangeId ? "active" : ""}">${r.label}</button>`
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

// Combines trend (price vs. 50-day average + its slope), momentum (RSI),
// and MACD into a single read. `continuationWarning` fires only when
// several bearish signals line up AND RSI isn't already deeply oversold
// (extreme oversold often precedes a bounce, not more downside).
function analyzeTrend(bars) {
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
    if (price < sma50) { bearish++; reasons.push("Below 50-day average"); }
    else { bullish++; reasons.push("Above 50-day average"); }
  }
  if (sma50Prev != null && sma50 != null) {
    if (sma50 < sma50Prev) { bearish++; reasons.push("50-day average declining"); }
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

  return { trend, bearish, bullish, reasons, rsi, macd, continuationWarning };
}

async function fetchDailyBars(symbol, lookbackDays = 220) {
  const start = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${WORKER_URL}/api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=1Day&limit=250&start=${start}`);
  if (!res.ok) throw new Error(`bars fetch failed: ${res.status}`);
  const data = await res.json();
  return data.bars || [];
}

let trendCache = {};

async function updateTrends() {
  const symbols = allKnownTickers();
  const entries = await Promise.all(symbols.map(async sym => {
    try { return [sym, analyzeTrend(await fetchDailyBars(sym))]; }
    catch (e) { console.warn(`trend fetch failed for ${sym}:`, e); return [sym, null]; }
  }));
  trendCache = Object.fromEntries(entries);
  renderTrends();
}

function trendRank(t) {
  if (t.continuationWarning) return 0;
  if (t.trend === "Downtrend") return 1;
  if (t.trend === "Sideways") return 2;
  return 3;
}

function renderTrends() {
  const body = document.getElementById("trends-body");
  const rows = Object.entries(trendCache)
    .filter(([, t]) => t)
    .sort((a, b) => trendRank(a[1]) - trendRank(b[1]));

  if (!rows.length) {
    body.innerHTML = `<p class="muted">Tracking trends — need a bit more price history to compute signals.</p>`;
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
  document.getElementById("trends-stamp").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

let lastTrendFetch = 0;
async function maybeUpdateTrends() {
  if (lastTrendFetch !== 0 && Date.now() - lastTrendFetch < 5 * 60000) return; // recompute at most every 5 min
  lastTrendFetch = Date.now();
  try { await updateTrends(); } catch (e) { console.warn("trend update failed:", e); }
}

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
    const allTickers = [...new Set([
      ...state.watchlist,
      ...state.stocks.map(s => s.ticker),
      ...state.options.map(o => o.ticker),
    ])];
    const quotes = await fetchQuotes(allTickers);

    // Option marks: fetch each unique (ticker, expiry) chain once, then pull each contract's mark
    const optionMarks = [];
    const chainCache = {};
    for (const o of state.options) {
      const key = `${o.ticker}|${o.expiry}`;
      if (!chainCache[key]) {
        try { chainCache[key] = await fetchOptionSnapshot(o.ticker, o.expiry); }
        catch (e) { console.warn(e); chainCache[key] = {}; }
      }
      const sym = occSymbol(o.ticker, o.expiry, o.strike, o.type);
      optionMarks.push(markFromSnapshot(chainCache[key][sym]));
    }

    renderWatchlist(quotes);
    renderTickerTape(quotes);
    const stockPnl = renderStocks(quotes);
    const optionPnl = renderOptions(quotes, optionMarks);
    renderAlerts(quotes);
    bindRemoveButtons();
    renderChartSymbolPicker();
    renderRangeSelector();
    renderTypeSelector();
    renderMaToggles();
    if (chartSymbol) loadChart();
    maybeLoadNews();
    maybeUpdateTrends();

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
function openModal(html, onSubmit) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector(".cancel").onclick = () => (root.innerHTML = "");
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

document.getElementById("add-alert").onclick = () => openModal(`
  <h3>Add alert</h3>
  <form>
    <label>Ticker</label><input name="ticker" required style="text-transform:uppercase">
    <label>Condition</label>
    <select name="direction"><option value="above">Price above</option><option value="below">Price below</option></select>
    <label>Level</label><input name="level" type="number" step="any" required>
    <div class="actions"><button type="button" class="cancel">Cancel</button>
    <button type="submit" class="primary">Add</button></div>
  </form>`,
  (fd) => state.alerts.push({
    ticker: fd.get("ticker").toUpperCase(),
    direction: fd.get("direction"),
    level: parseFloat(fd.get("level")),
  }));

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
