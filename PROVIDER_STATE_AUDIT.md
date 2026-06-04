# Provider State Audit

## Sources of Truth

| State | Source actuelle | Consommateur UI | Problème | Correction |
|-------|----------------|-----------------|----------|------------|
| `activeProviders` | `feedManager.activeProviders[]` (in-memory) + `activeProviderStore` (file) | `feedStore.activeProviders`, `marketRuntimeStore.activeProviders` | Deux stores frontend maintiennent chacun `activeProviders` indépendamment — divergence possible après save | Fix: un seul store (feedStore) doit être source de vérité; re-fetch après save |
| `providerOrder` | `feedManager.activeProviders[]` (même tableau) | `feedStore.providerOrder`, `marketRuntimeStore.providerOrder` | Même duplication que activeProviders | Fix: même que ci-dessus |
| `enabledByProvider` | `feedManager.enabledByProvider{}` (in-memory) + `activeProviderStore` (file) | `feedStore.enabledByProvider` | Pas synchronisé si `marketRuntimeStore` merge ses propres providers | Fix: `POST /providers/active` doit confirmer l'état persisté |
| `credentialStatus` | `credentialStore` (in-memory Map + `providerCredentials.json`) | `feedStore.credentialsStatus` | `POST /feeds/providers/:id/credentials` retournait `{ credentials }` sans `credentialsStatus` → frontend defaultait à `'missing_credentials'` | **CORRIGÉ**: réponse inclut maintenant `credentialsStatus` |
| `providerHealth` | `marketStreamEngine.getProviderHealth()` (adapters) + `feedManager.validateProviderRuntime()` (credentials) | Provider Diagnostics UI | `GET /api/providers/health` intercepté par `marketStreamRoutes` qui utilise `marketStreamEngine` (données de connexion stream) au lieu de `feedManager` (données credentials) | **CORRIGÉ**: `canonicalProviders` ajouté à la réponse |
| `fallback_demo` forcé | `feedManager.resolveActiveState()` ajoutait fallback_demo inconditionnellement | Provider selector UI | Utilisateur ne pouvait pas décocher fallback_demo — il était réajouté même si `enabledByProvider.fallback_demo = false` | **CORRIGÉ**: bloc forcé supprimé; fallback_demo seulement ajouté si aucun provider viable |
| Provider ID casing | `credentialStore` normalise en lowercase; `providerRegistry` utilise camelCase (`'alphaVantage'`) | Credential save UI | `providerCredentialRoutes` lowercasait le `providerId` avant lookup → `providerRegistry.get('alphavantage')` = `undefined` → 404 | **CORRIGÉ**: lookup case-insensitive via `_getProviderByAnyCase()` |

## Root Causes Identifiés

### 1. `fallback_demo` ne peut pas être désactivé
**Fichier**: `server/feeds/feedManager.js` — `resolveActiveState()` lignes 72-75 (ancien)

Le bloc forçait `fallback_demo` en fin de liste même quand l'utilisateur l'avait explicitement désactivé. La logique correcte est déjà présente à la ligne précédente (fallback absolu si aucun provider viable).

**Fix appliqué**: bloc supprimé.

### 2. Credential save affiche `missing_credentials` après succès
**Fichier**: `server/api/feedRoutes.js` — `POST /providers/:provider/credentials`

La réponse retournait `{ success: true, credentials: meta }` sans le champ `credentialsStatus`. Le store frontend fait `result?.credentialsStatus || 'missing_credentials'` → defaultait à `'missing_credentials'`.

**Fix appliqué**: `credentialsStatus: meta.configured ? 'configured' : 'missing_credentials'` ajouté.

### 3. Provider Diagnostics montre un état contradictoire
**Fichier**: `server/api/marketStreamRoutes.js` — `GET /providers/health`

Monté sur `/api` avant `providerCredentialRoutes` (monté sur `/api/providers`), ce handler interceptait `GET /api/providers/health`. Il retournait les données d'état des adapters MarketStream (connexions WebSocket), pas les données de credentials de `feedManager`.

**Fix appliqué**: `canonicalProviders[]` ajouté à la réponse — liste complète avec `credentialStatus`, `runtimeStatus`, `capabilities`.

### 4. `POST /api/providers/credentials` retourne 404 pour `alphaVantage`
**Fichier**: `server/api/providerCredentialRoutes.js`

Le handler lowercasait le `providerId` (`alphaVantage` → `alphavantage`) puis appelait `feedManager.getProvider('alphavantage')` → `providerRegistry.get('alphavantage')` → `undefined` (la registry utilise `'alphaVantage'` comme clé).

**Fix appliqué**: 
- `providerCredentialRoutes`: `.toLowerCase()` retiré de la normalisation initiale
- `feedManager._getProviderByAnyCase(id)`: lookup case-insensitive ajouté, utilisé dans `getProvider`, `setProviderCredentials`, `clearProviderCredentials`, `validateProviderRuntime`

## État après corrections

| Endpoint | Avant | Après |
|----------|-------|-------|
| `POST /feeds/providers/:id/credentials` | `{ success, credentials }` | `{ success, credentials, credentialsStatus }` |
| `DELETE /feeds/providers/:id/credentials` | `{ success, credentials }` | `{ success, credentials, credentialsStatus: 'missing_credentials' }` |
| `POST /providers/credentials` | 404 pour `alphaVantage` | 201 avec `credentialsStatus` |
| `DELETE /providers/credentials/:id` | 404 pour `alphaVantage` | 200 avec `credentialsStatus: 'missing_credentials'` |
| `GET /providers/health` | `{ providers: streamHealth }` | `{ providers: streamHealth, canonicalProviders: [...] }` |
| `GET /feeds/providers/active` | `{ success, providers, providerOrder, ... }` | `+ ok, activeProviders (alias)` |
| `POST /feeds/providers/active` | force fallback_demo | respecte choix utilisateur |
| `GET /feeds/status` | `warnings: []` hardcodé | warnings réels des providers |

## Remaining (Phase 5 — Frontend)

- `feedStore.saveCredentials`: utiliser `result.credentials.configured` (ou `result.credentialsStatus`) au lieu de `result?.credentialsStatus \|\| 'missing_credentials'`
- `marketRuntimeStore`: supprimer `activeProviders`/`providerOrder` dupliqués — seul `feedStore` doit les posséder
- `LiveDataWorkspace.parsedProviders`: ne pas merger `selectedProviders` (UI) avec `activeProviders` (backend) pour l'affichage — utiliser uniquement `activeProviders` post-save
- Après `saveCredentials` ou `saveActiveProviders`: re-fetch `GET /api/providers/health` et `GET /api/feeds/providers/active` pour confirmer état backend
