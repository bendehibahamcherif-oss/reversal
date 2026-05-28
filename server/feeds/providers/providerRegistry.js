import { credentialStore } from './credentialStore.js';
import { polygonProvider } from './polygonProvider.js';
import { alphaVantageProvider } from './alphaVantageProvider.js';
import { ibkrProvider } from './ibkrProvider.js';
import { yahooProvider } from './yahooProvider.js';
import { twelveDataProvider } from './twelveDataProvider.js';

export const fallbackDemoProvider = { id:'fallback_demo', name:'Fallback Demo', type:'demo', requiresCredentials:false, supportsTicks:true, supportsCandles:true, supportsOrderBook:true, status(){ return { status:'idle_demo', connected:false, warnings:['Demo fallback source only. Not a live feed.'] }; }, validateCredentials(){ return { valid:true, warnings:[] }; }, start(){ return this.status(); }, stop(){ return {status:'stopped',connected:false}; }, getLatestTick(){ return null; }, getLatestCandle(){ return null; }, getLatestOrderBook(){ return null; } };
const providers=[yahooProvider, twelveDataProvider, polygonProvider, alphaVantageProvider, ibkrProvider, fallbackDemoProvider];
const providerMap = new Map(providers.map((p)=>[p.id,p]));
export const providerRegistry = { list(){ return providers; }, get(id){ return providerMap.get(String(id)); }, getStatus(id){ const p=this.get(id); if(!p) return { status:'missing', connected:false, warnings:['Provider not found.']}; return p.status(credentialStore.get(id)); } };
