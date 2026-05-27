import { Router } from 'express';
import { featureStore } from '../ai/featureStore.js';
import { outcomeLabeler } from '../ai/outcomeLabeler.js';
import { regimeEngine } from '../aiAnalytics/regimeEngine.js';
import { datasetAnalyticsEngine } from '../aiAnalytics/datasetAnalyticsEngine.js';

const aiRoutes = Router();
aiRoutes.post('/features/save/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const timeframe=req.body?.timeframe||req.query?.timeframe||'1m'; const record = req.body?.record || await featureStore.buildFeatureRecord(symbol,timeframe); const saved=await featureStore.saveFeatureRecord({...record,symbol,timeframe}); return res.json({ok:true,symbol,timeframe,record:saved}); });
aiRoutes.get('/features/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const records=await featureStore.getFeatureRecords(symbol,req.query?.limit); return res.json({ok:true,symbol,records}); });
aiRoutes.get('/features/record/:id', async (req,res)=>{ const record=await featureStore.getFeatureRecordById(req.params.id); if(!record) return res.status(404).json({ok:false,error:'Feature record not found'}); return res.json({ok:true,record}); });
aiRoutes.delete('/features/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const result=await featureStore.clearFeatureRecords(symbol); return res.json({ok:true,symbol,deleted:result.deleted}); });
aiRoutes.post('/labels/record/:id', async (req,res)=>{ const horizon=req.body?.horizon||req.query?.horizon||20; const label=await outcomeLabeler.labelFeatureRecord(req.params.id,horizon); if(!label) return res.status(404).json({ok:false,error:'Feature record not found'}); return res.json({ok:true,label}); });
aiRoutes.post('/labels/symbol/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const horizon=req.body?.horizon||req.query?.horizon||20; const limit=req.body?.limit||req.query?.limit||25; const labels=await outcomeLabeler.labelSymbolHistory(symbol,horizon,limit); return res.json({ok:true,symbol,horizon,labels}); });
aiRoutes.get('/labels/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const labels=await outcomeLabeler.getOutcomeLabels(symbol,req.query?.limit); return res.json({ok:true,symbol,labels}); });
aiRoutes.delete('/labels/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const result=await outcomeLabeler.clearOutcomeLabels(symbol); return res.json({ok:true,symbol,deleted:result.deleted}); });

aiRoutes.post('/regime/detect/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const timeframe=req.body?.timeframe||req.query?.timeframe||'1m'; const regime=regimeEngine.detectCurrentRegime(symbol,timeframe); const saved=await regimeEngine.saveRegime(regime); return res.json({ok:true,symbol,timeframe,regime:saved}); });
aiRoutes.get('/regime/history/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const history=await regimeEngine.getRegimeHistory(symbol); return res.json({ok:true,symbol,history}); });
aiRoutes.delete('/regime/history/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const result=await regimeEngine.clearRegimeHistory(symbol); return res.json({ok:true,symbol,deleted:result.deleted}); });
aiRoutes.post('/dataset/analyze/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const timeframe=req.body?.timeframe||req.query?.timeframe||'1m'; const analytics=await datasetAnalyticsEngine.analyzeDataset(symbol,timeframe); return res.json({ok:true,symbol,timeframe,analytics}); });
aiRoutes.post('/dataset/feature-importance/:symbol', async (req,res)=>{ const symbol=String(req.params.symbol||'').toUpperCase(); const timeframe=req.body?.timeframe||req.query?.timeframe||'1m'; const features=(await featureStore.getFeatureRecords(symbol,200)).filter((x)=>x.timeframe===timeframe); const labels=(await outcomeLabeler.getOutcomeLabels(symbol,400)).filter((x)=>x.timeframe===timeframe); const featureStatistics=datasetAnalyticsEngine.analyzeFeatureImportance(features,labels); return res.json({ok:true,symbol,timeframe,featureStatistics}); });

// Phase 6B compatibility routes for frontend-friendly API shape.
aiRoutes.get('/regime/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const timeframe=req.query?.timeframe||'1m';
  const history=await regimeEngine.getRegimeHistory(symbol);
  const regime=history[0] || regimeEngine.detectCurrentRegime(symbol,timeframe);
  return res.json({ok:true,symbol,timeframe,regime,warnings:regime?.warnings||[]});
});

aiRoutes.post('/analytics/analyze/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const timeframe=req.body?.timeframe||req.query?.timeframe||'1m';
  const analytics=await datasetAnalyticsEngine.analyzeDataset(symbol,timeframe);
  return res.json({ok:true,symbol,timeframe,analytics,warnings:analytics?.warnings||[]});
});

aiRoutes.get('/analytics/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const timeframe=req.query?.timeframe||'';
  const latest=await datasetAnalyticsEngine.getLatestAnalytics(symbol,timeframe);
  if (latest) return res.json({ok:true,symbol,timeframe:latest.timeframe,analytics:latest,warnings:latest?.warnings||[]});
  return res.json({ok:true,symbol,timeframe:timeframe||'1m',analytics:{symbol,timeframe:timeframe||'1m',totalFeatureRecords:0,totalOutcomeLabels:0,labelDistribution:{},averageFutureReturn:0,averageMFE:0,averageMAE:0,winRate:0,expectancy:0,regimeBreakdown:{},featureStatistics:{},warnings:['No dataset analytics available for selected symbol/timeframe.']}});
});

aiRoutes.get('/analytics/features/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const timeframe=req.query?.timeframe||'1m';
  const features=(await featureStore.getFeatureRecords(symbol,200)).filter((x)=>x.timeframe===timeframe);
  const labels=(await outcomeLabeler.getOutcomeLabels(symbol,400)).filter((x)=>x.timeframe===timeframe);
  const featureStatistics=datasetAnalyticsEngine.analyzeFeatureImportance(features,labels);
  const warnings=[];
  if (!features.length) warnings.push('No feature records available for selected symbol/timeframe.');
  if (!labels.length) warnings.push('No outcome labels available; feature importance may be incomplete.');
  return res.json({ok:true,symbol,timeframe,featureStatistics,warnings});
});

aiRoutes.get('/analytics/regimes/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const history=await regimeEngine.getRegimeHistory(symbol);
  const breakdown=history.reduce((acc,item)=>{ const key=item?.regime||'unknown'; acc[key]=(acc[key]||0)+1; return acc; },{});
  return res.json({ok:true,symbol,regimeBreakdown:breakdown,history,warnings:history.length?[]:['No regime history available for selected symbol.']});
});

aiRoutes.delete('/analytics/:symbol', async (req,res)=>{
  const symbol=String(req.params.symbol||'').toUpperCase();
  const result=await datasetAnalyticsEngine.clearAnalytics(symbol);
  const warnings=result?.implemented?[]:['Analytics clear operation not implemented; returning safe success.'];
  return res.json({ok:true,symbol,deleted:result?.deleted||0,warnings});
});

export default aiRoutes;
