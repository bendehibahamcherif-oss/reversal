import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { modelRegistry, ARTIFACTS_DIR } from './modelRegistry.js';
import { getDataset } from '../historical/historicalDataService.js';
import { sanitizeJson } from '../historical/jsonSafety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TRAIN_SCRIPT = path.join(__dirname, 'train_pipeline.py');
const DEFAULT_TIMEOUT_MS = Number(process.env.ML_TRAIN_TIMEOUT_MS || 10 * 60 * 1000);

export const EXPECTED_DATASET_PATHS = [
  path.join(__dirname, 'data', 'features_snapshot.parquet'),
  path.join(__dirname, 'data', 'features_snapshot.csv'),
  path.join(REPO_ROOT, 'data', 'features_snapshot.parquet'),
  path.join(REPO_ROOT, 'data', 'features_snapshot.csv'),
  path.join(REPO_ROOT, 'datasets', 'features_snapshot.parquet'),
  path.join(REPO_ROOT, 'datasets', 'features_snapshot.csv'),
];

const SYMBOL_RE = /^[A-Z0-9./^=-]{1,20}$/;

function fileExistsNonEmpty(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function resolveDatasetPath(datasetPath) {
  if (datasetPath) {
    const resolved = path.resolve(REPO_ROOT, datasetPath);
    return fileExistsNonEmpty(resolved) ? resolved : null;
  }
  return EXPECTED_DATASET_PATHS.find(fileExistsNonEmpty) || null;
}

function validateTrainRequest(body = {}) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) errors.push('Request body must be a JSON object.');
  const symbol = String(body.symbol || '').toUpperCase().trim();
  if (!symbol) errors.push('symbol is required.');
  else if (!SYMBOL_RE.test(symbol)) errors.push('symbol contains unsupported characters.');
  const timeframe = String(body.timeframe || '1m').trim() || '1m';
  const horizon = body.horizon === undefined ? 20 : Number(body.horizon);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 1000) errors.push('horizon must be an integer between 1 and 1000.');
  const promote = body.promote === true;
  const datasetPath = body.datasetPath === undefined ? null : String(body.datasetPath);
  const datasetId = body.datasetId === undefined || body.datasetId === null ? null : String(body.datasetId);
  return { ok: errors.length === 0, errors, symbol, timeframe, horizon, promote, datasetPath, datasetId };
}

function parseLastJson(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

class TrainingService {
  locateDataset(datasetPath) {
    return resolveDatasetPath(datasetPath);
  }

  async train(body = {}) {
    const request = validateTrainRequest(body);
    if (!request.ok) {
      return { ok: false, status: 'invalid_request', message: request.errors.join(' '), errors: request.errors };
    }

    let historicalDataset = null;
    let dataset = null;
    if (request.datasetId) {
      historicalDataset = getDataset(request.datasetId);
      if (!historicalDataset) {
        return {
          ok: false,
          status: 'dataset_not_found',
          message: 'Historical dataset not found.',
          datasetId: request.datasetId,
        };
      }
      dataset = [historicalDataset.files?.csv, historicalDataset.files?.parquet, historicalDataset.files?.json, historicalDataset.filePath]
        .filter(Boolean)
        .find(fileExistsNonEmpty) || null;
      if (!dataset) {
        return {
          ok: false,
          status: 'dataset_file_missing',
          message: 'Historical dataset exists but no usable CSV/Parquet file was found.',
          datasetId: request.datasetId,
        };
      }
    } else {
      dataset = this.locateDataset(request.datasetPath);
    }
    if (!dataset) {
      return {
        ok: false,
        status: 'dataset_missing',
        message: 'No dataset snapshot found. Generate or upload a dataset before training.',
        expectedPaths: EXPECTED_DATASET_PATHS,
      };
    }

    const args = [
      TRAIN_SCRIPT,
      '--dataset', dataset,
      '--symbol', request.symbol,
      '--timeframe', request.timeframe,
      '--horizon', String(request.horizon),
      '--output-dir', ARTIFACTS_DIR,
      '--cost-bps', String(body.costBps ?? 0),
      '--tau-up', String(body.tauUp ?? 0.001),
      '--tau-dn', String(body.tauDn ?? body.tauDown ?? 0.001),
    ];

    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const proc = spawn(process.env.PYTHON_BIN || 'python3', args, {
        cwd: REPO_ROOT,
        env: { ...process.env, ML_ARTIFACTS_DIR: ARTIFACTS_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        resolve({ ok: false, status: 'training_failed', message: 'Training timed out.', details: { timeoutMs: DEFAULT_TIMEOUT_MS, stdout, stderr } });
      }, DEFAULT_TIMEOUT_MS);
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, status: 'training_failed', message: `Failed to start Python training: ${err.message}`, details: { stderr } });
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = parseLastJson(stdout);
        if (code !== 0) {
          resolve(parsed && parsed.ok === false ? parsed : { ok: false, status: 'training_failed', message: 'Training process exited non-zero.', details: { code, stdout, stderr } });
          return;
        }
        resolve(parsed || { ok: false, status: 'training_failed', message: 'Training returned no JSON result.', details: { stdout, stderr } });
      });
    });

    if (!result.ok) return sanitizeJson({ ...result, datasetId: request.datasetId || result.datasetId });

    const registered = modelRegistry.register({
      modelId: result.modelId,
      createdAt: result.createdAt,
      symbol: request.symbol,
      timeframe: request.timeframe,
      horizon: request.horizon,
      datasetHash: result.datasetHash || hashFile(dataset),
      featureSchemaHash: result.featureSchemaHash,
      featureSchema: result.featureSchema,
      metrics: result.metrics || {},
      artifactPath: result.artifactPath,
      artifactType: result.artifactType,
      status: 'candidate',
    });

    let promoted = false;
    let champion = null;
    if (request.promote) {
      const promotion = modelRegistry.promote(registered.modelId);
      promoted = promotion.ok;
      champion = promotion.model || null;
    }

    return {
      ok: true,
      status: 'trained',
      modelId: registered.modelId,
      artifactPath: registered.artifactPath,
      metrics: registered.metrics,
      promoted,
      champion,
      datasetId: request.datasetId || undefined,
    };
  }
}

export const trainingService = new TrainingService();
export { TrainingService, validateTrainRequest };
