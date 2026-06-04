import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const providerCredentialRoutes = Router();

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function validationError(message, details = []) {
  return { success: false, error: { code: 'validation_error', message, details } };
}

function credentialsMap() {
  return Object.fromEntries(feedManager.listProviderCredentials().map((meta) => [meta.provider, {
    configured: Boolean(meta.configured),
    source: meta.source || (meta.configured ? 'backend' : 'none'),
    masked: meta.masked || null,
  }]));
}

function providerCredentialStatus(providerId) {
  const meta = feedManager.listProviderCredentials().find((credential) => credential.provider === providerId);
  if (!meta) return { configured: false, source: 'none', masked: null };
  return { configured: Boolean(meta.configured), source: meta.source || (meta.configured ? 'backend' : 'none'), masked: meta.masked || null };
}

function canonicalProvider(providerId) {
  return feedManager.getCanonicalProviderState().providers.find((provider) => provider.id === providerId) || null;
}

function saveCredential(req, res) {
  try {
    const providerId = asString(req.params?.providerId || req.params?.provider || req.body?.provider);
    const apiKey = asString(req.body?.apiKey);
    const apiSecret = asString(req.body?.apiSecret);
    const enabled = req.body?.enabled;

    if (!providerId) {
      return res.status(400).json(validationError('Provider is required.', [{ field: 'providerId', message: 'Please provide a provider id.' }]));
    }
    const provider = feedManager.getProvider(providerId);
    if (!provider) {
      return res.status(400).json({ success: false, error: { code: 'unknown_provider', message: `Unknown provider '${providerId}'.`, providerId } });
    }
    if (!apiKey) {
      return res.status(400).json(validationError('API key is required.', [{ field: 'apiKey', message: 'apiKey cannot be empty.' }]));
    }

    feedManager.setProviderCredentials(provider.id, { apiKey, apiSecret, enabled });
    const canonical = canonicalProvider(provider.id);
    const credential = providerCredentialStatus(provider.id);
    return res.status(200).json({ success: true, provider: canonical, credentials: credential });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_save_failed', message: 'Unable to save provider credentials.' } });
  }
}

providerCredentialRoutes.get('/credentials', (_req, res) => {
  try {
    return res.json({ success: true, credentials: credentialsMap() });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_list_failed', message: 'Unable to load provider credentials.' } });
  }
});

providerCredentialRoutes.post('/credentials', saveCredential);
providerCredentialRoutes.post('/credentials/:providerId', saveCredential);

providerCredentialRoutes.delete('/credentials/:providerId', (req, res) => {
  try {
    const providerId = asString(req.params?.providerId);
    const provider = feedManager.getProvider(providerId);
    if (!provider) {
      return res.status(400).json({ success: false, error: { code: 'unknown_provider', message: `Unknown provider '${providerId}'.`, providerId } });
    }
    feedManager.clearProviderCredentials(provider.id);
    return res.json({ success: true, provider: canonicalProvider(provider.id), credentials: providerCredentialStatus(provider.id), ...feedManager.getCanonicalProviderState() });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'credential_delete_failed', message: 'Unable to delete provider credentials.' } });
  }
});

providerCredentialRoutes.get('/status', (_req, res) => {
  res.json({ success: true, providers: feedManager.getCanonicalProviderState().providers });
});

providerCredentialRoutes.get('/active', (_req, res) => {
  const result = feedManager.getActiveProviders();
  res.json({ success: true, ...result, activeProviders: result.providers });
});

providerCredentialRoutes.post('/active', (req, res) => {
  const result = feedManager.saveActiveProviders(req.body || {});
  if (!result.ok) {
    return res.status(result.status || 400).json({ success: false, error: result.error });
  }
  return res.json({ success: true, activeProviders: result.activeProviders, providerOrder: result.providerOrder, providers: result.providers, source: result.source, warnings: result.warnings });
});

providerCredentialRoutes.get('/runtime', (_req, res) => {
  res.json({ success: true, providers: feedManager.listProviders().map((provider) => ({ id: provider.id, runtime: provider.runtime })) });
});

providerCredentialRoutes.get('/debug-state', (_req, res) => {
  const state = feedManager.getDebugState();
  res.json({ success: true, ...state });
});

providerCredentialRoutes.get('/health', (_req, res) => {
  res.json(feedManager.getCanonicalProviderState());
});

export default providerCredentialRoutes;
