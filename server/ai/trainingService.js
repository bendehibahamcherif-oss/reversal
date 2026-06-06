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

export function getPythonBin() {
  return process.env.ML_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';
}

// Backward-compatible named export. Runtime probes and spawns call getPythonBin()
// so /api/ml/dependencies and /api/ml/train always use the same binary.
const PYTHON_BIN = getPythonBin();

const DEPENDENCY_MODULES = {
  numpy: 'numpy',
  pandas: 'pandas',
  sklearn: 'sklearn',
  joblib: 'joblib',
  pyarrow: 'pyarrow',
  xgboost: 'xgboost',
};
const REQUIRED_DEPENDENCIES = ['numpy', 'pandas', 'sklearn', 'joblib'];

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
  const modelType = body.modelType === undefined || body.modelType === null ? 'XGBoost' : String(body.modelType);
  return { ok: errors.length === 0, errors, symbol, timeframe, horizon, promote, datasetPath, datasetId, modelType };
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

function dependencyProbeScript() {
  return `
import sys, json, importlib.util as iu
pkgs = ${JSON.stringify(DEPENDENCY_MODULES)}
core = ${JSON.stringify(REQUIRED_DEPENDENCIES)}
deps = {label: iu.find_spec(mod) is not None for label, mod in pkgs.items()}
missing = [m for m in core if not deps.get(m)]
print(json.dumps({"ok": len(missing)==0, "status": "ready" if len(missing)==0 else "python_dependency_missing", "python": {"available": True, "version": sys.version.split()[0]}, "dependencies": deps, "missing": missing, "installCommand": "pip install -r requirements-ml.txt" if missing else None}))
`.trim();
}

export async function probePythonDependencies({ pythonBin = getPythonBin(), timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(pythonBin, ['-c', dependencyProbeScript()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      resolve({
        ok: false,
        status: 'python_unavailable',
        message: `Cannot start Python (${pythonBin}): ${err.message}`,
        python: { available: false, version: null },
        dependencies: Object.fromEntries(Object.keys(DEPENDENCY_MODULES).map((name) => [name, false])),
        missing: REQUIRED_DEPENDENCIES,
        pythonBin,
        spawnError: err.message,
      });
    });
    proc.on('close', () => {
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1]);
        resolve({ ...parsed, pythonBin });
      } catch {
        resolve({
          ok: false,
          status: 'python_dependency_missing',
          message: 'Python check failed.',
          python: { available: true, version: null },
          dependencies: Object.fromEntries(Object.keys(DEPENDENCY_MODULES).map((name) => [name, false])),
          missing: REQUIRED_DEPENDENCIES,
          pythonBin,
          stdout,
          stderr: stderr.slice(0, 500),
        });
      }
    });
  });
}

function trainPythonDiagnostics(depCheck) {
  return {
    bin: depCheck.pythonBin || getPythonBin(),
    version: depCheck.python?.version ?? null,
    dependencyStatus: depCheck.status || (depCheck.ok ? 'ready' : 'python_dependency_missing'),
    missing: Array.isArray(depCheck.missing) ? depCheck.missing : [],
  };
}

function withFailureDiagnostics(result, request, depCheck) {
  return sanitizeJson({
    ...result,
    datasetId: request.datasetId || result.datasetId,
    python: trainPythonDiagnostics(depCheck),
  });
}

class TrainingService {
  constructor({ dependencyChecker = probePythonDependencies, spawnTraining = null } = {}) {
    this.dependencyChecker = dependencyChecker;
    this.spawnTraining = spawnTraining;
  }

  locateDataset(datasetPath) {
    return resolveDatasetPath(datasetPath);
  }

  async runTrainingProcess(args) {
    if (this.spawnTraining) return this.spawnTraining(args);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const proc = spawn(getPythonBin(), args, {
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
  }

  async train(body = {}) {
    const request = validateTrainRequest(body);
    if (!request.ok) {
      return { ok: false, status: 'invalid_request', message: request.errors.join(' '), errors: request.errors, datasetId: request.datasetId || undefined };
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
      // If a datasetId was provided but mlRoutes didn't resolve it (safety net),
      // return dataset_not_found rather than the generic dataset_missing.
      if (body.datasetId) {
        return {
          ok: false,
          status: 'dataset_not_found',
          message: `Historical dataset '${body.datasetId}' was selected but could not be resolved to a training file. Re-download the dataset.`,
          datasetId: body.datasetId,
        };
      }
      return {
        ok: false,
        status: 'dataset_missing',
        message: 'No dataset snapshot found. Generate or upload a dataset before training.',
        expectedPaths: EXPECTED_DATASET_PATHS,
      };
    }

    // Verify file is non-empty (redundant with locateDataset, but explicit)
    const datasetStat = (() => { try { return fs.statSync(dataset); } catch { return null; } })();
    if (!datasetStat || datasetStat.size === 0) {
      return { ok: false, status: 'dataset_file_empty', message: 'Dataset file exists but is empty.', path: dataset, datasetId: request.datasetId || undefined };
    }

    const depCheck = await this.dependencyChecker({ pythonBin: getPythonBin() });
    if (!depCheck.ok) {
      if (depCheck.status === 'python_unavailable' || depCheck.spawnError) {
        return withFailureDiagnostics({
          ok: false,
          status: 'training_failed',
          message: `Failed to start Python: ${depCheck.spawnError || depCheck.message}. Ensure python3 is installed.`,
        }, request, depCheck);
      }
      return withFailureDiagnostics({
        ok: false,
        status: 'python_dependency_missing',
        message: 'Python ML dependencies are missing. Install requirements-ml.txt before training.',
        missing: Array.isArray(depCheck.missing) ? depCheck.missing : [],
        installCommand: 'pip install -r requirements-ml.txt',
      }, request, depCheck);
    }

    const args = [
      TRAIN_SCRIPT,
      '--dataset', dataset,
      '--symbol', request.symbol,
      '--timeframe', request.timeframe,
      '--horizon', String(request.horizon),
      '--model-type', request.modelType,
      '--output-dir', ARTIFACTS_DIR,
      '--cost-bps', String(body.costBps ?? 0),
      '--tau-up', String(body.tauUp ?? 0.001),
      '--tau-dn', String(body.tauDn ?? body.tauDown ?? 0.001),
    ];

    const result = await this.runTrainingProcess(args);

    if (!result.ok) {
      const failure = result.status === 'python_dependency_missing'
        ? {
            ...result,
            status: 'training_failed',
            message: 'Training pipeline reported missing dependencies after /api/ml/dependencies was ready.',
            details: { ...(result.details || {}), pipelineStatus: result.status, pipelineMissing: result.missing || [] },
          }
        : result;
      return withFailureDiagnostics(failure, request, depCheck);
    }

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
      modelType: result.modelType || request.modelType,
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
export { TrainingService, validateTrainRequest, PYTHON_BIN, REQUIRED_DEPENDENCIES, DEPENDENCY_MODULES };
