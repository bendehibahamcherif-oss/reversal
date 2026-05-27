import { Router } from 'express';
import { featureStore } from '../ai/featureStore.js';
import { outcomeLabeler } from '../ai/outcomeLabeler.js';

const aiRoutes = Router();
aiRoutes.post('/features/save/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const timeframe=req.body?.timeframe||req.query?.timeframe||'1m'; const record = req.body?.record || await featureStore.buildFeatureRecord(symbol,timeframe); const saved=await featureStore.saveFeatureRecord({...record,symbol,timeframe}); return res.json({ok:true,symbol,timeframe,record:saved}); });
aiRoutes.get('/features/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const records=await featureStore.getFeatureRecords(symbol,req.query?.limit); return res.json({ok:true,symbol,records}); });
aiRoutes.get('/features/record/:id', async (req,res)=>{ const record=await featureStore.getFeatureRecordById(req.params.id); if(!record) return res.status(404).json({ok:false,error:'Feature record not found'}); return res.json({ok:true,record}); });
aiRoutes.delete('/features/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const result=await featureStore.clearFeatureRecords(symbol); return res.json({ok:true,symbol,deleted:result.deleted}); });
aiRoutes.post('/labels/record/:id', async (req,res)=>{ const horizon=req.body?.horizon||req.query?.horizon||20; const label=await outcomeLabeler.labelFeatureRecord(req.params.id,horizon); if(!label) return res.status(404).json({ok:false,error:'Feature record not found'}); return res.json({ok:true,label}); });
aiRoutes.post('/labels/symbol/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const horizon=req.body?.horizon||req.query?.horizon||20; const limit=req.body?.limit||req.query?.limit||25; const labels=await outcomeLabeler.labelSymbolHistory(symbol,horizon,limit); return res.json({ok:true,symbol,horizon,labels}); });
aiRoutes.get('/labels/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const labels=await outcomeLabeler.getOutcomeLabels(symbol,req.query?.limit); return res.json({ok:true,symbol,labels}); });
aiRoutes.delete('/labels/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const result=await outcomeLabeler.clearOutcomeLabels(symbol); return res.json({ok:true,symbol,deleted:result.deleted}); });
export default aiRoutes;
