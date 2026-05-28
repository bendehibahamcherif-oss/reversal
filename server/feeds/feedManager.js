import { createFeedStatus, createNormalizedCandle, createNormalizedOrderBook, createNormalizedTick } from './models.js';
import { getCandlesWithMeta } from '../persistence/historicalStore.js';
import { providerRegistry } from './providers/providerRegistry.js';
import { credentialStore } from './providers/credentialStore.js';

function seededUnit(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

const DEFAULT_DATA_PROVIDER = String(process.env.DEFAULT_DATA_PROVIDER || 'yahoo');
const DEFAULT_FALLBACK_PROVIDER = 'fallback_demo';

function resolveProviderPriority(inputProviders = []) {
  const requested = Array.isArray(inputProviders) ? inputProviders.map((id) => String(id)).filter(Boolean) : [];
  const deduped = new Set();
  const resolved = [];

  for (const providerId of [DEFAULT_DATA_PROVIDER, ...requested, DEFAULT_FALLBACK_PROVIDER]) {
    if (!providerRegistry.get(providerId) || deduped.has(providerId)) continue;
    deduped.add(providerId);
    resolved.push(providerId);
  }

  return resolved.length ? resolved : [DEFAULT_FALLBACK_PROVIDER];
}

class FeedManager {
  constructor() {
    this.statusBySource = new Map(); this.latestTicks = new Map(); this.latestCandles = new Map(); this.latestOrderBooks = new Map();
    this.activeProviders = resolveProviderPriority(); this.activeSymbols = [];
    this.rebuildProviderStatuses();
  }
  rebuildProviderStatuses() {
    for (const provider of providerRegistry.list()) {
      const s = providerRegistry.getStatus(provider.id);
      this.statusBySource.set(provider.id, createFeedStatus({ source: provider.id, ...s }));
    }
  }
  listProviders() {
    return providerRegistry.list().map((p) => ({ id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...credentialStore.getMeta(p.id), status: providerRegistry.getStatus(p.id).status, connected: providerRegistry.getStatus(p.id).connected, warnings: providerRegistry.getStatus(p.id).warnings || [] }));
  }
  getProvider(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const ps = providerRegistry.getStatus(providerId); return { id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...credentialStore.getMeta(providerId), status: ps.status, connected: ps.connected, warnings: ps.warnings || [] }; }
  setProviderCredentials(providerId, credentials) { const p = providerRegistry.get(providerId); if (!p) return null; credentialStore.set(providerId, credentials); this.rebuildProviderStatuses(); return credentialStore.getMeta(providerId); }
  clearProviderCredentials(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const meta = credentialStore.clear(providerId); this.rebuildProviderStatuses(); return meta; }
  setActiveProviders({ providers = [], symbols = [] } = {}) { this.activeProviders = resolveProviderPriority(providers); this.activeSymbols = Array.isArray(symbols) ? symbols.map((s) => String(s).toUpperCase()) : []; this.rebuildProviderStatuses(); return { providers: this.activeProviders, symbols: this.activeSymbols, defaultProvider: DEFAULT_DATA_PROVIDER }; }
  getActiveProviders() { return { providers: this.activeProviders, symbols: this.activeSymbols, defaultProvider: DEFAULT_DATA_PROVIDER }; }

  startFeed(source=DEFAULT_DATA_PROVIDER, symbols=[]) { const s = this.setActiveProviders({ providers:[String(source||DEFAULT_DATA_PROVIDER)], symbols }); return this.getFeedStatusBySource(s.providers[0]); }
  stopFeed(source=DEFAULT_DATA_PROVIDER) { const current=this.getFeedStatusBySource(source); const next=createFeedStatus({...current,status:current.source===DEFAULT_FALLBACK_PROVIDER?'idle_demo':'stopped',connected:false}); this.statusBySource.set(next.source,next); return next; }
  getFeedStatus() { this.rebuildProviderStatuses(); return Array.from(this.statusBySource.values()); }
  getFeedStatusBySource(source=DEFAULT_DATA_PROVIDER){ return this.statusBySource.get(String(source)) || createFeedStatus({ source, status:'missing', connected:false, warnings:['Feed source has not been initialized.'] }); }
  ingestTick(tick){ const n=createNormalizedTick(tick); this.latestTicks.set(n.symbol,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }
  ingestCandle(c){ const n=createNormalizedCandle(c); this.latestCandles.set(`${n.symbol}:${n.timeframe}`,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }
  ingestOrderBook(b){ const n=createNormalizedOrderBook(b); this.latestOrderBooks.set(n.symbol,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }

  async getLatestTick(symbol) { const sym=String(symbol||'').toUpperCase(); for (const source of this.activeProviders){ const from=this.latestTicks.get(sym); if (from && from.source===source) return from; const provider=providerRegistry.get(source); if(provider?.getLatestTick){ try { const live = await provider.getLatestTick(sym); if(live) return this.ingestTick(live); } catch { continue; } } } return this.latestTicks.get(sym) || null; }
  async getLatestCandle(symbol,timeframe='1m'){ const key=`${String(symbol||'').toUpperCase()}:${timeframe}`; const cached=this.latestCandles.get(key); if(cached) return cached; const sym=String(symbol||'').toUpperCase(); for (const source of this.activeProviders){ const provider=providerRegistry.get(source); if(provider?.getLatestCandle){ try { const live = await provider.getLatestCandle(sym,timeframe); if(live) return this.ingestCandle(live); } catch { continue; } } } const fromStore=getCandlesWithMeta(symbol,timeframe); const candles=fromStore?.candles||[]; if(!candles.length) return null; const last=candles[candles.length-1]; return createNormalizedCandle({symbol,timeframe,open:last.o,high:last.h,low:last.l,close:last.c,volume:last.v,source:fromStore.source||DEFAULT_FALLBACK_PROVIDER,timestamp:last.t}); }
  getLatestOrderBook(symbol){ return this.latestOrderBooks.get(String(symbol||'').toUpperCase()) || null; }
  generateDemoTick(symbol){ const normalized=String(symbol||'SPY').toUpperCase(); const base=500+seededUnit(normalized.length*97)*50; const price=Number(base.toFixed(4)); return this.ingestTick({symbol:normalized,price,bid:Number((price-0.01).toFixed(4)),ask:Number((price+0.01).toFixed(4)),volume:1000,source:'fallback_demo',sequence:Date.now()%1_000_000}); }
  generateDemoCandle(symbol,timeframe='1m'){ const tick=this.generateDemoTick(symbol); const open=Number((tick.price*0.999).toFixed(4)); const close=tick.price; return this.ingestCandle({symbol:tick.symbol,timeframe,open,high:Math.max(open,close),low:Math.min(open,close),close,volume:10_000,source:'fallback_demo'}); }
  generateDemoOrderBook(symbol){ const tick=this.generateDemoTick(symbol); const bids=[[Number((tick.price-0.01).toFixed(4)),200],[Number((tick.price-0.02).toFixed(4)),350]]; const asks=[[Number((tick.price+0.01).toFixed(4)),180],[Number((tick.price+0.02).toFixed(4)),300]]; return this.ingestOrderBook({symbol:tick.symbol,bids,asks,spread:Number((asks[0][0]-bids[0][0]).toFixed(4)),imbalance:0.53,source:'fallback_demo'}); }
  bumpStatus(source,symbol,timestamp){ const current=this.getFeedStatusBySource(source); const symbols=new Set(current.symbols||[]); if(symbol) symbols.add(symbol); const isDemo=source==='fallback_demo'; this.statusBySource.set(source,createFeedStatus({...current,source,status:isDemo?'idle_demo':(current.status||'connected'),connected:isDemo?false:Boolean(current.connected),symbols:Array.from(symbols),lastMessageAt:timestamp,warnings:isDemo?['Demo fallback source only. Not a live feed.']:current.warnings})); }
}

export const feedManager = new FeedManager();
