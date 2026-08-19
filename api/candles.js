import { getCandles } from './_forex.js';

export default async function handler(req, res) {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  try {
    res.status(200).json(await getCandles(symbol, req.query.interval || '5min'));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
