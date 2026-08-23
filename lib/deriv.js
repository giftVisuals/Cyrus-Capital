// Synthetic indices data layer for Deriv's public WebSocket API.
// Connects to Deriv and streams real-time synthetic index prices (Volatility, Boom, Crash, etc).
// No API key needed for public market data endpoint.

import WebSocket from 'ws';

const DERIV_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

const SYMBOL_MAP = {
  'Volatility 5 Index': { id: 1, name: 'Volatility 5 Index' },
  'Volatility 10 Index': { id: 2, name: 'Volatility 10 Index' },
  'Volatility 25 Index': { id: 3, name: 'Volatility 25 Index' },
  'Volatility 50 Index': { id: 4, name: 'Volatility 50 Index' },
  'Volatility 100 Index': { id: 5, name: 'Volatility 100 Index' },
  'Boom 100 Index': { id: 6, name: 'Boom 100 Index' },
  'Boom 500 Index': { id: 7, name: 'Boom 500 Index' },
  'Boom 1000 Index': { id: 8, name: 'Boom 1000 Index' },
  'Crash 100 Index': { id: 9, name: 'Crash 100 Index' },
  'Crash 500 Index': { id: 10, name: 'Crash 500 Index' },
  'Crash 1000 Index': { id: 11, name: 'Crash 1000 Index' },
  'Jump 50 Index': { id: 12, name: 'Jump 50 Index' },
  'Jump 100 Index': { id: 13, name: 'Jump 100 Index' },
  'Range Break 100 Index': { id: 14, name: 'Range Break 100 Index' },
  'Range Break 200 Index': { id: 15, name: 'Range Break 200 Index' }
};

let ws = null;
let cache = {};
let isConnecting = false;

async function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (isConnecting) {
    return new Promise((resolve) => {
      const check = () => {
        if (ws && ws.readyState === WebSocket.OPEN) resolve(true);
        else setTimeout(check, 100);
      };
      check();
    });
  }

  return new Promise((resolve) => {
    isConnecting = true;
    try {
      ws = new WebSocket(DERIV_WS);
      ws.on('open', () => {
        isConnecting = false;
        subscribeToAllSymbols();
        resolve(true);
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.tick) {
            const symbol = msg.tick.symbol;
            if (symbol && SYMBOL_MAP[symbol]) {
              cache[symbol] = {
                close: msg.tick.quote,
                bid: msg.tick.bid,
                ask: msg.tick.ask,
                time: msg.tick.time
              };
            }
          }
        } catch (e) { console.error('Deriv parse error', e); }
      });
      ws.on('error', (err) => {
        console.error('Deriv WebSocket error', err.message);
        isConnecting = false;
        resolve(false);
      });
      ws.on('close', () => {
        console.log('Deriv WebSocket closed, will reconnect on next request');
        ws = null;
        isConnecting = false;
      });
    } catch (e) {
      console.error('Deriv connection failed', e.message);
      isConnecting = false;
      resolve(false);
    }
  });
}

function subscribeToAllSymbols() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  Object.keys(SYMBOL_MAP).forEach(symbol => {
    const msg = {
      ticks: symbol,
      subscribe: 1
    };
    try { ws.send(JSON.stringify(msg)); } catch (e) { console.error('Subscribe failed:', symbol, e.message); }
  });
}

export async function getSynthetics(symbols) {
  await ensureConnected();

  const out = {};
  const failures = [];

  for (const symbol of symbols) {
    if (cache[symbol] && cache[symbol].close) {
      const price = parseFloat(cache[symbol].close);
      const prev = parseFloat(cache[symbol].close) * 0.99; // Approximate 1% movement for demo
      out[symbol] = {
        close: String(price),
        bid: String(parseFloat(cache[symbol].bid || price) || price),
        ask: String(parseFloat(cache[symbol].ask || price) || price),
        percent_change: String(((price - prev) / prev) * 100)
      };
    } else {
      failures.push(symbol);
    }
  }

  if (!Object.keys(out).length && failures.length) {
    throw new Error(`No data for synthetics: ${failures.join(', ')}. Deriv connection may not be ready yet.`);
  }

  return out;
}
