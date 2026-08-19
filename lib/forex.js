// Forex data layer for the Railway server (server.js). Any API keys live only
// on Railway — Vercel forwards /api/* here (see the rewrite in vercel.json) and
// never sees them.
//
// Providers are tried in order until one answers. Yahoo comes first because it
// needs no key and has no daily credit cap, which is what keeps the terminal
// alive all day; the keyed providers below it are there for when there is a
// paid plan to fall back on.
//
//   yahoo       — no key. Quotes and candles. Unofficial endpoint: no SLA, and
//                 Yahoo's terms don't cover commercial redistribution.
//   twelvedata  — FOREX_API_KEY / TWELVEDATA_API_KEY. Free plan is 800 credits
//                 a day and 1 credit per symbol per refresh, so a 7-symbol
//                 watchlist exhausts it in well under an hour.
//   finnhub     — FINNHUB_API_KEY. Forex is a paid endpoint; on the free plan
//                 it answers "You don't have access to this resource."
//
// Override the order with FOREX_PROVIDER_ORDER, e.g. "twelvedata,yahoo".

const TWELVE_BASE = 'https://api.twelvedata.com';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const PROVIDER_ORDER = (process.env.FOREX_PROVIDER_ORDER || 'yahoo,twelvedata,finnhub')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Upstream responses are cached in module scope so that N browsers hitting the
// site cost one upstream call, not N. Free forex plans have small quotas and
// without this a handful of users exhausts the day's credits in minutes.
const QUOTE_TTL_MS = Number(process.env.QUOTE_CACHE_MS || 15000);
const CANDLE_TTL_MS = Number(process.env.CANDLE_CACHE_MS || 300000);

const cache = new Map();

function cached(key, ttl, produce) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.value;
  const value = produce().catch(err => {
    // Don't let a rejected promise be cached and replayed forever.
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: now, value });
  return value;
}

// Yahoo names pairs without the slash and with an =X suffix: EUR/USD -> EURUSD=X.
// Gold is XAUUSD=X, matching the app's XAU/USD.
function yahooSymbol(pair) {
  return pair.replace('/', '') + '=X';
}

