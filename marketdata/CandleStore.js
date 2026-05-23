export class CandleStore {
  constructor() {
    this.data = new Map();
  }

  append(symbol, timeframe, candle) {
    const key = `${symbol}:${timeframe}`;

    if (!this.data.has(key)) {
      this.data.set(key, []);
    }

    this.data.get(key).push(candle);
  }

  get(symbol, timeframe) {
    const key = `${symbol}:${timeframe}`;

    return this.data.get(key) || [];
  }

  latest(symbol, timeframe) {
    const candles = this.get(symbol, timeframe);

    return candles[candles.length - 1] || null;
  }
}

export const candleStore = new CandleStore();
