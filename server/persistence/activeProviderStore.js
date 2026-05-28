import fs from 'fs';
import path from 'path';

const STORE_DIR = path.resolve(process.cwd(), 'server/persistence/secure');
const STORE_FILE = path.join(STORE_DIR, 'activeProviders.json');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

export const activeProviderStore = {
  load() {
    const payload = readJsonSafe(STORE_FILE);
    if (!payload || typeof payload !== 'object') return null;
    const state = {
      providers: Array.isArray(payload.providers) ? payload.providers : [],
      enabledByProvider: payload.enabledByProvider && typeof payload.enabledByProvider === 'object' ? payload.enabledByProvider : {},
      symbols: Array.isArray(payload.symbols) ? payload.symbols : [],
      updatedAt: payload.updatedAt || null,
    };
    console.info('[activeProviderStore] loaded', JSON.stringify({ providers: state.providers.length }));
    return state;
  },
  save(state) {
    ensureStoreDir();
    const payload = {
      providers: Array.isArray(state?.providers) ? state.providers : [],
      enabledByProvider: state?.enabledByProvider && typeof state.enabledByProvider === 'object' ? state.enabledByProvider : {},
      symbols: Array.isArray(state?.symbols) ? state.symbols : [],
      updatedAt: new Date().toISOString(),
    };
    const tmpFile = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpFile, STORE_FILE);
    console.info('[activeProviderStore] persisted', JSON.stringify({ providers: payload.providers.length }));
    return payload;
  },
};