async function yahooChart(pair, { interval, range }) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooSymbol(pair))}` +
    `?interval=${interval}&range=${range}`;
  // Yahoo rejects requests without a browser-ish User-Agent.
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  const err = data && data.chart && data.chart.error;
  if (err) throw new Error(err.description || err.code || 'Yahoo error');
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`no data for ${pair}`);
  return result;
}

async function yahooQuotes(symbols) {
  const results = await Promise.allSettled(
    symbols.map(pair => yahooChart(pair, { interval: '5m', range: '1d' }))
  );
  const out = {};
  const failures = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { failures.push(`${symbols[i]} (${r.reason.message})`); return; }
    const meta = r.value.meta;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    if (typeof price !== 'number') { failures.push(`${symbols[i]} (no price in response)`); return; }
    out[symbols[i]] = {
      close: String(price),
      percent_change: prev ? String(((price - prev) / prev) * 100) : '0'
    };
  });
  // A partial answer is still useful — only give up if nothing came back.
  if (!Object.keys(out).length) throw new Error(failures.join('; ') || 'no symbols returned');
  return out;
}

// Yahoo returns parallel arrays oldest-first; the client wants TwelveData's
// shape — a `values` array, newest first, each with a datetime and OHLC.
// Emitting the datetime as ISO-8601 with a Z keeps it unambiguously UTC and
// still survives the client's `datetime.replace(' ', 'T')`.
async function yahooCandles(pair, interval) {
  const yahooInterval = { '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m', '1h': '60m', '1day': '1d' }[interval] || '5m';
  const range = yahooInterval === '1d' ? '6mo' : '5d';
  const result = await yahooChart(pair, { interval: yahooInterval, range });
  const stamps = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const values = [];
  for (let i = stamps.length - 1; i >= 0; i--) {
    // Yahoo pads the series with nulls for gaps such as the weekend.
    if (q.open?.[i] == null || q.close?.[i] == null) continue;
    values.push({
      datetime: new Date(stamps[i] * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i]
    });
  }
  if (!values.length) throw new Error(`no candles for ${pair}`);
  return { values };
}

// The TwelveData key has been set under a few different names across
// deployments, so accept any of them rather than silently skipping the
// provider because the variable is spelled differently.
function twelveDataKey() {
  return process.env.FOREX_API_KEY
    || process.env.TWELVEDATA_API_KEY
    || process.env.TWELVE_DATA_API_KEY
    || '';
}

// TwelveData returns a flat object for one symbol and a symbol-keyed object for
// several. The client always wants the keyed shape. Check for the key rather
// than trusting the count, so an already-keyed single response isn't nested
// a second time.
function keyBySymbol(data, symbols) {
  if (symbols.length === 1 && data && !data[symbols[0]]) return { [symbols[0]]: data };
  return data;
}

async function twelveDataQuotes(symbols) {
  const url = `${TWELVE_BASE}/quote?symbol=${encodeURIComponent(symbols.join(','))}` +
    `&apikey=${twelveDataKey()}`;
  const res = await fetch(url);
  const data = await res.json();
  // TwelveData reports quota and plan errors as a 200 with a code in the body.
  if (data && data.code && data.code >= 400) {
    throw new Error(data.message || `TwelveData error ${data.code}`);
  }
  return keyBySymbol(data, symbols);
}

// Finnhub's rate table gives every currency against one base in a single call,
// so the whole watchlist costs one request instead of one per symbol.
async function finnhubQuotes(symbols) {
  const url = `${FINNHUB_BASE}/forex/rates?base=USD&token=${process.env.FINNHUB_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const rates = data && data.quote;
  if (!rates) throw new Error(data && data.error ? data.error : 'Finnhub returned no rates');
  rates.USD = 1;

  const out = {};
  for (const pair of symbols) {
    const [base, quote] = pair.split('/');
    // rates maps USD -> X, so pair A/B is rates[B] / rates[A].
    if (rates[base] && rates[quote]) {
      out[pair] = { close: String(rates[quote] / rates[base]), percent_change: '0' };
    }
  }
  if (!Object.keys(out).length) throw new Error('Finnhub covered none of the requested symbols');
  return out;
}

// Walk the configured providers until one answers, collecting a reason from
// each that doesn't so a failure names its own cause. A provider skipped for a
// missing key reports that just as loudly as one that genuinely failed —
// otherwise a misnamed variable looks like a different provider being at fault.
async function firstProviderToAnswer(attempts) {
  const errors = [];
  for (const name of PROVIDER_ORDER) {
    const attempt = attempts[name];
    if (!attempt) continue;
    const missing = attempt.requires && !attempt.requires();
    if (missing) { errors.push(`${name}: no key set (${attempt.keyNames})`); continue; }
    try {
      return await attempt.run();
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'no providers configured');
}

export function getQuotes(symbols) {
  return cached('q:' + symbols.join(','), QUOTE_TTL_MS, () => firstProviderToAnswer({
    yahoo: { run: () => yahooQuotes(symbols) },
    twelvedata: {
      run: () => twelveDataQuotes(symbols),
      requires: () => !!twelveDataKey(),
      keyNames: 'FOREX_API_KEY or TWELVEDATA_API_KEY'
    },
    finnhub: {
      run: () => finnhubQuotes(symbols),
      requires: () => !!process.env.FINNHUB_API_KEY,
      keyNames: 'FINNHUB_API_KEY'
    }
  }));
}

async function twelveDataCandles(symbol, interval) {
  const url = `${TWELVE_BASE}/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&outputsize=120&apikey=${twelveDataKey()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data && data.code && data.code >= 400) {
    throw new Error(data.message || `TwelveData error ${data.code}`);
  }
  return data;
}

export function getCandles(symbol, interval) {
  // Finnhub has no free forex candle endpoint, so it isn't offered here.
  return cached(`c:${symbol}:${interval}`, CANDLE_TTL_MS, () => firstProviderToAnswer({
    yahoo: { run: () => yahooCandles(symbol, interval) },
    twelvedata: {
      run: () => twelveDataCandles(symbol, interval),
      requires: () => !!twelveDataKey(),
      keyNames: 'FOREX_API_KEY or TWELVEDATA_API_KEY'
    }
  }));
}
