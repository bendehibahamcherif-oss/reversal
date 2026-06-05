import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ARTIFACTS_DIR = path.resolve(process.env.ML_ARTIFACTS_DIR || path.join(__dirname, 'artifacts'));
export const REGISTRY_PATH = path.join(ARTIFACTS_DIR, 'registry.json');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeRegistry(value) {
  if (Array.isArray(value)) return { models: value };
  if (value && typeof value === 'object' && Array.isArray(value.models)) return value;
  return { models: [] };
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class ModelRegistry {
  constructor({ artifactsDir = ARTIFACTS_DIR, registryPath = REGISTRY_PATH } = {}) {
    this.artifactsDir = artifactsDir;
    this.registryPath = registryPath;
  }

  read() {
    return normalizeRegistry(readJson(this.registryPath, { models: [] }));
  }

  write(registry) {
    writeJson(this.registryPath, normalizeRegistry(registry));
  }

  list() {
    return this.read().models;
  }

  get(modelId) {
    return this.list().find((m) => m.modelId === modelId) || null;
  }

  getChampion(symbol = null) {
    const models = this.list().filter((m) => m.status === 'champion');
    if (symbol) {
      const sym = String(symbol).toUpperCase();
      return models.find((m) => String(m.symbol || '').toUpperCase() === sym) || null;
    }
    return models[0] || null;
  }

  register(run) {
    if (!run?.modelId) throw new Error('modelId is required to register a model');
    const registry = this.read();
    const existingIdx = registry.models.findIndex((m) => m.modelId === run.modelId);
    const model = {
      createdAt: nowIso(),
      status: 'candidate',
      ...run,
      symbol: String(run.symbol || 'UNKNOWN').toUpperCase(),
      timeframe: run.timeframe || '1m',
      horizon: Number(run.horizon || 20),
      artifactPath: run.artifactPath ? path.resolve(run.artifactPath) : null,
    };
    if (!model.featureSchemaHash && model.featureSchema) {
      model.featureSchemaHash = hashObject(model.featureSchema);
    }
    if (existingIdx >= 0) registry.models[existingIdx] = { ...registry.models[existingIdx], ...model };
    else registry.models.unshift(model);
    this.write(registry);
    return model;
  }

  promote(modelId) {
    const registry = this.read();
    const target = registry.models.find((m) => m.modelId === modelId);
    if (!target) return { ok: false, status: 'model_not_found', message: `Model ${modelId} was not found.` };

    const previousChampion = registry.models.find((m) => m.status === 'champion') || null;
    for (const model of registry.models) {
      if (model.status === 'champion') {
        model.status = 'archived';
        model.archivedAt = nowIso();
      }
    }
    target.status = 'champion';
    target.championSince = nowIso();
    this.write(registry);
    return { ok: true, status: 'promoted', model: target, previousChampion: previousChampion?.modelId || null };
  }
}

export const modelRegistry = new ModelRegistry();
export { ModelRegistry, hashObject };
