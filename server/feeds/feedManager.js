import { createFeedStatus, createNormalizedCandle, createNormalizedOrderBook, createNormalizedTick } from './models.js';
import { getCandlesWithMeta } from '../persistence/historicalStore.js';
import { providerRegistry } from './providers/providerRegistry.js';
import { credentialStore } from './providers/credentialStore.js';

function seededUnit(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

class FeedManager {
  constructor() {
    this.statusBySource = new Map(); this.latestTicks = new Map(); this.latestCandles = new Map(); this.latestOrderBooks = new Map();
    this.activeProviders = ['fallback_demo']; this.activeSymbols = [];
    this.rebuildProviderStatuses();
  }
  rebuildProviderStatuses() {
    for (const provider of providerRegistry.list()) {
      const registryStatus = providerRegistry.getStatus(provider.id);
      const existing = this.statusBySource.get(provider.id) || createFeedStatus({ source: provider.id });
      this.statusBySource.set(provider.id, createFeedStatus({
        ...existing,
        source: provider.id,
        status: registryStatus.status,
        connected: registryStatus.connected,
        warnings: registryStatus.warnings || existing.warnings || []
      }));
    }
  }
  listProviders() {
    return providerRegistry.list().map((p) => ({ id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...credentialStore.getMeta(p.id), status: providerRegistry.getStatus(p.id).status, connected: providerRegistry.getStatus(p.id).connected, warnings: providerRegistry.getStatus(p.id).warnings || [] }));
  }
  getProvider(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const ps = providerRegistry.getStatus(providerId); return { id: p.id, name: p.name, type: p.type, requiresCredentials: p.requiresCredentials, supportsTicks: p.supportsTicks, supportsCandles: p.supportsCandles, supportsOrderBook: p.supportsOrderBook, ...credentialStore.getMeta(providerId), status: ps.status, connected: ps.connected, warnings: ps.warnings || [] }; }
  setProviderCredentials(providerId, credentials) { const p = providerRegistry.get(providerId); if (!p) return null; credentialStore.set(providerId, credentials); this.rebuildProviderStatuses(); return credentialStore.getMeta(providerId); }
  clearProviderCredentials(providerId) { const p = providerRegistry.get(providerId); if (!p) return null; const meta = credentialStore.clear(providerId); this.rebuildProviderStatuses(); return meta; }
  setActiveProviders({ providers = [], symbols = [] } = {}) { const selected = Array.isArray(providers) ? providers.filter((id) => providerRegistry.get(id)) : []; this.activeProviders = selected.length ? selected : ['fallback_demo']; this.activeSymbols = Array.isArray(symbols) ? symbols.map((s) => String(s).toUpperCase()) : []; this.rebuildProviderStatuses(); return { providers: this.activeProviders, symbols: this.activeSymbols }; }
  getActiveProviders() { return { providers: this.activeProviders, symbols: this.activeSymbols }; }

  startFeed(source='fallback_demo', symbols=[]) { const s = this.setActiveProviders({ providers:[String(source||'fallback_demo')], symbols }); return this.getFeedStatusBySource(s.providers[0]); }
  stopFeed(source='fallback_demo') { const current=this.getFeedStatusBySource(source); const next=createFeedStatus({...current,status:current.source==='fallback_demo'?'idle_demo':'stopped',connected:false}); this.statusBySource.set(next.source,next); return next; }
  getFeedStatus() { this.rebuildProviderStatuses(); return Array.from(this.statusBySource.values()); }
  getFeedStatusBySource(source='fallback_demo'){ return this.statusBySource.get(String(source)) || createFeedStatus({ source, status:'missing', connected:false, warnings:['Feed source has not been initialized.'] }); }
  ingestTick(tick){ const n=createNormalizedTick(tick); this.latestTicks.set(n.symbol,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }
  ingestCandle(c){ const n=createNormalizedCandle(c); this.latestCandles.set(`${n.symbol}:${n.timeframe}`,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }
  ingestOrderBook(b){ const n=createNormalizedOrderBook(b); this.latestOrderBooks.set(n.symbol,n); this.bumpStatus(n.source,n.symbol,n.timestamp); return n; }

  getLatestTick(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const from = this.latestTicks.get(sym);
    if (!from) return null;
    return this.activeProviders.includes(from.source) ? from : null;
  }
  getLatestCandle(symbol,timeframe='1m'){ const key=`${String(symbol||'').toUpperCase()}:${timeframe}`; const cached=this.latestCandles.get(key); if(cached) return cached; const fromStore=getCandlesWithMeta(symbol,timeframe); const candles=fromStore?.candles||[]; if(!candles.length) return null; const last=candles[candles.length-1]; return createNormalizedCandle({symbol,timeframe,open:last.o,high:last.h,low:last.l,close:last.c,volume:last.v,source:fromStore.source||'fallback_demo',timestamp:last.t}); }
  getLatestOrderBook(symbol){ return this.latestOrderBooks.get(String(symbol||'').toUpperCase()) || null; }
  generateDemoTick(symbol){ const normalized=String(symbol||'SPY').toUpperCase(); const base=500+seededUnit(normalized.length*97)*50; const price=Number(base.toFixed(4)); return this.ingestTick({symbol:normalized,price,bid:Number((price-0.01).toFixed(4)),ask:Number((price+0.01).toFixed(4)),volume:1000,source:'fallback_demo',sequence:Date.now()%1_000_000}); }
  generateDemoCandle(symbol,timeframe='1m'){ const tick=this.generateDemoTick(symbol); const open=Number((tick.price*0.999).toFixed(4)); const close=tick.price; return this.ingestCandle({symbol:tick.symbol,timeframe,open,high:Math.max(open,close),low:Math.min(open,close),close,volume:10_000,source:'fallback_demo'}); }
  generateDemoOrderBook(symbol){ const tick=this.generateDemoTick(symbol); const bids=[[Number((tick.price-0.01).toFixed(4)),200],[Number((tick.price-0.02).toFixed(4)),350]]; const asks=[[Number((tick.price+0.01).toFixed(4)),180],[Number((tick.price+0.02).toFixed(4)),300]]; return this.ingestOrderBook({symbol:tick.symbol,bids,asks,spread:Number((asks[0][0]-bids[0][0]).toFixed(4)),imbalance:0.53,source:'fallback_demo'}); }
  bumpStatus(source,symbol,timestamp){ const current=this.getFeedStatusBySource(source); const symbols=new Set(current.symbols||[]); if(symbol) symbols.add(symbol); const isDemo=source==='fallback_demo'; this.statusBySource.set(source,createFeedStatus({...current,source,status:isDemo?'idle_demo':(current.status||'connected'),connected:isDemo?false:Boolean(current.connected),symbols:Array.from(symbols),lastMessageAt:timestamp,warnings:isDemo?['Demo fallback source only. Not a live feed.']:current.warnings})); }
}

export const feedManager = new FeedManager();
