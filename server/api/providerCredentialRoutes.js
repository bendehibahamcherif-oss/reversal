import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const providerCredentialRoutes = Router();

const API_KEY_PATTERN = /^[A-Za-z0-9_\-]{8,128}$/;

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function sanitizeCredentialMeta(meta = {}) {
  return {
    provider: asString(meta.provider),
    configured: Boolean(meta.configured),
    apiKey: asString(meta.apiKey),
    enabled: Boolean(meta.enabled),
    createdAt: meta.createdAt || null,
    updatedAt: meta.updatedAt || null
  };
}

function buildValidationError(message, details = []) {
  return { success: false, error: { code: 'validation_error', message, details } };
}

providerCredentialRoutes.post('/credentials', (req, res) => {
  try {
    const providerId = asString(req.body?.provider).toLowerCase();
    const apiKey = asString(req.body?.apiKey);
    const apiSecret = asString(req.body?.apiSecret);
    const enabled = req.body?.enabled;

    if (!providerId) {
      return res.status(400).json(buildValidationError('Provider is required.', [{ field: 'provider', message: 'Please provide a provider id.' }]));
    }

    const provider = feedManager.getProvider(providerId);
    if (!provider) {
      return res.status(404).json({ success: false, error: { code: 'provider_not_found', message: `Provider '${providerId}' does not exist.` } });
    }

    if (!apiKey) {
      return res.status(400).json(buildValidationError('API key is required.', [{ field: 'apiKey', message: 'apiKey cannot be empty.' }]));
    }

    if (!API_KEY_PATTERN.test(apiKey)) {
      return res.status(400).json(buildValidationError('API key format is invalid.', [{ field: 'apiKey', message: 'Use 8-128 chars: letters, numbers, underscore, hyphen.' }]));
    }

    const saved = feedManager.setProviderCredentials(providerId, { apiKey, apiSecret, enabled });
    console.info('[providerCredentials] save', JSON.stringify({ provider: providerId, configured: Boolean(saved?.configured), enabled: Boolean(saved?.enabled) }));
    const runtime = feedManager.validateProviderRuntime(providerId);

    return res.status(201).json({
      success: true,
      message: `Credentials saved for provider '${providerId}'.`,
      credential: sanitizeCredentialMeta(saved),
      runtime
    });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_save_failed', message: 'Unable to save provider credentials.' } });
  }
});

providerCredentialRoutes.get('/credentials', (_req, res) => {
  try {
    const credentials = feedManager.listProviderCredentials().map(sanitizeCredentialMeta);
    return res.json({ success: true, credentials, count: credentials.length });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_list_failed', message: 'Unable to load provider credentials.' } });
  }
});

providerCredentialRoutes.delete('/credentials/:provider', (req, res) => {
  try {
    const providerId = asString(req.params?.provider).toLowerCase();
    if (!providerId) {
      return res.status(400).json(buildValidationError('Provider is required.', [{ field: 'provider', message: 'Please provide a provider id.' }]));
    }
    const provider = feedManager.getProvider(providerId);
    if (!provider) {
      return res.status(404).json({ success: false, error: { code: 'provider_not_found', message: `Provider '${providerId}' does not exist.` } });
    }
    const cleared = feedManager.clearProviderCredentials(providerId);
    console.info('[providerCredentials] clear', JSON.stringify({ provider: providerId }));
    return res.json({ success: true, message: `Credentials cleared for provider '${providerId}'.`, credential: sanitizeCredentialMeta(cleared) });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_delete_failed', message: 'Unable to delete provider credentials.' } });
  }
});

providerCredentialRoutes.get('/status', (_req, res) => {
  const providers = feedManager.listProviders().map((provider) => ({
    provider: String(provider.provider || provider.id || ''),
    configured: Boolean(provider.configured),
    enabled: Boolean(provider.enabled),
    active: Boolean(provider.active),
    usable: Boolean(provider.usable),
    credentialLoaded: Boolean(provider.credentialLoaded),
    providerInitialized: Boolean(provider.providerInitialized),
    lastError: provider.lastError || null,
    status: String(provider.status || 'unknown'),
  }));
  res.json({ success: true, providers });
});

providerCredentialRoutes.get('/active', (_req, res) => {
  res.json({ success: true, ...feedManager.getActiveProviders() });
});

providerCredentialRoutes.get('/runtime', (_req, res) => {
  const providers = feedManager.listProviders().map((provider) => ({
    provider: String(provider.provider || provider.id || ''),
    configured: Boolean(provider.configured),
    enabled: Boolean(provider.enabled),
    active: Boolean(provider.active),
    usable: Boolean(provider.usable),
    credentialLoaded: Boolean(provider.credentialLoaded),
    providerInitialized: Boolean(provider.providerInitialized),
    lastError: provider.lastError || null,
    status: String(provider.status || 'unknown'),
    runtime: provider.runtime,
  }));
  res.json({ success: true, providers });
});

export default providerCredentialRoutes;
