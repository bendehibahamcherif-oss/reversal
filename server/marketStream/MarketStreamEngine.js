import { credentialStore } from '../feeds/providers/credentialStore.js';
import { feedManager } from '../feeds/feedManager.js';
import { TickBuffer } from './TickBuffer.js';
import { AssetClassifier } from './AssetClassifier.js';
import { getCapabilities, supportsAssetClass, FAILOVER_PRIORITY } from './CapabilityModel.js';
import { PolygonAdapter } from './adapters/PolygonAdapter.js';
import { AlphaVantageAdapter } from './adapters/AlphaVantageAdapter.js';
import { IbkrAdapter } from './adapters/IbkrAdapter.js';
import { YahooAdapter } from './adapters/YahooAdapter.js';
import { TwelveDataAdapter } from './adapters/TwelveDataAdapter.js';
import { FallbackDemoAdapter } from './adapters/FallbackDemoAdapter.js';

const STALE_CHECK_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 120_000;

class MarketStreamEngine {
  constructor() {
    this.adapters = new Map([
      ['polygon', new PolygonAdapter()],
      ['ibkr', new IbkrAdapter()],
      ['twelvedata', new TwelveDataAdapter()],
      ['alphaVantage', new AlphaVantageAdapter()],
      ['yahoo', new YahooAdapter()],
      ['fallback_demo', new FallbackDemoAdapter()],
    ]);

    this.tickBuffer = new TickBuffer({ throttleMs: 250 });
    this.assetClassifier = new AssetClassifier();

    // symbol → { providerId, assetClass, subscribedAt }
    this.subscriptions = new Map();
    // symbol → reason string
    this.failoverReasons = new Map();

    this._staleCheckTimer = null;
    this._heartbeatTimer = null;
    this._initialized = false;
    this._startedAt = null;

    // Wire tick buffer output → feedManager ingestion (shared tick cache)
    this.tickBuffer.onTick((tick) => {
      try {
        feedManager.ingestTick({
          symbol: tick.symbol,
          price: tick.price,
          bid: tick.bid,
          ask: tick.ask,
          volume: tick.volume,
          source: tick.source || tick.provider,
          timestamp: tick.timestamp,
        });
      } catch {}
    });
  }

  async initialize() {
    if (this._initialized) return;
    this._initialized = true;
    this._startedAt = new Date().toISOString();

    // Wire adapter tick events → buffer
    for (const [id, adapter] of this.adapters) {
      adapter.on('tick', (tick) => {
        this.tickBuffer.ingest({ ...tick, source: id });
      });
    }

    // Connect adapters that are eligible at startup
    await this._connectEligibleAdapters();

    // Periodic stale detection + failover
    this._staleCheckTimer = setInterval(() => this._runStaleCheck(), STALE_CHECK_INTERVAL_MS);

    // Heartbeat: verify at least one real provider has seen a tick recently
    this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_TIMEOUT_MS);

