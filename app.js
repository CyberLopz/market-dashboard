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

async function fetchBars(symbol, timeframe = "1Day", limit = 180) {
  const res = await fetch(`${WORKER_URL}/api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`);
  if (!res.ok) throw new Error(`bars fetch failed: ${res.status}`);
  const data = await res.json();
  return data.bars || [];
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
let chart, candleSeries, volumeSeries, chartSymbol = null;

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
  candleSeries = chart.addCandlestickSeries({
    upColor: "#3ecfb2", downColor: "#ff7a6e",
    borderUpColor: "#3ecfb2", borderDownColor: "#ff7a6e",
    wickUpColor: "#3ecfb2", wickDownColor: "#ff7a6e",
  });
  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    color: "#253150",
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
}

async function renderChart(symbol) {
  ensureChart();
  if (!chart) return; // Lightweight Charts failed to load (e.g. offline)
  try {
    const bars = await fetchBars(symbol);
    const candles = bars.map(b => ({ time: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volumes = bars.map(b => ({
      time: b.t.slice(0, 10), value: b.v,
      color: b.c >= b.o ? "rgba(62, 207, 178, 0.5)" : "rgba(255, 122, 110, 0.5)",
    }));
    candleSeries.setData(candles);
    volumeSeries.setData(volumes);
    chart.timeScale().fitContent();
  } catch (e) {
    console.warn(`chart data failed for ${symbol}:`, e);
  }
}

function renderChartSymbolPicker() {
  const wrap = document.getElementById("chart-symbols");
  const symbols = allKnownTickers();
  if (!symbols.length) { wrap.innerHTML = ""; return; }
  if (!chartSymbol || !symbols.includes(chartSymbol)) chartSymbol = symbols[0];
  wrap.innerHTML = symbols.map(s =>
    `<button class="chip ${s === chartSymbol ? "active" : ""}" data-sym="${s}">${s}</button>`
  ).join("");
  wrap.querySelectorAll("[data-sym]").forEach(btn => btn.onclick = () => {
    chartSymbol = btn.dataset.sym;
    renderChartSymbolPicker();
    renderChart(chartSymbol);
  });
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
    if (chartSymbol) renderChart(chartSymbol);

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
