# Market & Options Dashboard — GitHub Pages + Cloudflare Worker

A live-updating stock and options tracker: static site on GitHub Pages,
real-time-ish data via a small Cloudflare Worker that keeps your API keys
private. Refreshes every 15 seconds. Read-only — it cannot place trades on
any account.

## Architecture, in one sentence

Your browser polls a tiny **Cloudflare Worker** every 15s, which holds your
**Alpaca** API keys as encrypted secrets and forwards quote/options requests
to Alpaca — your keys never touch the public GitHub repo or the page's
JavaScript source.

## What "real-time" means here — read this first

- **Stocks**: genuinely live quotes from the **IEX** exchange (one venue,
  not the full consolidated tape — good enough for personal tracking, not
  identical to what a professional terminal shows).
- **Options**: Alpaca's free tier gives an **"indicative"** feed — an
  approximation, not true real-time OPRA quotes. True real-time options data
  requires Alpaca's paid market data plan. This dashboard is built to make
  that upgrade a one-line change later if you want it (swap `feed=indicative`
  for `feed=opra` in `worker/worker.js`), but starts on the free tier.
- Nothing here is financial advice. This is a read-only monitoring tool —
  you still make every trade decision and every trade yourself, in your
  broker's app.

## Setup

### 1. Create a free Alpaca account (no funding required)

Sign up at alpaca.markets. A **paper trading** account is enough — market
data access doesn't require a funded live account. Generate an API key
pair from the dashboard; you'll get a Key ID and a Secret Key. **Save the
secret immediately** — Alpaca only shows it once.

### 2. Deploy the Cloudflare Worker (holds your keys securely)

```
cd worker
npm install -g wrangler        # Cloudflare's CLI, one-time
wrangler login                 # opens a browser to authorize (free account is fine)
wrangler deploy
```

This prints your Worker's URL, something like:
`https://market-dashboard-proxy.yoursubdomain.workers.dev`

Now set your Alpaca credentials as encrypted secrets (never written to any
file):

```
wrangler secret put ALPACA_KEY_ID
wrangler secret put ALPACA_SECRET_KEY
```

Paste each value when prompted.

### 3. Push this repo to GitHub

```
cd ..
git init
git add .
git commit -m "Initial dashboard"
gh repo create market-dashboard --public --source=. --push
```

(If you're using Claude Code, this whole step — repo creation, commit,
push, enabling Pages — is exactly the kind of thing to hand it directly.)

### 4. Point the site at your Worker

Open `app.js` and change the first line:

```js
const WORKER_URL = "https://market-dashboard-proxy.yoursubdomain.workers.dev";
```

Commit and push that change.

### 5. Lock the Worker down to your GitHub Pages origin

Once GitHub Pages is live (next step) you'll have a URL like
`https://yourusername.github.io`. Open `worker/wrangler.toml`, set:

```
ALLOWED_ORIGIN = "https://yourusername.github.io"
```

and run `wrangler deploy` again from the `worker/` folder. Leaving this as
`"*"` means *any* website could call your Worker and burn through your
Alpaca rate limit — worth tightening once you know your real Pages URL.

### 6. Enable GitHub Pages

In your repo on GitHub: **Settings → Pages → Source: Deploy from a branch
→ Branch: main / (root)**. Save. Your dashboard will be live at
`https://yourusername.github.io/market-dashboard/` within a minute or two.

### 7. Add your positions

Open the live site. Use the **+ Add** buttons to enter your stock and
option positions and any price alerts. Everything is saved to your
browser's local storage — it persists across visits on that device, is
never committed to the repo, and is never visible to anyone else viewing
the public page.

## Ongoing use

- Every time you open or close a position in Robinhood, come to the
  dashboard and add/remove it with the buttons — the one bit of manual
  upkeep, and the price of keeping this fully disconnected from your
  brokerage login.
- The watchlist, positions, and alerts live in *your browser's* storage
  only. Opening the site on a different device/browser starts fresh —
  this is a deliberate privacy tradeoff, not a bug. If you want your data
  to follow you across devices, that requires a real backend with
  authentication, which is a meaningfully bigger project than this one.

## Costs

Everything here is free at the scale of one person's dashboard: Alpaca's
free data tier, Cloudflare Workers' free tier (100,000 requests/day — this
setup uses a few thousand at most), and GitHub Pages. If this ever needs
true real-time OPRA options data, that's the one piece that costs money.
