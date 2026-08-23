import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getQuotes, getCandles } from './lib/forex.js';
import { getSynthetics } from './lib/deriv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Railway owns the price API. The front-end may be served from another host
// (Vercel), so allow cross-origin reads — these endpoints return public market
// data only, take no credentials and expose no keys.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Batch live quotes for one or more symbols, e.g. /api/quotes?symbols=EUR/USD,GBP/USD
app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  try {
    res.json(await getQuotes(symbols));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Candlestick history for one symbol, e.g. /api/candles?symbol=EUR/USD&interval=5min
app.get('/api/candles', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  try {
    res.json(await getCandles(symbol, req.query.interval || '5min'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Live synthetic index quotes from Deriv, e.g. /api/synthetics?symbols=Volatility 5 Index,Boom 100 Index
app.get('/api/synthetics', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  try {
    res.json(await getSynthetics(symbols));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// No marketing landing page — Cyrus Capital is a broker, so the root is the
// trading app itself.
app.get('/', (req, res) => res.redirect('/app'));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'app/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin/index.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'admin/support.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support/index.html')));

app.listen(PORT, () => console.log(`Cyrus Capital server running on port ${PORT}`));
