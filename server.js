import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Forex price data — https://twelvedata.com (free tier, needs an API key).
// Set FOREX_API_KEY in Railway's variables.
const FOREX_API_KEY = process.env.FOREX_API_KEY || '';
const FOREX_BASE = 'https://api.twelvedata.com';

app.use(express.static(__dirname));

// Batch live quotes for one or more symbols, e.g. /api/quotes?symbols=EUR/USD,GBP/USD
app.get('/api/quotes', async (req, res) => {
  const symbols = req.query.symbols;
  if (!symbols) return res.status(400).json({ error: 'symbols query param required' });
  if (!FOREX_API_KEY) return res.status(503).json({ error: 'FOREX_API_KEY not configured on the server' });
  try {
    const url = `${FOREX_BASE}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${FOREX_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Candlestick history for one symbol, e.g. /api/candles?symbol=EUR/USD&interval=5min
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
