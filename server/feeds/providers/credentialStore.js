import fs from 'node:fs';
import path from 'node:path';

const credentialMap = new Map();
const STORE_DIR = path.resolve(process.cwd(), 'server', 'persistence', 'secure');
const STORE_PATH = path.join(STORE_DIR, 'providerCredentials.json');

function toStringOrEmpty(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeProvider(providerId) {
  return String(providerId || '').trim().toLowerCase();
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(4, value.length - 7))}${value.slice(-4)}`;
}

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    for (const record of records) {
      const provider = normalizeProvider(record?.provider);
      if (!provider) continue;
      const apiKey = toStringOrEmpty(record?.apiKey);
      if (!apiKey) continue;
      credentialMap.set(provider, {
        provider,
        apiKey,
        apiSecret: toStringOrEmpty(record?.apiSecret),
        enabled: Boolean(record?.enabled),
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
  const provider = normalizeProvider(providerId);
  const apiKey = toStringOrEmpty(input?.apiKey);
  const apiSecret = toStringOrEmpty(input?.apiSecret);
  const enabled = input?.enabled === undefined ? true : Boolean(input.enabled);
  const now = new Date().toISOString();
  return {
    provider,
    apiKey,
    apiSecret,
    enabled,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
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
    const provider = normalizeProvider(providerId);
    if (!provider) return null;
    const existing = credentialMap.get(provider);
    const normalized = toProviderCredentials(provider, credentials, existing);
    if (!normalized.apiKey) {
      credentialMap.delete(provider);
    } else {
      credentialMap.set(provider, normalized);
    }
    persistStore();
    return this.getMeta(provider);
  },
  get(providerId) {
    const record = credentialMap.get(normalizeProvider(providerId));
    return toRuntimeCredentials(record);
  },
  clear(providerId) {
    const provider = normalizeProvider(providerId);
    credentialMap.delete(provider);
    persistStore();
    return this.getMeta(provider);
  },
  getMeta(providerId) {
    const provider = normalizeProvider(providerId);
    const record = credentialMap.get(provider);
    if (!record) {
      return { provider, configured: false, enabled: false, apiKey: '', createdAt: null, updatedAt: null };
    }
    return {
      provider,
      configured: Boolean(record.apiKey),
      enabled: Boolean(record.enabled),
      apiKey: maskSecret(record.apiKey),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  },
  listMeta() {
    return Array.from(credentialMap.keys()).map((provider) => this.getMeta(provider));
  }
};
