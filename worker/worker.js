/**
 * Market Dashboard Data Proxy — Cloudflare Worker
 * ===================================================
 *
 * Purpose: keep your Alpaca API key/secret OUT of the public GitHub Pages
 * site. This Worker holds the credentials as encrypted secrets and proxies
 * two read-only endpoints to your dashboard's frontend:
 *
 *   GET /api/quotes?symbols=AAPL,NVDA,SPY
 *     -> latest real-time (IEX feed) stock snapshots: bid/ask + previous close
 *
 *   GET /api/options?symbol=AAPL&expiration=2026-09-18
 *     -> near-the-money option chain snapshot for that expiry
 *        (free tier = "indicative" feed, not true real-time OPRA —
 *        see README for what that means)
 *
 *   GET /api/bars?symbol=AAPL&timeframe=1Day&limit=180
 *     -> historical OHLCV bars for the candlestick chart
 *
 *   GET /api/news?symbols=AAPL,NVDA&limit=25
 *     -> latest market news (Benzinga, via Alpaca), optionally filtered to symbols
 *
 * SECURITY NOTES:
 *   - Set ALPACA_KEY_ID / ALPACA_SECRET_KEY as Worker secrets
 *     (`wrangler secret put ...`), never as plaintext in this file.
 *   - ALLOWED_ORIGIN restricts which site can call this Worker. Set it to
 *     your exact GitHub Pages URL (e.g. https://yourname.github.io) once
 *     you know it — an open "*" origin lets ANY website use your Worker
 *     (and burn your Alpaca rate limit), so lock this down.
 *   - This Worker is read-only. It never places orders and has no path to
 *     do so, even if the underlying Alpaca keys have trading permission —
 *     use a keys pair scoped to data access only if Alpaca offers that
 *     option when you generate them.
 */

const ALPACA_BASE = "https://data.alpaca.markets";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function alpacaFetch(env, path) {
  const resp = await fetch(`${ALPACA_BASE}${path}`, {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
      "accept": "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`Alpaca ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function handleQuotes(url, env) {
  const symbols = url.searchParams.get("symbols");
  if (!symbols) {
    return new Response(JSON.stringify({ error: "missing symbols param" }), { status: 400 });
  }
  // Snapshots give bid/ask AND previous close in one call (quotes/latest gives only bid/ask).
  const data = await alpacaFetch(env, `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleBars(url, env) {
  const symbol = url.searchParams.get("symbol");
  const timeframe = url.searchParams.get("timeframe") || "1Day";
  const limit = parseInt(url.searchParams.get("limit") || "180", 10);
  if (!symbol) {
    return new Response(JSON.stringify({ error: "missing symbol param" }), { status: 400 });
  }
  // Alpaca defaults `start` to "now" when omitted, which starves a daily-bar
  // request down to ~1 result — honor an explicit start from the caller
  // (it knows the intended range), else fall back to a limit-based heuristic.
  let start = url.searchParams.get("start");
  if (!start) {
    const lookbackDays = Math.ceil(limit * 1.6) + 5; // pad for weekends/holidays
    start = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  }
  const path = `/v2/stocks/${encodeURIComponent(symbol)}/bars`
    + `?timeframe=${encodeURIComponent(timeframe)}&limit=${limit}&start=${start}`
    + `&feed=iex&adjustment=raw&sort=asc`;
  const data = await alpacaFetch(env, path);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleNews(url, env) {
  const symbols = url.searchParams.get("symbols");
  const limit = url.searchParams.get("limit") || "25";
  let path = `/v1beta1/news?limit=${encodeURIComponent(limit)}&sort=desc&exclude_contentless=true`;
  if (symbols) path += `&symbols=${encodeURIComponent(symbols)}`;
  const data = await alpacaFetch(env, path);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleOptions(url, env) {
  const symbol = url.searchParams.get("symbol");
  const expiration = url.searchParams.get("expiration");
  if (!symbol || !expiration) {
    return new Response(JSON.stringify({ error: "missing symbol or expiration param" }), { status: 400 });
  }
  const path = `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`
    + `?feed=indicative&expiration_date_gte=${expiration}&expiration_date_lte=${expiration}&limit=200`;
  const data = await alpacaFetch(env, path);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      let response;
      if (url.pathname === "/api/quotes") {
        response = await handleQuotes(url, env);
      } else if (url.pathname === "/api/options") {
        response = await handleOptions(url, env);
      } else if (url.pathname === "/api/bars") {
        response = await handleBars(url, env);
      } else if (url.pathname === "/api/news") {
        response = await handleNews(url, env);
      } else {
        response = new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      // Merge CORS headers onto whatever the handler returned
      const merged = new Response(response.body, response);
      Object.entries(headers).forEach(([k, v]) => merged.headers.set(k, v));
      return merged;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
