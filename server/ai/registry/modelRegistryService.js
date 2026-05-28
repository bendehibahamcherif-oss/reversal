import fs from 'node:fs';
import path from 'node:path';
import { createId, nowIso } from '../mlCore.js';

const REGISTRY_FILE = path.resolve(process.cwd(), 'server/ai/registry/modelRegistry.json');

class ModelRegistryService {
  read() { try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); } catch { return []; } }
  write(items) { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(items, null, 2)); }
  register(input = {}) {
    const items = this.read();
    const model = { modelId: input.modelId || createId('model'), modelType: input.modelType || 'unknown', symbol: input.symbol || 'UNKNOWN', datasetVersion: input.datasetVersion || 'n/a', featureVersion: input.featureVersion || 'n/a', trainingTimestamp: input.trainingTimestamp || nowIso(), metrics: input.metrics || {}, status: input.status || 'registered', notes: input.notes || '' };
    items.unshift(model); this.write(items); return model;
  }
  list() { return this.read(); }
  get(modelId) { return this.read().find((m) => m.modelId === modelId) || null; }
}

export const modelRegistryService = new ModelRegistryService();
