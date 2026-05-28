import { nowIso } from '../mlCore.js';

class DatasetSplitService {
  split(dataset, { trainRatio = 0.7, validationRatio = 0.15, testRatio = 0.15 } = {}) {
    const warnings = [];
    if (!dataset?.rows?.length) return { ok: false, errors: ['Dataset rows are required.'], warnings };
    const sum = Number(trainRatio) + Number(validationRatio) + Number(testRatio);
    if (Math.abs(sum - 1) > 0.0001) return { ok: false, errors: ['Split ratios must sum to 1.0.'], warnings };
    const rows = [...dataset.rows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const seen = new Set();
    for (const row of rows) { if (seen.has(row.timestamp)) return { ok: false, errors: [`Duplicate timestamp found: ${row.timestamp}`], warnings }; seen.add(row.timestamp); }
    const n = rows.length;
    const trainEnd = Math.floor(n * trainRatio);
    const valEnd = trainEnd + Math.floor(n * validationRatio);
    const train = rows.slice(0, trainEnd);
    const validation = rows.slice(trainEnd, valEnd);
    const test = rows.slice(valEnd);
    if (!train.length || !validation.length || !test.length) warnings.push('One or more splits are very small; metrics may be unstable.');
    const trainMax = train[train.length - 1]?.timestamp;
    const valMin = validation[0]?.timestamp;
    const valMax = validation[validation.length - 1]?.timestamp;
    const testMin = test[0]?.timestamp;
    if ((trainMax && valMin && Date.parse(trainMax) >= Date.parse(valMin)) || (valMax && testMin && Date.parse(valMax) >= Date.parse(testMin))) {
      return { ok: false, errors: ['Overlapping split boundary detected.'], warnings };
    }
    const leakage = [...train, ...validation].some((r) => Date.parse(r.timestamp) >= Date.parse(testMin || r.timestamp));
    if (leakage) return { ok: false, errors: ['Future label leakage check failed.'], warnings };
    return { ok: true, generatedAt: nowIso(), warnings, summary: { total: n, train: train.length, validation: validation.length, test: test.length }, splits: { train, validation, test } };
  }
}

export const datasetSplitService = new DatasetSplitService();
