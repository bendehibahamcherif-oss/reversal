import { Router } from 'express';
import { featureStore } from '../ai/featureStore.js';
import { outcomeLabeler } from '../ai/outcomeLabeler.js';
import { regimeEngine } from '../aiAnalytics/regimeEngine.js';
import { datasetAnalyticsEngine } from '../aiAnalytics/datasetAnalyticsEngine.js';

import { datasetBuilderService } from '../ai/datasets/datasetBuilderService.js';
import { datasetSplitService } from '../ai/datasets/datasetSplitService.js';
import { trainingPipelineService } from '../ai/training/trainingPipelineService.js';
import { modelRegistryService } from '../ai/registry/modelRegistryService.js';
import { inferenceService } from '../ai/inference/inferenceService.js';
import { psiEngine } from '../ai/drift/psiEngine.js';

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



aiRoutes.post('/ml/datasets/create', async (req,res)=>{
  try {
    const result=await datasetBuilderService.createDataset(req.body||{});
    if(!result.ok) return res.status(400).json({ok:false,errors:result.errors||['Dataset build failed'],warnings:result.warnings||[]});
    return res.json({ok:true,datasetId:result.datasetId,metadata:result.metadata,warnings:result.warnings||[]});
  } catch(err){ return res.status(500).json({ok:false,error:'Failed to create dataset',warnings:[String(err.message||err)]}); }
});

aiRoutes.get('/ml/datasets/:datasetId', async (req,res)=>{
  const dataset=datasetBuilderService.inspectDataset(req.params.datasetId);
  if(!dataset) return res.status(404).json({ok:false,error:'Dataset not found',warnings:[]});
  return res.json({ok:true,dataset,warnings:dataset.metadata?.warnings||[]});
});

aiRoutes.post('/ml/datasets/:datasetId/split', async (req,res)=>{
  const dataset=datasetBuilderService.getDatasetById(req.params.datasetId);
  if(!dataset) return res.status(404).json({ok:false,error:'Dataset not found',warnings:[]});
  const split=datasetSplitService.split(dataset,req.body||{});
  if(!split.ok) return res.status(400).json({ok:false,errors:split.errors||['Split failed'],warnings:split.warnings||[]});
  return res.json({ok:true,summary:split.summary,generatedAt:split.generatedAt,warnings:split.warnings||[]});
});

aiRoutes.post('/ml/training/start', async (req,res)=>{
  try {
    const result=await trainingPipelineService.startJob(req.body||{});
    return res.json({ok:true,jobId:result.jobId,status:result.status,warnings:result.warnings||[]});
  } catch(err){ return res.status(500).json({ok:false,error:'Failed to start training job',warnings:[String(err.message||err)]}); }
});

aiRoutes.get('/ml/training/status/:jobId', async (req,res)=>{
  const job=trainingPipelineService.getJobStatus(req.params.jobId);
  if(!job) return res.status(404).json({ok:false,error:'Training job not found',warnings:[]});
  return res.json({ok:true,job,warnings:job.warnings||[]});
});

aiRoutes.get('/ml/models', async (req,res)=>{
  const symbol = req.query?.symbol ? String(req.query.symbol).toUpperCase() : null;
  const models = modelRegistryService.list(symbol);
  return res.json({ok:true,models,warnings:models.length?[]:['No registered models found.']});
});
aiRoutes.get('/ml/models/:modelId', async (req,res)=>{ const model=modelRegistryService.get(req.params.modelId); if(!model) return res.status(404).json({ok:false,error:'Model not found',warnings:[]}); return res.json({ok:true,model,warnings:[]}); });

// ── Champion/challenger ────────────────────────────────────────────────────────

// GET /api/ai/ml/champion/:symbol — get current champion for a symbol
aiRoutes.get('/ml/champion/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const champion = modelRegistryService.getChampion(symbol);
  if (!champion) return res.status(404).json({ ok: false, error: 'No champion model for symbol', symbol, warnings: [] });
  return res.json({ ok: true, symbol, champion, warnings: [] });
});

// POST /api/ai/ml/models/:modelId/promote — promote model to champion
aiRoutes.post('/ml/models/:modelId/promote', (req, res) => {
  const result = modelRegistryService.promote(req.params.modelId);
  if (!result.ok) return res.status(404).json({ ok: false, error: result.error, warnings: [] });
  return res.json({ ok: true, ...result, warnings: [] });
});

// GET /api/ai/ml/compare/:modelId1/:modelId2 — side-by-side model comparison
aiRoutes.get('/ml/compare/:modelId1/:modelId2', (req, res) => {
  const comparison = modelRegistryService.compare(req.params.modelId1, req.params.modelId2);
  if (!comparison) return res.status(404).json({ ok: false, error: 'One or both models not found', warnings: [] });
  return res.json({ ok: true, comparison, warnings: [] });
});

