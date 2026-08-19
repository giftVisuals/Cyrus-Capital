import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Forex price data — Primary: TwelveData (https://twelvedata.com), Backup: Finnhub (https://finnhub.io)
// Set FOREX_API_KEY and FINNHUB_API_KEY in Railway's environment variables.
const FOREX_API_KEY = process.env.FOREX_API_KEY || '';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
const FOREX_BASE = 'https://api.twelvedata.com';
const FINNHUB_BASE = 'https://finnhub.io/api/forex/quote';

app.use(express.static(__dirname));

// Batch live quotes for one or more symbols, e.g. /api/quotes?symbols=EUR/USD,GBP/USD
// Tries TwelveData first, falls back to Finnhub for single symbol
app.get('/api/quotes', async (req, res) => {
  const symbols = req.query.symbols;
  if (!symbols) return res.status(400).json({ error: 'symbols query param required' });

  // Try TwelveData first (supports batch)
  if (FOREX_API_KEY) {
    try {
      const url = `${FOREX_BASE}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${FOREX_API_KEY}`;
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        return res.json(data);
      }
    } catch (err) {
      console.log('TwelveData quote failed, trying Finnhub...');
    }
  }

  // Fallback to Finnhub (single symbol only)
  if (FINNHUB_API_KEY && !symbols.includes(',')) {
    try {
      const [base, quote] = symbols.split('/');
      const symbol = `${base}${quote}`;
      const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        return res.json(data);
      }
    } catch (err) {
      console.log('Finnhub quote failed:', err.message);
    }
  }

  return res.status(503).json({ error: 'No API keys configured or all sources failed' });
});

// Candlestick history for one symbol, e.g. /api/candles?symbol=EUR/USD&interval=5min
// Uses TwelveData for historical candle data (Finnhub does not provide historical OHLC for forex)
app.get('/api/candles', async (req, res) => {
  const symbol = req.query.symbol;
  const interval = req.query.interval || '5min';
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  if (!FOREX_API_KEY) return res.status(503).json({ error: 'FOREX_API_KEY not configured on the server' });
  try {
    const url = `${FOREX_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&outputsize=120&apikey=${FOREX_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'app/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin/index.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'admin/support.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support/index.html')));

app.listen(PORT, () => console.log(`Cyrus Capital server running on port ${PORT}`));
