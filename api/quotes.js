import { getQuotes } from './_forex.js';

export default async function handler(req, res) {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  try {
    res.status(200).json(await getQuotes(symbols));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
