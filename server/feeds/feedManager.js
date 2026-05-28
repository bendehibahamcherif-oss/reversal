import { createFeedStatus, createNormalizedCandle, createNormalizedOrderBook, createNormalizedTick } from './models.js';
import { getCandlesWithMeta } from '../persistence/historicalStore.js';
import { providerRegistry } from './providers/providerRegistry.js';
import { credentialStore } from './providers/credentialStore.js';
import { activeProviderStore } from '../persistence/activeProviderStore.js';

function seededUnit(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

const DEFAULT_DATA_PROVIDER = String(process.env.DEFAULT_DATA_PROVIDER || 'yahoo');
const DEFAULT_FALLBACK_PROVIDER = 'fallback_demo';

function normalizeSymbolList(symbols = []) { return Array.isArray(symbols) ? symbols.map((s) => String(s).toUpperCase()).filter(Boolean) : []; }

class FeedManager {
  constructor() {
    this.statusBySource = new Map(); this.latestTicks = new Map(); this.latestCandles = new Map(); this.latestOrderBooks = new Map();
    this.activeProviders = []; this.activeSymbols = []; this.enabledByProvider = {};
    this.providerFailures = new Map();
    this.restoreActiveProviderState();
    this.rebuildProviderStatuses();
  }

  normalizeProviderContract(provider = {}, runtime = null) {
    const normalizedRuntime = runtime || this.getRuntimeState(provider.id);
    const apiKeyMasked = String(provider.apiKeyMasked || provider.apiKey || '');
    const maskedFields = Array.isArray(provider.maskedFields) ? provider.maskedFields.filter(Boolean).map((field) => String(field)) : (apiKeyMasked ? [`apiKey:${apiKeyMasked}`] : []);
    const credentialLoaded = Boolean(normalizedRuntime.credentialLoaded);
    return {
      provider: String(provider.id || provider.provider || ''),
      configured: credentialLoaded,
      enabled: Boolean(provider.enabled),
      active: Boolean(provider.active),
      usable: Boolean(normalizedRuntime.usable),
      credentialLoaded,
      providerInitialized: Boolean(normalizedRuntime.providerInitialized),
      lastError: normalizedRuntime.lastError || null,
      status: String(normalizedRuntime.status || provider.status || 'unknown'),
      apiKeyMasked,
      maskedFields
    };
  }

  getRuntimeState(providerId) {
    const runtime = this.validateProviderRuntime(providerId);
    return { ...runtime, valid: runtime.providerInitialized && runtime.usable && runtime.credentialLoaded && runtime.enabled };
  }

  resolveActiveState({ providers = [], enabledByProvider = {}, symbols = [] } = {}) {
    const available = providerRegistry.list().map((p) => p.id);
    const requested = Array.isArray(providers) && providers.length ? providers.map((id) => String(id)) : [DEFAULT_DATA_PROVIDER, DEFAULT_FALLBACK_PROVIDER];
    const deduped = [];
    for (const providerId of requested) {
      if (!available.includes(providerId) || deduped.includes(providerId)) continue;
      deduped.push(providerId);
    }

    const normalizedEnabled = {};
    for (const providerId of available) {
      const explicit = enabledByProvider && Object.prototype.hasOwnProperty.call(enabledByProvider, providerId) ? Boolean(enabledByProvider[providerId]) : deduped.includes(providerId);
      normalizedEnabled[providerId] = explicit;
    }

    const preferredOrder = ['yahoo', 'twelvedata', DEFAULT_FALLBACK_PROVIDER];
    const orderedRequested = [...preferredOrder, ...deduped.filter((providerId) => !preferredOrder.includes(providerId))];
    const validProviders = orderedRequested.filter((providerId) => normalizedEnabled[providerId]).filter((providerId) => this.getRuntimeState(providerId).valid);
    const fallbackOrdered = available.filter((providerId) => normalizedEnabled[providerId] && this.getRuntimeState(providerId).valid);
    const finalProviders = (validProviders.length ? validProviders : fallbackOrdered).length ? (validProviders.length ? validProviders : fallbackOrdered) : [DEFAULT_FALLBACK_PROVIDER];

    if (!finalProviders.includes(DEFAULT_FALLBACK_PROVIDER) && this.getRuntimeState(DEFAULT_FALLBACK_PROVIDER).valid) {
      finalProviders.push(DEFAULT_FALLBACK_PROVIDER);
      normalizedEnabled[DEFAULT_FALLBACK_PROVIDER] = true;
    }

    return { providers: finalProviders, enabledByProvider: normalizedEnabled, symbols: normalizeSymbolList(symbols) };
  }

  restoreActiveProviderState() {
    const persisted = activeProviderStore.load();
    const resolved = this.resolveActiveState(persisted || {});
    this.activeProviders = resolved.providers;
    this.enabledByProvider = resolved.enabledByProvider;
    this.activeSymbols = resolved.symbols;
    activeProviderStore.save(resolved);
  }

  persistActiveProviderState() {
    activeProviderStore.save({ providers: this.activeProviders, enabledByProvider: this.enabledByProvider, symbols: this.activeSymbols });
  }

  rebuildProviderStatuses() {
    for (const provider of providerRegistry.list()) {
      const s = providerRegistry.getStatus(provider.id);
      this.statusBySource.set(provider.id, createFeedStatus({ source: provider.id, ...s }));
    }
  }

  listProviders() {
    return providerRegistry.list().map((p) => {
      const runtime = this.getRuntimeState(p.id);
      const meta = credentialStore.getMeta(p.id);
      const provider = { id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...meta, enabled: Boolean(this.enabledByProvider[p.id]), active: this.activeProviders.includes(p.id), priority: this.activeProviders.indexOf(p.id), runtime, status: providerRegistry.getStatus(p.id).status, connected: providerRegistry.getStatus(p.id).connected, warnings: providerRegistry.getStatus(p.id).warnings || [] };
      const contract = this.normalizeProviderContract(provider, runtime);
      return { ...provider, ...contract, contract };
    });
  }
  getProvider(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const ps = providerRegistry.getStatus(providerId); const runtime = this.getRuntimeState(providerId); const provider = { id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...credentialStore.getMeta(providerId), enabled: Boolean(this.enabledByProvider[p.id]), active: this.activeProviders.includes(p.id), priority: this.activeProviders.indexOf(p.id), runtime, status: ps.status, connected: ps.connected, warnings: ps.warnings || [] }; return { ...provider, ...this.normalizeProviderContract(provider, runtime), contract: this.normalizeProviderContract(provider, runtime) }; }
  setProviderCredentials(providerId, credentials) { const p = providerRegistry.get(providerId); if (!p) return null; credentialStore.set(providerId, credentials); this.setActiveProviders(this.getActiveProviders()); this.rebuildProviderStatuses(); return credentialStore.getMeta(providerId); }
  clearProviderCredentials(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const meta = credentialStore.clear(providerId); this.setActiveProviders(this.getActiveProviders()); this.rebuildProviderStatuses(); return meta; }

  listProviderCredentials() { return credentialStore.listMeta(); }
  validateProviderRuntime(providerId) {
    const provider = providerRegistry.get(providerId);
    const credentials = credentialStore.get(providerId);
    if (!provider) {
      return { provider: String(providerId || ''), credentialLoaded: false, providerInitialized: false, enabled: false, usable: false, active: false, status: 'provider_not_found', lastError: null };
    }
    const hasCredential = Boolean(credentials.apiKey);
    const credentialLoaded = !provider.requiresCredentials || hasCredential;
    const providerInitialized = typeof provider.status === 'function';
    const state = providerInitialized ? provider.status(credentials) : { status: 'unknown', connected: false };
    const usable = !provider.requiresCredentials || state.status !== 'missing_credentials';
    const enabled = this.enabledByProvider[provider.id] !== undefined ? Boolean(this.enabledByProvider[provider.id]) : true;
    return { provider: provider.id, credentialLoaded, providerInitialized, enabled, usable, active: this.activeProviders.includes(provider.id), status: state.status, lastError: state.lastError || null };
  }
  setActiveProviders({ providers = [], enabledByProvider = {}, symbols = [] } = {}) {
    const fallbackPrevious = { providers: this.activeProviders, enabledByProvider: this.enabledByProvider, symbols: this.activeSymbols };
    const mergedEnabled = { ...this.enabledByProvider, ...(enabledByProvider || {}) };
    const hasProvidersField = Array.isArray(providers);
    const providerInput = hasProvidersField ? providers : fallbackPrevious.providers;
    const resolved = this.resolveActiveState({ providers: providerInput.length ? providerInput : fallbackPrevious.providers, enabledByProvider: mergedEnabled, symbols: Array.isArray(symbols) ? symbols : fallbackPrevious.symbols });
    if (!resolved.providers.length && fallbackPrevious.providers.length) return this.getActiveProviders();
    this.activeProviders = resolved.providers;
    this.enabledByProvider = resolved.enabledByProvider;
    this.activeSymbols = resolved.symbols;
    this.persistActiveProviderState();
    this.rebuildProviderStatuses();
    return this.getActiveProviders();
  }
  getActiveProviders() { return { providers: Array.isArray(this.activeProviders) ? this.activeProviders.filter(Boolean).map((provider) => String(provider)) : [], providerOrder: Array.isArray(this.activeProviders) ? this.activeProviders.filter(Boolean).map((provider) => String(provider)) : [], enabledByProvider: { ...this.enabledByProvider }, symbols: Array.isArray(this.activeSymbols) ? this.activeSymbols.filter(Boolean).map((symbol) => String(symbol)) : [], defaultProvider: DEFAULT_DATA_PROVIDER }; }
  getDebugState() {
    const providers = this.listProviders();
    return {
      activeProviders: this.getActiveProviders().providers,
      providerOrder: this.getActiveProviders().providerOrder,
      enabledByProvider: { ...this.enabledByProvider },
      providers,
      credentialsConfigured: providers.reduce((acc, provider) => ({ ...acc, [provider.provider]: Boolean(provider.configured) }), {}),
      timestamp: new Date().toISOString(),
    };
  }

  recordProviderFailure(provider, error) {
    const providerId = String(provider || 'unknown');
    this.providerFailures.set(providerId, {
      provider: providerId,
      reason: String(error?.code || error?.message || error || 'provider_failed'),
      timestamp: new Date().toISOString(),
    });
  }

  startFeed(source = DEFAULT_DATA_PROVIDER, symbols = []) { const s = this.setActiveProviders({ providers: [String(source || DEFAULT_DATA_PROVIDER)], symbols }); return this.getFeedStatusBySource(s.providers[0]); }
  stopFeed(source = DEFAULT_DATA_PROVIDER) { const current = this.getFeedStatusBySource(source); const next = createFeedStatus({ ...current, status: current.source === DEFAULT_FALLBACK_PROVIDER ? 'idle_demo' : 'stopped', connected: false }); this.statusBySource.set(next.source, next); return next; }
  getFeedStatus() { this.rebuildProviderStatuses(); return Array.from(this.statusBySource.values()); }
  getFeedStatusBySource(source = DEFAULT_DATA_PROVIDER) { return this.statusBySource.get(String(source)) || createFeedStatus({ source, status: 'missing', connected: false, warnings: ['Feed source has not been initialized.'] }); }
  ingestTick(tick) { const n = createNormalizedTick(tick); this.latestTicks.set(n.symbol, n); this.bumpStatus(n.source, n.symbol, n.timestamp); return n; }
  ingestCandle(c) { const n = createNormalizedCandle(c); this.latestCandles.set(`${n.symbol}:${n.timeframe}`, n); this.bumpStatus(n.source, n.symbol, n.timestamp); return n; }
  ingestOrderBook(b) { const n = createNormalizedOrderBook(b); this.latestOrderBooks.set(n.symbol, n); this.bumpStatus(n.source, n.symbol, n.timestamp); return n; }

  async getLatestTick(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const chain = this.getActiveProviders().providerOrder;
    for (const source of chain) {
      const from = this.latestTicks.get(sym);
      if (from && from.source === source) return from;
      const provider = providerRegistry.get(source);
      const credentials = credentialStore.get(source);
      if (!provider?.getLatestTick) continue;
      try {
        const live = await provider.getLatestTick(sym, credentials);
        if (live) return this.ingestTick({ ...live, source: live.source || source });
        this.recordProviderFailure(source, { code: 'empty_result' });
      } catch (error) {
        this.recordProviderFailure(source, error);
      }
    }
    return this.latestTicks.get(sym) || null;
  }
  async getLatestCandle(symbol, timeframe = '1m') {
    const key = `${String(symbol || '').toUpperCase()}:${timeframe}`;
    const cached = this.latestCandles.get(key);
    if (cached) return cached;
    const sym = String(symbol || '').toUpperCase();
    const chain = this.getActiveProviders().providerOrder;
    for (const source of chain) {
      const provider = providerRegistry.get(source);
      const credentials = credentialStore.get(source);
      if (!provider?.getLatestCandle) continue;
      try {
        const live = await provider.getLatestCandle(sym, timeframe, credentials);
        if (live) return this.ingestCandle({ ...live, source: live.source || source });
        this.recordProviderFailure(source, { code: 'empty_result' });
      } catch (error) {
        this.recordProviderFailure(source, error);
      }
    }
    const fromStore = getCandlesWithMeta(symbol, timeframe); const candles = fromStore?.candles || []; if (!candles.length) return null; const last = candles[candles.length - 1];
    return createNormalizedCandle({ symbol, timeframe, open: last.o, high: last.h, low: last.l, close: last.c, volume: last.v, source: fromStore.source || DEFAULT_FALLBACK_PROVIDER, timestamp: last.t });
  }
  async getReplayCandles(symbol, timeframe = '1m', limit = 200) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const normalizedLimit = Math.max(1, Number(limit) || 200);
    const chain = this.getActiveProviders().providerOrder;

    for (const source of chain) {
      const provider = providerRegistry.get(source);
      if (!provider?.getCandles) continue;
      const credentials = credentialStore.get(source);
      console.info('[replayProviderChain]', JSON.stringify({ event: 'provider_selected', symbol: normalizedSymbol, timeframe, limit: normalizedLimit, provider: source }));
      try {
        const candles = await provider.getCandles(normalizedSymbol, timeframe, normalizedLimit, credentials);
        if (Array.isArray(candles) && candles.length > 0) {
          console.info('[replayProviderChain]', JSON.stringify({ event: 'provider_success', symbol: normalizedSymbol, timeframe, provider: source, candleCount: candles.length }));
          return { symbol: normalizedSymbol, timeframe, source: source, candles };
        }
        console.warn('[replayProviderChain]', JSON.stringify({ event: 'provider_failed', symbol: normalizedSymbol, timeframe, provider: source, reason: 'empty_result' }));
        this.recordProviderFailure(source, { code: 'empty_result' });
      } catch (error) {
        console.warn('[replayProviderChain]', JSON.stringify({ event: 'provider_failed', symbol: normalizedSymbol, timeframe, provider: source, reason: String(error?.code || error?.message || 'provider_failed') }));
        this.recordProviderFailure(source, error);
      }
    }

    const fromStore = getCandlesWithMeta(normalizedSymbol, timeframe);
    console.warn('[replayProviderChain]', JSON.stringify({ event: 'fallback_activated', symbol: normalizedSymbol, timeframe, reason: 'all_realtime_providers_failed', fallbackSource: fromStore?.source || DEFAULT_FALLBACK_PROVIDER }));
    return {
      symbol: normalizedSymbol,
      timeframe,
      source: fromStore?.source || DEFAULT_FALLBACK_PROVIDER,
      candles: Array.isArray(fromStore?.candles) ? fromStore.candles.slice(-normalizedLimit) : [],
      warning: fromStore?.warning || null,
    };
  }
  getLatestOrderBook(symbol) { return this.latestOrderBooks.get(String(symbol || '').toUpperCase()) || null; }
  async debugYahoo(symbol, timeframe = '1m') {
    const yahooProvider = providerRegistry.get('yahoo');
    if (!yahooProvider?.debugSymbol) {
      return { provider: 'yahoo', symbol: String(symbol || '').toUpperCase(), timeframe, request: { success: false, failure: { code: 'provider_unavailable' } }, parsedCandleCount: 0, validationWarnings: ['yahoo provider missing debug capability'], fallbackTriggered: true };
    }
    return yahooProvider.debugSymbol(symbol, timeframe);
  }
  generateDemoTick(symbol) { const normalized = String(symbol || 'SPY').toUpperCase(); const base = 500 + seededUnit(normalized.length * 97) * 50; const price = Number(base.toFixed(4)); return this.ingestTick({ symbol: normalized, price, bid: Number((price - 0.01).toFixed(4)), ask: Number((price + 0.01).toFixed(4)), volume: 1000, source: 'fallback_demo', sequence: Date.now() % 1_000_000 }); }
  generateDemoCandle(symbol, timeframe = '1m') { const tick = this.generateDemoTick(symbol); const open = Number((tick.price * 0.999).toFixed(4)); const close = tick.price; return this.ingestCandle({ symbol: tick.symbol, timeframe, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 10_000, source: 'fallback_demo' }); }
  generateDemoOrderBook(symbol) { const tick = this.generateDemoTick(symbol); const bids = [[Number((tick.price - 0.01).toFixed(4)), 200], [Number((tick.price - 0.02).toFixed(4)), 350]]; const asks = [[Number((tick.price + 0.01).toFixed(4)), 180], [Number((tick.price + 0.02).toFixed(4)), 300]]; return this.ingestOrderBook({ symbol: tick.symbol, bids, asks, spread: Number((asks[0][0] - bids[0][0]).toFixed(4)), imbalance: 0.53, source: 'fallback_demo' }); }
  bumpStatus(source, symbol, timestamp) { const current = this.getFeedStatusBySource(source); const symbols = new Set(current.symbols || []); if (symbol) symbols.add(symbol); const isDemo = source === 'fallback_demo'; this.statusBySource.set(source, createFeedStatus({ ...current, source, status: isDemo ? 'idle_demo' : (current.status || 'connected'), connected: isDemo ? false : Boolean(current.connected), symbols: Array.from(symbols), lastMessageAt: timestamp, warnings: isDemo ? ['Demo fallback source only. Not a live feed.'] : current.warnings })); }
}

export const feedManager = new FeedManager();
