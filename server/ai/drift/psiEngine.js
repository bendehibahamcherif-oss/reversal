// ── Population Stability Index (PSI) Drift Monitor ───────────────────────────
//
// PSI measures distribution shift between a baseline population (training)
// and a current population (recent features).
//
// Formula: Σ (current_pct_i - expected_pct_i) × ln(current_pct_i / expected_pct_i)
// Interpretation:
//   PSI < 0.10  → no significant change
//   PSI 0.10-0.25 → moderate shift — monitor
//   PSI > 0.25  → significant shift — retrain

import { createId, nowIso } from '../mlCore.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../utils/storagePaths.js';

const DRIFT_FILE  = path.join(DATA_DIR, 'drift_reports.json');
const BINS        = 10;
const PSI_WARNING = 0.10;
const PSI_ALERT   = 0.25;

function readDriftStore() {
  try { return JSON.parse(fs.readFileSync(DRIFT_FILE, 'utf-8')); } catch { return []; }
}

function writeDriftStore(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DRIFT_FILE, JSON.stringify(items, null, 2));
  } catch (e) { console.warn('[psiEngine] write failed:', e?.message); }
}

// ── PSI for a single feature ──────────────────────────────────────────────────

function computeFeaturePSI(baseline, current, bins = BINS) {
  if (!baseline.length || !current.length) return 0;

  const allValues = [...baseline, ...current].filter(Number.isFinite);
  if (!allValues.length) return 0;

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  if (min === max) return 0;

  const width = (max - min) / bins;
  const baselineBins = new Array(bins).fill(0);
  const currentBins  = new Array(bins).fill(0);

  for (const v of baseline) {
    const i = Math.min(bins - 1, Math.floor((v - min) / width));
    baselineBins[i]++;
  }
  for (const v of current) {
    const i = Math.min(bins - 1, Math.floor((v - min) / width));
    currentBins[i]++;
  }

  const baselineTotal = baseline.length;
  const currentTotal  = current.length;
  const EPSILON = 1e-4;

  let psi = 0;
  for (let i = 0; i < bins; i++) {
    const exp = baselineBins[i] / baselineTotal + EPSILON;
    const obs = currentBins[i]  / currentTotal  + EPSILON;
    psi += (obs - exp) * Math.log(obs / exp);
  }

  return Number(psi.toFixed(6));
}

function interpretPSI(psi) {
  if (psi < PSI_WARNING)  return 'stable';
  if (psi < PSI_ALERT)    return 'moderate_shift';
  return 'significant_shift';
}

// ── Public API ────────────────────────────────────────────────────────────────

export const psiEngine = {
  // Compute PSI for all features in a model vs recent feature records.
  // `baselineFeatureVectors` comes from the training split (feature_name → [values]).
  // `currentFeatureVectors` comes from recent live feature records.
  computeDrift(modelId, baselineVectors, currentVectors, featureNames) {
    const features = {};
    let maxPsi = 0;
    let driftingFeatures = 0;

    for (const name of featureNames) {
      const baseline = (baselineVectors[name] || []).filter(Number.isFinite);
      const current  = (currentVectors[name]  || []).filter(Number.isFinite);
      const psi = computeFeaturePSI(baseline, current);
      const status = interpretPSI(psi);
      if (psi > maxPsi) maxPsi = psi;
      if (status !== 'stable') driftingFeatures++;
      features[name] = { psi: Number(psi.toFixed(6)), status, baselineSamples: baseline.length, currentSamples: current.length };
    }

    const overallStatus = interpretPSI(maxPsi);

    const report = {
      id:              createId('drift'),
      modelId,
      computedAt:      nowIso(),
      overallStatus,
      maxPsi:          Number(maxPsi.toFixed(6)),
      driftingFeatures,
      totalFeatures:   featureNames.length,
      features,
      warnings: overallStatus !== 'stable'
        ? [`${driftingFeatures}/${featureNames.length} features show distribution shift (max PSI: ${maxPsi.toFixed(3)})`]
        : [],
    };

    this.saveDriftReport(report);
    return report;
  },

  saveDriftReport(report) {
    const items = readDriftStore();
    items.unshift(report);
    if (items.length > 500) items.splice(500);
    writeDriftStore(items);
  },

  getLatestDrift(modelId) {
    const items = readDriftStore();
    return items.find((r) => r.modelId === modelId) || null;
  },

  getDriftHistory(modelId, limit = 20) {
    const items = readDriftStore();
    return items.filter((r) => r.modelId === modelId).slice(0, limit);
  },

  // Build feature column arrays from an array of feature record rows
  extractFeatureVectors(rows, featureNames) {
    const vectors = Object.fromEntries(featureNames.map((n) => [n, []]));
    for (const row of rows) {
      for (const name of featureNames) {
        const v = Number(row.features?.[name] ?? row[name]);
        if (Number.isFinite(v)) vectors[name].push(v);
      }
    }
    return vectors;
  },
};
