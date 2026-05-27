import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { getCandles } from '../persistence/historicalStore.js';
import { OutcomeLabel } from './outcomeLabel.js';
import { featureStore } from './featureStore.js';

class OutcomeLabeler { constructor(){this.memory=[];} isMongoAvailable(){return mongoose.connection?.readyState===1;} labelFromReturn(ret){ if(ret>0.002) return 'positive'; if(ret<-0.002) return 'negative'; return 'neutral'; }
  build(feature,horizon){ const candles=getCandles(feature.symbol, feature.timeframe); const t=Date.parse(feature.timestamp); const idx=candles.findIndex((c)=>Number(c.t)>=t); const warns=[]; if(idx<0||idx+horizon>=candles.length){ warns.push('Not enough future candles to label this record at requested horizon.'); return { featureRecordId:feature.id,symbol:feature.symbol,timeframe:feature.timeframe,horizon,futureReturn:0,maxFavorableExcursion:0,maxAdverseExcursion:0,outcome:'unknown',label:'unknown',warnings:warns,createdAt:new Date().toISOString() }; }
    const entry=Number(candles[idx]?.c||0); const future=candles.slice(idx+1, idx+horizon+1); const end=Number(future[future.length-1]?.c||entry); const futureReturn=entry?((end-entry)/entry):0; const mfe=entry?Math.max(...future.map((c)=>(Number(c.h||entry)-entry)/entry)):0; const mae=entry?Math.min(...future.map((c)=>(Number(c.l||entry)-entry)/entry)):0; const outcome=this.labelFromReturn(futureReturn);
    return { featureRecordId:feature.id,symbol:feature.symbol,timeframe:feature.timeframe,horizon,futureReturn,maxFavorableExcursion:mfe,maxAdverseExcursion:mae,outcome,label:outcome,warnings:warns,createdAt:new Date().toISOString() };
  }
  async save(label){ if(this.isMongoAvailable()){ try{ const created=await OutcomeLabel.create(label); return created.toJSON(); }catch(err){ console.warn(`OutcomeLabeler Mongo save failed, using in-memory fallback: ${err.message}`);} } const local={id:randomUUID(),...label}; this.memory.unshift(local); return local; }
  async labelFeatureRecord(featureRecordId,horizon=20){ const feature=await featureStore.getFeatureRecordById(featureRecordId); if(!feature) return null; return this.save(this.build(feature,Math.max(1,Number(horizon)||20))); }
  async labelSymbolHistory(symbol,horizon=20,limit=25){ const records=await featureStore.getFeatureRecords(symbol,limit); const out=[]; for(const record of records){ const labeled=await this.labelFeatureRecord(record.id,horizon); if(labeled) out.push(labeled); } return out; }
  async getOutcomeLabels(symbol,limit=25){ const s=String(symbol||'').toUpperCase(); const l=Math.min(Math.max(Number(limit)||25,1),200); if(this.isMongoAvailable()){ try{ const items=await OutcomeLabel.find(s?{symbol:s}:{}).sort({createdAt:-1}).limit(l).lean(); return items.map((x)=>({id:String(x._id),...x})); } catch(err){ console.warn(`OutcomeLabeler Mongo read failed, using in-memory fallback: ${err.message}`);} } return this.memory.filter((x)=>!s||x.symbol===s).slice(0,l); }
  async clearOutcomeLabels(symbol){ const s=String(symbol||'').toUpperCase(); if(this.isMongoAvailable()){ try{ const r=await OutcomeLabel.deleteMany(s?{symbol:s}:{}); return {deleted:r.deletedCount||0}; } catch(err){ console.warn(`OutcomeLabeler Mongo clear failed, using in-memory fallback: ${err.message}`);} } const before=this.memory.length; this.memory=s?this.memory.filter((x)=>x.symbol!==s):[]; return {deleted:before-this.memory.length}; }
}
export const outcomeLabeler = new OutcomeLabeler();