// ── Live inference ─────────────────────────────────────────────────────────────

// POST /api/ai/ml/inference/:symbol — run live inference with champion model
aiRoutes.post('/ml/inference/:symbol', async (req, res) => {
  try {
    const symbol    = String(req.params.symbol || '').toUpperCase();
    const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
    const result    = await inferenceService.infer(symbol, timeframe);
    if (!result.ok) return res.status(422).json({ ok: false, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, warnings: [] });
  }
});

// GET /api/ai/ml/inference/:symbol — same but GET (uses cached result if fresh)
aiRoutes.get('/ml/inference/:symbol', async (req, res) => {
  try {
    const symbol    = String(req.params.symbol || '').toUpperCase();
    const timeframe = req.query?.timeframe || '1m';
    const result    = await inferenceService.infer(symbol, timeframe);
    if (!result.ok) return res.status(422).json({ ok: false, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, warnings: [] });
  }
});

// ── Feature importance ─────────────────────────────────────────────────────────

// GET /api/ai/ml/feature-importance/:modelId — feature importance from trained model
aiRoutes.get('/ml/feature-importance/:modelId', (req, res) => {
  const model = modelRegistryService.get(req.params.modelId);
  if (!model) return res.status(404).json({ ok: false, error: 'Model not found', warnings: [] });
  const importance = model.featureImportance || {};
  const ranked = Object.entries(importance)
    .map(([feature, score]) => ({ feature, score: Number(score) }))
    .sort((a, b) => b.score - a.score);
  return res.json({ ok: true, modelId: model.modelId, modelType: model.modelType, symbol: model.symbol, featureImportance: importance, ranked, warnings: ranked.length ? [] : ['No feature importance data available for this model.'] });
});

// ── Drift monitoring ───────────────────────────────────────────────────────────

// POST /api/ai/ml/drift/:modelId — compute PSI drift report
aiRoutes.post('/ml/drift/:modelId', async (req, res) => {
  try {
    const model = modelRegistryService.get(req.params.modelId);
    if (!model) return res.status(404).json({ ok: false, error: 'Model not found', warnings: [] });

    const symbol      = model.symbol;
    const timeframe   = model.timeframe || '1m';
    const featureNames = model.featureSet || [];
    if (!featureNames.length) return res.status(422).json({ ok: false, error: 'Model has no featureSet; retrain with Phase 9 engine.', warnings: [] });

    // Get recent feature records as "current" distribution
    const recentLimit = Number(req.body?.recentLimit) || 50;
    const recentRecs  = (await featureStore.getFeatureRecords(symbol, recentLimit))
      .filter((r) => r.timeframe === timeframe);

    if (!recentRecs.length) {
      return res.status(422).json({ ok: false, error: 'No recent feature records for drift computation.', warnings: [] });
    }

    // Build feature column vectors
    const trainDatasetId = model.datasetVersion;
    const trainDataset   = datasetBuilderService.getDatasetById(trainDatasetId);

    // Training baseline: from persisted dataset if available, else synthesize from registry metadata
    let baselineRows = trainDataset?.rows || [];
    if (!baselineRows.length) {
      // Fallback: use older feature records beyond the recent window
      const allRecs = await featureStore.getFeatureRecords(symbol, 500);
      baselineRows = allRecs
        .filter((r) => r.timeframe === timeframe)
        .slice(recentLimit); // everything older than "recent"
    }

    if (!baselineRows.length) {
      return res.status(422).json({ ok: false, error: 'No baseline data for drift comparison. Train or collect more data.', warnings: [] });
    }

    const baselineVectors = psiEngine.extractFeatureVectors(baselineRows, featureNames);
    const currentVectors  = psiEngine.extractFeatureVectors(recentRecs, featureNames);

    const report = psiEngine.computeDrift(model.modelId, baselineVectors, currentVectors, featureNames);
    return res.json({ ok: true, modelId: model.modelId, symbol, ...report, warnings: report.warnings || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, warnings: [] });
  }
});

// GET /api/ai/ml/drift/:modelId — last drift report for a model
aiRoutes.get('/ml/drift/:modelId', (req, res) => {
  const model = modelRegistryService.get(req.params.modelId);
  if (!model) return res.status(404).json({ ok: false, error: 'Model not found', warnings: [] });
  const report = psiEngine.getLatestDrift(req.params.modelId);
  if (!report) return res.json({ ok: true, modelId: req.params.modelId, report: null, warnings: ['No drift report computed yet. POST to /ml/drift/:modelId to compute.'] });
  return res.json({ ok: true, modelId: req.params.modelId, report, warnings: [] });
});

export default aiRoutes;
