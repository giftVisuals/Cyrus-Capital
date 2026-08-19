import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getQuotes, getCandles } from './api/_forex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// The two /api routes below mirror the Vercel serverless functions in /api, so
// the same front-end works whether it is served from Railway or Vercel.

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

app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'app/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin/index.html')));
app.get('/admin/support', (req, res) => res.sendFile(path.join(__dirname, 'admin/support.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support/index.html')));

app.listen(PORT, () => console.log(`Cyrus Capital server running on port ${PORT}`));
