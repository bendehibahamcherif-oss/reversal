import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createId, nowIso } from '../mlCore.js';

const DATA_DIR      = process.env.DATA_DIR || '/var/data';
const REGISTRY_FILE = path.join(DATA_DIR, 'modelRegistry.json');
const MODELS_DIR    = path.join(DATA_DIR, 'models');

function read() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); } catch { return []; }
}

function write(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(items, null, 2));
  } catch (e) { console.warn('[modelRegistry] write failed:', e?.message); }
}

function datasetHash(rows, featureNames) {
  const payload = JSON.stringify({
    count: rows.length,
    features: [...featureNames].sort(),
    first: rows[0]?.timestamp,
    last:  rows[rows.length - 1]?.timestamp,
  });
  return 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

class ModelRegistryService {
  // ── Model artifact storage ─────────────────────────────────────────────────

  saveArtifact(modelId, modelB64) {
    try {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      const artifactPath = path.join(MODELS_DIR, `${modelId}.pkl.b64`);
      fs.writeFileSync(artifactPath, modelB64, 'utf-8');
      return artifactPath;
    } catch (e) {
      console.warn('[modelRegistry] artifact save failed:', e?.message);
      return null;
    }
  }

  loadArtifact(modelId) {
    try {
      const p = path.join(MODELS_DIR, `${modelId}.pkl.b64`);
      return fs.readFileSync(p, 'utf-8');
    } catch { return null; }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  register(input = {}) {
    const items = read();
    const modelId = input.modelId || createId('model');

    const model = {
      modelId,
      modelType:         input.modelType         || 'unknown',
      symbol:            String(input.symbol      || 'UNKNOWN').toUpperCase(),
      timeframe:         input.timeframe          || '1m',
      horizon:           Number(input.horizon)    || 5,
      featureSet:        Array.isArray(input.featureSet)    ? input.featureSet    : [],
      datasetHash:       input.datasetHash        || 'n/a',
      datasetVersion:    input.datasetVersion     || 'n/a',
      featureVersion:    input.featureVersion     || 'n/a',
      trainSamples:      Number(input.trainSamples)  || 0,
      valSamples:        Number(input.valSamples)    || 0,
      testSamples:       Number(input.testSamples)   || 0,
      trainingTimestamp: input.trainingTimestamp  || nowIso(),
      metrics:           input.metrics            || {},
      featureImportance: input.featureImportance  || {},
      baselineAccuracy:  input.baselineAccuracy   || null,
      beatsBaseline:     input.beatsBaseline      || false,
      artifactPath:      input.artifactPath       || null,
      labelMap:          input.labelMap           || {},
      invLabelMap:       input.invLabelMap        || {},
      status:            input.status             || 'registered',
      championSince:     input.status === 'champion' ? nowIso() : null,
      notes:             input.notes              || '',
    };

    items.unshift(model);
    write(items);
    return model;
  }

  // ── Champion/Challenger ────────────────────────────────────────────────────

  promote(modelId) {
    const items = read();
    const target = items.find((m) => m.modelId === modelId);
    if (!target) return { ok: false, error: 'Model not found' };

    const prev = items.find((m) => m.symbol === target.symbol && m.status === 'champion');

    for (const m of items) {
      if (m.symbol === target.symbol && m.status === 'champion') {
        m.status = 'archived';
        m.archivedAt = nowIso();
      }
    }

    target.status = 'champion';
    target.championSince = nowIso();
    write(items);
    return { ok: true, model: target, previousChampion: prev?.modelId || null };
  }

  getChampion(symbol) {
    return read().find((m) => m.symbol === String(symbol || '').toUpperCase() && m.status === 'champion') || null;
  }

  compare(modelId1, modelId2) {
    const items = read();
    const m1 = items.find((m) => m.modelId === modelId1);
    const m2 = items.find((m) => m.modelId === modelId2);
    if (!m1 || !m2) return null;

    const keys = new Set([...Object.keys(m1.metrics || {}), ...Object.keys(m2.metrics || {})]);
    const metricDiff = {};
    for (const k of keys) {
      metricDiff[k] = { model1: m1.metrics?.[k] ?? null, model2: m2.metrics?.[k] ?? null };
    }

    return {
      model1: { modelId: m1.modelId, modelType: m1.modelType, status: m1.status, trainingTimestamp: m1.trainingTimestamp, metrics: m1.metrics, featureImportance: m1.featureImportance },
      model2: { modelId: m2.modelId, modelType: m2.modelType, status: m2.status, trainingTimestamp: m2.trainingTimestamp, metrics: m2.metrics, featureImportance: m2.featureImportance },
      metricDiff,
      recommendation: (() => {
        const acc1 = m1.metrics?.test_accuracy ?? 0;
        const acc2 = m2.metrics?.test_accuracy ?? 0;
        if (acc1 > acc2) return `${modelId1} has higher test accuracy (${(acc1*100).toFixed(1)}% vs ${(acc2*100).toFixed(1)}%)`;
        if (acc2 > acc1) return `${modelId2} has higher test accuracy (${(acc2*100).toFixed(1)}% vs ${(acc1*100).toFixed(1)}%)`;
        return 'Models have equal test accuracy';
      })(),
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  list(symbol) {
    const items = read();
    return symbol ? items.filter((m) => m.symbol === String(symbol).toUpperCase()) : items;
  }

  get(modelId) {
    return read().find((m) => m.modelId === modelId) || null;
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  computeDatasetHash(rows, featureNames) {
    return datasetHash(rows, featureNames);
  }
}

export const modelRegistryService = new ModelRegistryService();
