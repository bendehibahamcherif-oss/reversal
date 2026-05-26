import { createFeedStatus, createNormalizedCandle, createNormalizedOrderBook, createNormalizedTick } from './models.js';
import { getCandlesWithMeta } from '../persistence/historicalStore.js';

function seededUnit(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

class FeedManager {
  constructor() {
    this.statusBySource = new Map();
    this.latestTicks = new Map();
    this.latestCandles = new Map();
    this.latestOrderBooks = new Map();

    this.statusBySource.set('fallback_demo', createFeedStatus({
      source: 'fallback_demo',
      status: 'idle_demo',
      connected: false,
      warnings: ['Demo fallback source only. No live paid feed configured.'],
    }));
  }

  startFeed(source = 'fallback_demo', symbols = []) {
    const normalizedSource = String(source || 'fallback_demo');
    const normalizedSymbols = Array.isArray(symbols) ? symbols : [];

    const isDemo = normalizedSource === 'fallback_demo';
    const status = createFeedStatus({
      source: normalizedSource,
      status: isDemo ? 'idle_demo' : 'missing_credentials',
      connected: false,
      symbols: normalizedSymbols,
      warnings: isDemo
        ? ['Demo fallback source is idle by default and not live.']
        : ['Feed not started: credentials or connector unavailable.'],
    });

    this.statusBySource.set(normalizedSource, status);
    return status;
  }

  stopFeed(source = 'fallback_demo') {
    const current = this.getFeedStatusBySource(source);
    const next = createFeedStatus({ ...current, status: current.source === 'fallback_demo' ? 'idle_demo' : 'stopped', connected: false });
    this.statusBySource.set(next.source, next);
    return next;
  }

  getFeedStatus() {
    return Array.from(this.statusBySource.values());
  }

  getFeedStatusBySource(source = 'fallback_demo') {
    return this.statusBySource.get(String(source)) || createFeedStatus({
      source,
      status: 'missing',
      connected: false,
      warnings: ['Feed source has not been initialized.'],
    });
  }

  ingestTick(tick) {
    const normalized = createNormalizedTick(tick);
    this.latestTicks.set(normalized.symbol, normalized);
    this.bumpStatus(normalized.source, normalized.symbol, normalized.timestamp);
    return normalized;
  }

  ingestCandle(candle) {
    const normalized = createNormalizedCandle(candle);
    this.latestCandles.set(`${normalized.symbol}:${normalized.timeframe}`, normalized);
    this.bumpStatus(normalized.source, normalized.symbol, normalized.timestamp);
    return normalized;
  }

  ingestOrderBook(book) {
    const normalized = createNormalizedOrderBook(book);
    this.latestOrderBooks.set(normalized.symbol, normalized);
    this.bumpStatus(normalized.source, normalized.symbol, normalized.timestamp);
    return normalized;
  }

  getLatestTick(symbol) {
    return this.latestTicks.get(String(symbol || '').toUpperCase()) || null;
  }

  getLatestCandle(symbol, timeframe = '1m') {
    const key = `${String(symbol || '').toUpperCase()}:${timeframe}`;
    const cached = this.latestCandles.get(key);
    if (cached) return cached;

    const fromStore = getCandlesWithMeta(symbol, timeframe);
    const candles = fromStore?.candles || [];
    if (candles.length === 0) return null;
    const last = candles[candles.length - 1];
    return createNormalizedCandle({
      symbol,
      timeframe,
      open: last.o,
      high: last.h,
      low: last.l,
      close: last.c,
      volume: last.v,
      source: fromStore.source || 'fallback_demo',
      timestamp: last.t,
    });
  }

  getLatestOrderBook(symbol) {
    return this.latestOrderBooks.get(String(symbol || '').toUpperCase()) || null;
  }

  generateDemoTick(symbol) {
    const normalized = String(symbol || 'SPY').toUpperCase();
    const base = 500 + seededUnit(normalized.length * 97) * 50;
    const price = Number(base.toFixed(4));
    return this.ingestTick({ symbol: normalized, price, bid: Number((price - 0.01).toFixed(4)), ask: Number((price + 0.01).toFixed(4)), volume: 1000, source: 'fallback_demo', sequence: Date.now() % 1_000_000 });
  }

  generateDemoCandle(symbol, timeframe = '1m') {
    const tick = this.generateDemoTick(symbol);
    const open = Number((tick.price * 0.999).toFixed(4));
    const close = tick.price;
    return this.ingestCandle({ symbol: tick.symbol, timeframe, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 10_000, source: 'fallback_demo' });
  }

  generateDemoOrderBook(symbol) {
    const tick = this.generateDemoTick(symbol);
    const bids = [[Number((tick.price - 0.01).toFixed(4)), 200], [Number((tick.price - 0.02).toFixed(4)), 350]];
    const asks = [[Number((tick.price + 0.01).toFixed(4)), 180], [Number((tick.price + 0.02).toFixed(4)), 300]];
    return this.ingestOrderBook({ symbol: tick.symbol, bids, asks, spread: Number((asks[0][0] - bids[0][0]).toFixed(4)), imbalance: 0.53, source: 'fallback_demo' });
  }

  bumpStatus(source, symbol, timestamp) {
    const current = this.getFeedStatusBySource(source);
    const symbols = new Set(current.symbols || []);
    if (symbol) symbols.add(symbol);
    const isDemo = source === 'fallback_demo';
    this.statusBySource.set(source, createFeedStatus({
      ...current,
      source,
      status: isDemo ? 'idle_demo' : (current.status || 'connected'),
      connected: isDemo ? false : Boolean(current.connected),
      symbols: Array.from(symbols),
      lastMessageAt: timestamp,
      warnings: isDemo ? ['Demo fallback source only. Not a live feed.'] : current.warnings,
    }));
  }
}

export const feedManager = new FeedManager();
