import { createId, nowIso } from '../mlCore.js';
import { datasetBuilderService } from '../datasets/datasetBuilderService.js';
import { datasetSplitService } from '../datasets/datasetSplitService.js';
import { evaluationService } from '../validation/evaluationService.js';
import { modelRegistryService } from '../registry/modelRegistryService.js';
import { trainModel } from '../mlBridge.js';

// ── Training pipeline ─────────────────────────────────────────────────────────
//
// Split methodology:
//   Dataset rows are sorted chronologically by timestamp BEFORE splitting.
//   trainRatio/validationRatio/testRatio control boundary positions.
//   No random shuffle — future bars never appear in training.
//   datasetSplitService.split() enforces non-overlapping, forward-only boundaries.
//
// Training bridge:
//   Node.js sends feature matrices + labels as JSON to a Python subprocess (train.py).
//   Python trains XGBoost, evaluates on val+test, serializes model to base64.
//   Node.js stores the base64 artifact on disk and records metadata in the registry.
//
// Validation:
//   noLookaheadVerified: true — enforced by chronological split
//   beatsBaseline flag — Python computes majority-class baseline on test set

class TrainingPipelineService {
  constructor() {
    this.jobs = new Map();
  }

  async startJob({ symbol, timeframe = '1m', modelType = 'XGBoost', horizon = 5, splitConfig, notes = '' } = {}) {
    const jobId = createId('trainJob');
    const job = {
      jobId, status: 'running', symbol, timeframe, modelType, horizon: Number(horizon) || 5,
      startedAt: nowIso(), updatedAt: nowIso(), warnings: [], steps: [],
    };
    this.jobs.set(jobId, job);

    // Run pipeline asynchronously — route returns immediately with jobId
    this._runPipeline(job, { symbol, timeframe, modelType, horizon: Number(horizon) || 5, splitConfig, notes })
      .catch((err) => {
        job.status    = 'failed';
        job.error     = 'Training pipeline failed.';
        job.updatedAt = nowIso();
        job.warnings.push(String(err?.message || err));
      });

    return { ok: true, jobId, status: 'running', warnings: [] };
  }

  async _runPipeline(job, { symbol, timeframe, modelType, horizon, splitConfig, notes }) {
    try {
      // ── Step 1: Build dataset ───────────────────────────────────────────────
      job.steps.push({ step: 'dataset.create', at: nowIso() });
      const datasetResult = await datasetBuilderService.createDataset({ symbol, timeframe });
      if (!datasetResult.ok) throw new Error(datasetResult.errors?.join('; ') || 'Dataset build failed');
      job.warnings.push(...(datasetResult.warnings || []));

      const dataset = datasetBuilderService.getDatasetById(datasetResult.datasetId);
      if (!dataset?.rows?.length) throw new Error('Dataset returned no rows');

      // ── Step 2: Chronological split ─────────────────────────────────────────
      job.steps.push({ step: 'dataset.split', at: nowIso() });
      const split = datasetSplitService.split(dataset, splitConfig);
      if (!split.ok) throw new Error(split.errors?.join('; ') || 'Split failed');
      job.warnings.push(...(split.warnings || []));

      if (!split.splits.train.length || !split.splits.test.length) {
        throw new Error('Insufficient data: empty train or test split');
      }

      // ── Step 3: Extract feature names in deterministic order ─────────────────
      const featureNames = [...new Set(split.splits.train.flatMap((r) => Object.keys(r.features || {})))].sort();
      if (!featureNames.length) throw new Error('No features found in training split');

      // ── Step 4: Compute dataset hash ─────────────────────────────────────────
      const dHash = modelRegistryService.computeDatasetHash(dataset.rows, featureNames);

      // ── Step 5: Train via Python bridge ──────────────────────────────────────
      job.steps.push({ step: 'training.execute', at: nowIso() });
      const trainResult = await trainModel({
        trainRows:    split.splits.train,
        valRows:      split.splits.validation,
        testRows:     split.splits.test,
        featureNames,
        modelType,
        horizon,
      });

      // ── Step 6: Evaluate ──────────────────────────────────────────────────
      job.steps.push({ step: 'evaluation.compute', at: nowIso() });
      // Use Python-computed metrics directly (test set)
      const testMetrics = trainResult.test_metrics || {};
      const valMetrics  = trainResult.val_metrics  || {};

      const evaluation = evaluationService.evaluate(
        trainResult.test_labels || split.splits.test.map((r) => r.label),
        // Python inversion for test labels: encode the predicted labels from test_metrics
        split.splits.test.map((r) => r.label), // placeholder yPred (we only have aggregate metrics from Python)
        split.splits.test.map((r) => r.regime),
      );

      // ── Step 7: Save model artifact ───────────────────────────────────────
      const modelId = createId('model');
      const artifactPath = modelRegistryService.saveArtifact(modelId, trainResult.model_b64);

      // ── Step 8: Register in registry ──────────────────────────────────────
      job.steps.push({ step: 'registry.register', at: nowIso() });
      const model = modelRegistryService.register({
        modelId,
        modelType,
        symbol,
        timeframe,
        horizon,
        featureSet:        featureNames,
        datasetHash:       dHash,
        datasetVersion:    datasetResult.datasetId,
        featureVersion:    'phase9-feature-store',
        trainSamples:      trainResult.train_samples,
        valSamples:        trainResult.val_samples,
        testSamples:       trainResult.test_samples,
        trainingTimestamp: nowIso(),
        metrics: {
          test_accuracy:   testMetrics.accuracy,
          test_f1:         testMetrics.f1,
          test_precision:  testMetrics.precision,
          test_recall:     testMetrics.recall,
          val_accuracy:    valMetrics.accuracy,
          val_f1:          valMetrics.f1,
        },
        featureImportance: trainResult.feature_importance || {},
        baselineAccuracy:  trainResult.baseline_accuracy,
        beatsBaseline:     trainResult.beats_baseline,
        artifactPath,
        labelMap:          trainResult.label_map    || {},
        invLabelMap:       trainResult.inv_label_map || {},
        status:            'trained',
        notes,
        noLookaheadVerified: true,
      });

      // Auto-promote as champion if no champion exists for this symbol
      const existing = modelRegistryService.getChampion(symbol);
      if (!existing) {
        modelRegistryService.promote(model.modelId);
        model.status = 'champion';
        job.warnings.push('Auto-promoted as champion (no prior champion for this symbol).');
      }

      Object.assign(job, {
        status:      'completed',
        completedAt: nowIso(),
        updatedAt:   nowIso(),
        result: {
          dataset: datasetResult.metadata,
          split:   split.summary,
          evaluation: {
            testMetrics,
            valMetrics,
            beatsBaseline:    trainResult.beats_baseline,
            baselineAccuracy: trainResult.baseline_accuracy,
            noLookaheadVerified: true,
          },
          model,
          featureImportance: trainResult.feature_importance || {},
        },
      });
    } catch (err) {
      Object.assign(job, {
        status:    'failed',
        updatedAt: nowIso(),
        error:     'Training pipeline failed.',
        warnings:  [...(job.warnings || []), String(err?.message || err)],
      });
    }
  }

  getJobStatus(jobId) {
    return this.jobs.get(String(jobId || '')) || null;
  }
}

export const trainingPipelineService = new TrainingPipelineService();
