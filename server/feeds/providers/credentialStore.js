import fs from 'node:fs';
import path from 'node:path';

const credentialMap = new Map();
const STORE_DIR = path.resolve(process.cwd(), 'server', 'persistence', 'secure');
const STORE_PATH = path.join(STORE_DIR, 'providerCredentials.json');

const ENV_CREDENTIALS = {
  polygon: ['POLYGON_API_KEY', 'POLYGON_KEY'],
  alphaVantage: ['ALPHA_VANTAGE_API_KEY', 'ALPHAVANTAGE_API_KEY', 'ALPHA_VANTAGE_KEY'],
  twelvedata: ['TWELVEDATA_API_KEY', 'TWELVE_DATA_API_KEY'],
  ibkr: ['IBKR_GATEWAY_URL', 'IBKR_SESSION_ID'],
};

function toStringOrEmpty(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeProvider(providerId) {
  return String(providerId || '').trim();
}

function normalizeProviderKey(providerId) {
  const raw = normalizeProvider(providerId);
  const lower = raw.toLowerCase();
  if (lower === 'alphavantage' || lower === 'alpha_vantage' || lower === 'alpha-vantage') return 'alphaVantage';
  if (lower === 'twelve_data' || lower === 'twelve-data') return 'twelvedata';
  return lower;
}

function maskSecret(value = '') {
  const secret = String(value || '');
  if (!secret) return null;
  if (secret.length <= 4) return '*'.repeat(secret.length);
  return `${'*'.repeat(Math.max(4, secret.length - 4))}${secret.slice(-4)}`;
}

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function getEnvApiKey(providerId) {
  const provider = normalizeProviderKey(providerId);
  const names = ENV_CREDENTIALS[provider] || [];
  if (provider === 'ibkr') {
    const gatewayUrl = toStringOrEmpty(process.env.IBKR_GATEWAY_URL);
    const sessionId = toStringOrEmpty(process.env.IBKR_SESSION_ID);
    return { apiKey: gatewayUrl, gatewayUrl, sessionId };
  }
  for (const name of names) {
    const value = toStringOrEmpty(process.env[name]);
    if (value) return { apiKey: value };
  }
  return {};
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    for (const record of records) {
      const provider = normalizeProviderKey(record?.provider);
      if (!provider) continue;
      const apiKey = toStringOrEmpty(record?.apiKey);
      if (!apiKey) continue;
      credentialMap.set(provider, {
        provider,
        apiKey,
        apiSecret: toStringOrEmpty(record?.apiSecret),
        enabled: record?.enabled === undefined ? true : Boolean(record.enabled),
        createdAt: toStringOrEmpty(record?.createdAt) || new Date().toISOString(),
        updatedAt: toStringOrEmpty(record?.updatedAt) || new Date().toISOString()
      });
    }
    console.info('[credentialStore] loaded', JSON.stringify({ providers: credentialMap.size }));
  } catch {
    console.warn('[credentialStore] load_failed');
  }
}

function persistStore() {
  try {
    ensureDir();
    const records = Array.from(credentialMap.values());
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, records }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, STORE_PATH);
    console.info('[credentialStore] persisted', JSON.stringify({ providers: records.length }));
  } catch {
    console.warn('[credentialStore] persist_failed');
  }
}

function toProviderCredentials(providerId, input = {}, existing = null) {
  const provider = normalizeProviderKey(providerId);
  const apiKey = toStringOrEmpty(input?.apiKey);
  const apiSecret = toStringOrEmpty(input?.apiSecret);
  const enabled = input?.enabled === undefined ? true : Boolean(input.enabled);
  const now = new Date().toISOString();
  return { provider, apiKey, apiSecret, enabled, createdAt: existing?.createdAt || now, updatedAt: now };
}

function toRuntimeCredentials(record = null) {
  if (!record || !record.enabled) return {};
  const runtime = {};
  if (record.apiKey) runtime.apiKey = record.apiKey;
  if (record.apiSecret) runtime.apiSecret = record.apiSecret;
  return runtime;
}

loadStore();

export const credentialStore = {
  set(providerId, credentials = {}) {
    const provider = normalizeProviderKey(providerId);
    if (!provider) return null;
    const existing = credentialMap.get(provider);
    const normalized = toProviderCredentials(provider, credentials, existing);
    if (!normalized.apiKey) credentialMap.delete(provider);
    else credentialMap.set(provider, normalized);
    persistStore();
    return this.getMeta(provider);
  },
  get(providerId) {
    const provider = normalizeProviderKey(providerId);
    const backend = toRuntimeCredentials(credentialMap.get(provider));
    if (backend.apiKey || backend.gatewayUrl) return backend;
    return getEnvApiKey(provider);
  },
  clear(providerId) {
    const provider = normalizeProviderKey(providerId);
    credentialMap.delete(provider);
    persistStore();
    return this.getMeta(provider);
  },
  getMeta(providerId) {
    const provider = normalizeProviderKey(providerId);
    const record = credentialMap.get(provider);
    if (record?.apiKey && record.enabled) {
      const masked = maskSecret(record.apiKey);
      return { provider, configured: true, source: 'backend', masked, apiKey: masked, apiKeyMasked: masked, maskedFields: [`apiKey:${masked}`], enabled: true, createdAt: record.createdAt, updatedAt: record.updatedAt };
    }
    const envCredentials = getEnvApiKey(provider);
    if (envCredentials.apiKey) {
      const masked = maskSecret(envCredentials.apiKey);
      return { provider, configured: true, source: 'env', masked, apiKey: masked, apiKeyMasked: masked, maskedFields: [`apiKey:${masked}`], enabled: true, createdAt: null, updatedAt: null };
    }
    return { provider, configured: false, source: 'none', masked: null, apiKey: '', apiKeyMasked: '', maskedFields: [], enabled: false, createdAt: null, updatedAt: null };
  },
  listMeta(providerIds = []) {
    const ids = Array.isArray(providerIds) && providerIds.length ? providerIds : Array.from(new Set([...Object.keys(ENV_CREDENTIALS), ...credentialMap.keys()]));
    return ids.map((provider) => this.getMeta(provider));
  },
  _resetForTests() {
    credentialMap.clear();
    persistStore();
  }
};
