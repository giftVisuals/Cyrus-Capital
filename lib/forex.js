// Forex data layer for the Railway server (server.js). The API keys live only
// on Railway — Vercel forwards /api/* here (see the rewrite in vercel.json) and
// never sees them.
//
// Env vars (Railway only):
//   FOREX_API_KEY    — https://twelvedata.com  (quotes + candles)
//   FINNHUB_API_KEY  — https://finnhub.io      (quote fallback, optional)

const TWELVE_BASE = 'https://api.twelvedata.com';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

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

// TwelveData returns a flat object for one symbol and a symbol-keyed object for
// several. The client always wants the keyed shape.
function keyBySymbol(data, symbols) {
  if (symbols.length === 1) return { [symbols[0]]: data };
  return data;
}

async function twelveDataQuotes(symbols) {
  const url = `${TWELVE_BASE}/quote?symbol=${encodeURIComponent(symbols.join(','))}` +
    `&apikey=${process.env.FOREX_API_KEY}`;
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

export function getQuotes(symbols) {
  return cached('q:' + symbols.join(','), QUOTE_TTL_MS, async () => {
    const errors = [];
    if (process.env.FOREX_API_KEY) {
      try { return await twelveDataQuotes(symbols); } catch (err) { errors.push('TwelveData: ' + err.message); }
    }
    if (process.env.FINNHUB_API_KEY) {
      try { return await finnhubQuotes(symbols); } catch (err) { errors.push('Finnhub: ' + err.message); }
    }
    if (!errors.length) throw new Error('No forex API key configured (set FOREX_API_KEY or FINNHUB_API_KEY)');
    throw new Error(errors.join(' | '));
  });
}

export function getCandles(symbol, interval) {
  return cached(`c:${symbol}:${interval}`, CANDLE_TTL_MS, async () => {
    if (!process.env.FOREX_API_KEY) throw new Error('FOREX_API_KEY not configured');
    const url = `${TWELVE_BASE}/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&outputsize=120&apikey=${process.env.FOREX_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.code && data.code >= 400) {
      throw new Error(data.message || `TwelveData error ${data.code}`);
    }
    return data;
  });
}
