import { candleStore } from './CandleStore.js';

export class ReplayFeed {
  constructor(symbol, timeframe) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.index = 0;
  }

  next() {
    const candles = candleStore.get(
      this.symbol,
      this.timeframe
    );

    if (this.index >= candles.length) {
      return null;
    }

    return candles[this.index++];
  }

  reset() {
    this.index = 0;
  }
}
