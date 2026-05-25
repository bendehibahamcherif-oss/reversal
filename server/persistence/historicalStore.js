export function getCandles(symbol = 'SPY') {
  const normalized = String(symbol || 'SPY').toUpperCase();
  const now = Date.now();

  return [
    {
      t: now - 120000,
      o: 100,
      h: 101,
      l: 99.5,
      c: 100.4,
      v: 1000,
    },
    {
      t: now - 60000,
      o: 100.4,
      h: 100.9,
      l: 100.1,
      c: 100.7,
      v: 850,
    },
    {
      t: now,
      o: 100.7,
      h: 101.2,
      l: 100.6,
      c: 101,
      v: 910,
    },
  ].map((candle) => ({
    ...candle,
    symbol: normalized,
  }));
}
