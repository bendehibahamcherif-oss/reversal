import { createId, nowIso } from '../mlCore.js';
import { datasetBuilderService } from '../datasets/datasetBuilderService.js';
import { datasetSplitService } from '../datasets/datasetSplitService.js';
import { evaluationService } from '../validation/evaluationService.js';
import { modelRegistryService } from '../registry/modelRegistryService.js';

class BaseTrainer {
  constructor(type) { this.type = type; }
  async train(splitResult) { return { modelArtifactRef: `${this.type}-placeholder`, yTrue: splitResult.splits.test.map((r) => r.label), yPred: splitResult.splits.test.map(() => splitResult.splits.train[0]?.label || 'unknown') }; }
}

const trainers = { XGBoost: new BaseTrainer('XGBoost'), LightGBM: new BaseTrainer('LightGBM'), RandomForest: new BaseTrainer('RandomForest') };

class TrainingPipelineService {
  constructor() { this.jobs = new Map(); }
  async startJob({ symbol, timeframe = '1m', modelType = 'RandomForest', splitConfig, notes = '' } = {}) {
    const jobId = createId('trainJob');
    const job = { jobId, status: 'running', symbol, timeframe, modelType, startedAt: nowIso(), updatedAt: nowIso(), warnings: [], steps: [] };
    this.jobs.set(jobId, job);
    try {
      job.steps.push({ step: 'dataset.create', at: nowIso() });
      const datasetResult = await datasetBuilderService.createDataset({ symbol, timeframe });
      if (!datasetResult.ok) throw new Error(datasetResult.errors?.join('; ') || 'Dataset build failed');
      job.steps.push({ step: 'dataset.split', at: nowIso() });
      const split = datasetSplitService.split(datasetBuilderService.getDatasetById(datasetResult.datasetId), splitConfig);
      if (!split.ok) throw new Error(split.errors?.join('; ') || 'Split failed');
      job.steps.push({ step: 'training.execute', at: nowIso() });
      const trainer = trainers[modelType] || trainers.RandomForest;
      const trainResult = await trainer.train(split);
      job.steps.push({ step: 'evaluation.compute', at: nowIso() });
      const evaluation = evaluationService.evaluate(trainResult.yTrue, trainResult.yPred, split.splits.test.map((r) => r.regime));
      job.steps.push({ step: 'registry.register', at: nowIso() });
      const model = modelRegistryService.register({ modelType: trainer.type, symbol, datasetVersion: datasetResult.datasetId, featureVersion: 'phase6a-feature-store', metrics: evaluation.metrics || {}, status: 'trained', notes });
      Object.assign(job, { status: 'completed', completedAt: nowIso(), updatedAt: nowIso(), result: { dataset: datasetResult.metadata, split: split.summary, evaluation, model } });
    } catch (err) {
      Object.assign(job, { status: 'failed', updatedAt: nowIso(), error: 'Training pipeline failed.', warnings: [...(job.warnings || []), String(err.message || err)] });
    }
    return { ok: true, jobId, status: job.status, warnings: job.warnings };
  }
  getJobStatus(jobId) { const job = this.jobs.get(String(jobId || '')); if (!job) return null; return job; }
}

export const trainingPipelineService = new TrainingPipelineService();