    console.info('[MarketStreamEngine] initialized', JSON.stringify({
      adapters: Array.from(this.adapters.keys()),
      startedAt: this._startedAt,
    }));
  }

  async _connectEligibleAdapters() {
    for (const [id, adapter] of this.adapters) {
      const caps = getCapabilities(id);
      if (caps.requiresGateway) continue; // ibkr: never auto-connect
      const credentials = credentialStore.get(id);
      const hasCredentials = Boolean(credentials?.apiKey);
      if (caps.requiresCredentials && !hasCredentials) continue;
      try {
        await adapter.connect(credentials);
        console.info('[MarketStreamEngine] adapter connected', { provider: id });
      } catch (e) {
        adapter.lastError = String(e?.message || e);
        console.warn('[MarketStreamEngine] adapter connect failed', { provider: id, error: adapter.lastError });
      }
    }
  }

  // ── Subscription management ─────────────────────────────────────────────

  async subscribe(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) throw new Error('symbol required');
    if (this.subscriptions.has(sym)) return this.subscriptions.get(sym);

    const assetClass = this.assetClassifier.classify(sym);
    const providerId = this._resolveProvider(sym, assetClass);

    const adapter = this.adapters.get(providerId);
    if (adapter) {
      const credentials = credentialStore.get(providerId);
      try {
        await adapter.subscribe(sym, credentials);
      } catch (e) {
        this.failoverReasons.set(sym, `subscribe failed on ${providerId}: ${e?.message}`);
      }
    }

    const sub = { providerId, assetClass, subscribedAt: new Date().toISOString() };
    this.subscriptions.set(sym, sub);
    console.info('[MarketStreamEngine] subscribed', { symbol: sym, provider: providerId, assetClass });
    return sub;
  }

  async unsubscribe(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const sub = this.subscriptions.get(sym);
    if (!sub) return;

    const adapter = this.adapters.get(sub.providerId);
    if (adapter) {
      try { await adapter.unsubscribe(sym); } catch {}
    }
    this.subscriptions.delete(sym);
    this.failoverReasons.delete(sym);
    console.info('[MarketStreamEngine] unsubscribed', { symbol: sym });
  }

  // ── Provider resolution ─────────────────────────────────────────────────

  _resolveProvider(symbol, assetClass) {
    const activeProviders = new Set(feedManager.getActiveProviders().providerOrder);

    for (const candidateId of FAILOVER_PRIORITY) {
      if (!activeProviders.has(candidateId)) continue;
      const caps = getCapabilities(candidateId);
      if (caps.requiresGateway) continue;
      if (!this.assetClassifier.compatibleProviders(symbol, [candidateId]).length && !caps.demoOnly) continue;
      const credentials = credentialStore.get(candidateId);
      if (caps.requiresCredentials && !credentials?.apiKey) continue;
      const adapter = this.adapters.get(candidateId);
      if (!adapter || adapter.state === 'error') continue;
      return candidateId;
    }

    return 'fallback_demo';
  }

  // ── Failover ────────────────────────────────────────────────────────────

  async triggerFailover(symbol, reason) {
    const sym = String(symbol || '').toUpperCase();
    const current = this.subscriptions.get(sym);
    if (!current) return null;

    const currentIdx = FAILOVER_PRIORITY.indexOf(current.providerId);
    const assetClass = current.assetClass || this.assetClassifier.classify(sym);
    const activeProviders = new Set(feedManager.getActiveProviders().providerOrder);

    for (let i = currentIdx + 1; i < FAILOVER_PRIORITY.length; i++) {
      const candidateId = FAILOVER_PRIORITY[i];
      if (!activeProviders.has(candidateId)) continue;
      const caps = getCapabilities(candidateId);
      if (caps.requiresGateway) continue;
      if (!caps.demoOnly && !supportsAssetClass(candidateId, assetClass)) continue;
      const credentials = credentialStore.get(candidateId);
      if (caps.requiresCredentials && !credentials?.apiKey) continue;

      const adapter = this.adapters.get(candidateId);
      if (!adapter) continue;

      try {
        await adapter.subscribe(sym, credentials);
        const failoverNote = `failover from ${current.providerId} → ${candidateId}: ${reason}`;
        this.failoverReasons.set(sym, failoverNote);
        this.subscriptions.set(sym, { ...current, providerId: candidateId });
        console.warn('[MarketStreamEngine] failover', { symbol: sym, from: current.providerId, to: candidateId, reason });
        return candidateId;
      } catch {}
    }

    this.failoverReasons.set(sym, `all providers exhausted after ${current.providerId}: ${reason}`);
    return null;
  }

  // ── Stale detection ─────────────────────────────────────────────────────

  _runStaleCheck() {
    for (const [sym, sub] of this.subscriptions) {
      const adapter = this.adapters.get(sub.providerId);
      if (!adapter) continue;
      if (adapter.isStale()) {
        const reason = `stale: no tick from ${sub.providerId} for >${adapter.staleThresholdMs}ms`;
        console.warn('[MarketStreamEngine] stale', { symbol: sym, provider: sub.providerId });
        this.triggerFailover(sym, reason);
      }
    }
  }

  _heartbeat() {
    const activeProviders = feedManager.getActiveProviders().providerOrder;
    const anyLive = activeProviders.some((id) => {
      if (id === 'fallback_demo') return false;
      const adapter = this.adapters.get(id);
      return adapter?.lastTickAt && (Date.now() - adapter.lastTickAt) < HEARTBEAT_TIMEOUT_MS;
    });
    if (!anyLive && this.subscriptions.size > 0) {
      console.warn('[MarketStreamEngine] heartbeat: no live tick from any non-demo provider');
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  getDiagnostics() {
    const activeProviders = feedManager.getActiveProviders();
    const providerStates = {};

    for (const [id, adapter] of this.adapters) {
      const caps = getCapabilities(id);
      const credentials = credentialStore.get(id);
      const hasCredentials = Boolean(credentials?.apiKey);
      const canActivate = caps.requiresGateway ? false : (!caps.requiresCredentials || hasCredentials);

      providerStates[id] = {
        ...adapter.getState(),
        capabilities: caps,
        credentialsConfigured: hasCredentials,
        canActivate,
        activeInFeedManager: activeProviders.providers.includes(id),
        failoverPriorityIndex: FAILOVER_PRIORITY.indexOf(id),
      };
    }

    const activeFailoverProvider = FAILOVER_PRIORITY.find((id) => {
      const caps = getCapabilities(id);
      if (caps.requiresGateway || caps.demoOnly) return false;
      const creds = credentialStore.get(id);
      if (caps.requiresCredentials && !creds?.apiKey) return false;
      const adapter = this.adapters.get(id);
      return adapter?.state === 'connected';
    }) || 'fallback_demo';

    return {
      initialized: this._initialized,
      startedAt: this._startedAt,
      activeProviders: activeProviders.providers,
      providerOrder: activeProviders.providerOrder,
      activeProvider: activeProviders.providers[0] || null,
      activeFailoverProvider,
      failoverPriority: FAILOVER_PRIORITY,
      providers: providerStates,
      subscribedSymbols: Array.from(this.subscriptions.keys()),
      subscriptionCount: this.subscriptions.size,
      tickBuffer: this.tickBuffer.getStats(),
      timestamp: new Date().toISOString(),
    };
  }

  getSubscriptions() {
    const result = {};
    for (const [sym, sub] of this.subscriptions) {
      const adapter = this.adapters.get(sub.providerId);
      result[sym] = {
        ...sub,
        stale: adapter?.isStale() ?? null,
        lastTickAt: adapter?.lastTickAt ? new Date(adapter.lastTickAt).toISOString() : null,
        failoverReason: this.failoverReasons.get(sym) || null,
        adapterState: adapter?.state || 'unknown',
      };
    }
    return result;
  }

  getProviderHealth() {
    const health = {};
    for (const [id, adapter] of this.adapters) {
      const caps = getCapabilities(id);
      const credentials = credentialStore.get(id);
      const hasCredentials = Boolean(credentials?.apiKey);
      health[id] = {
        providerId: id,
        state: adapter.state,
        stale: adapter.isStale(),
        reconnectCount: adapter.reconnectCount,
        lastTickAt: adapter.lastTickAt ? new Date(adapter.lastTickAt).toISOString() : null,
        lastError: adapter.lastError,
        credentialsConfigured: hasCredentials,
        capabilities: caps,
        canActivate: caps.requiresGateway ? false : (!caps.requiresCredentials || hasCredentials),
        activeSubscriptions: Array.from(adapter.subscriptions),
        failoverPriorityIndex: FAILOVER_PRIORITY.indexOf(id),
      };
    }
    return health;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async shutdown() {
    if (this._staleCheckTimer) { clearInterval(this._staleCheckTimer); this._staleCheckTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    for (const adapter of this.adapters.values()) {
      try { await adapter.disconnect(); } catch {}
    }
    this.tickBuffer.destroy();
    this._initialized = false;
    console.info('[MarketStreamEngine] shutdown');
  }
}

export const marketStreamEngine = new MarketStreamEngine();
