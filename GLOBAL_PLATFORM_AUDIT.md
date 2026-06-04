# Global Platform Audit

Date: 2026-06-04  
Backend: bendehibahamcherif-oss/reversal  
Frontend: bendehibahamcherif-oss/intraday-reversal-engine  

---

## Architecture Réelle

| Couche | Technologie | URL production |
|--------|-------------|----------------|
| Frontend | Vite + React + Zustand | intraday-reversal-engine.onrender.com |
| Backend API | Express (server.js, port 10000) | reversal.onrender.com |
| WebSocket | Socket.io (même serveur port 10000) | wss://reversal.onrender.com |
| Données marché | Yahoo Finance (gratuit, delayed), fallback_demo | — |
| ML | Python subprocess (train_pipeline.py) | local au backend |
| Persistance | Fichiers JSON (activeProviders, credentials, alerts) | /server/persistence/ |

**Note**: Le frontend a aussi un `server/index.cjs` (port 3001, ws) pour dev local. En production, le frontend appelle `VITE_API_BASE` → `reversal` backend.

---

## Bugs P0 identifiés et statut

| Bug | Cause racine | Statut | PR |
|-----|-------------|--------|-----|
| `d.toFixed is not a function` crash React | `GET /api/portfolio/drawdown` retournait `series` comme tableau d'objets; frontend `.map(d => d.toFixed(1))` → `undefined.toFixed()` | ✅ CORRIGÉ | #80 |
| Alpha Vantage "missing_credentials" après save | `POST /feeds/providers/:id/credentials` sans champ `credentialsStatus`; frontend defaultait à `'missing_credentials'` | ✅ CORRIGÉ | #82 |
| fallback_demo impossible à décocher | `feedManager.resolveActiveState()` ligne 72-75 forçait fallback_demo même si désactivé explicitement | ✅ CORRIGÉ | #82 |
| `POST /api/providers/credentials` → 404 pour `alphaVantage` | `.toLowerCase()` avant lookup case-sensitive dans `providerRegistry` | ✅ CORRIGÉ | #82 |
| WS: DISCONNECTED en production | wsClient fallback `ws://localhost:3001/ws` bloqué en HTTPS; URL non dérivée de VITE_API_BASE | ✅ CORRIGÉ (frontend) | — |
| "HTTP 404" affiché brut dans ML tabs | Routes `/api/ml/model-runs`, `/api/ml/predictions` non montées | ✅ CORRIGÉ | #78 (reversal) |

---

## Bugs P1 identifiés et statut

| Bug | Cause racine | Statut | PR |
|-----|-------------|--------|-----|
| `GET /api/ml/feature-importance` → 404 | Route absente du backend reversal | ✅ CORRIGÉ | #83 (ce PR) |
| `GET /api/ml/drift` → 404 | Route absente du backend reversal | ✅ CORRIGÉ | #83 (ce PR) |
| `GET /api/ml/signal/:symbol` → 404 | Route absente du backend reversal | ✅ CORRIGÉ | #83 (ce PR) |
| `GET /api/risk/*` → 404 | Aucun `riskRoutes.js` dans reversal | ✅ CORRIGÉ | #83 (ce PR) |
| Provider Diagnostics contradictoires | `GET /api/providers/health` intercepté par marketStreamRoutes (données stream) et non feedManager (credentials) | ✅ CORRIGÉ | #82 |
| `GET /api/portfolio/positions` retourne `{ success }` sans `ok` | `replyWithEngineResult` n'incluait pas `ok: true` | ✅ CORRIGÉ | #83 (ce PR) |

---

## Inventaire complet des routes — Backend

### `/api/portfolio` (portfolioRoutes.js)

| Method | Path | Réponse | Statut |
|--------|------|---------|--------|
| GET | /positions | `{ ok, success, positions[], mode }` | ✅ |
| GET | /summary | `{ ok, success, positionCount, exposure, totalPnL, ... }` | ✅ |
| GET | /drawdown | `{ ok, drawdown: { series[], currentDrawdown, maxDrawdown, maxDrawdownPct }, mode }` | ✅ |
| GET | /var | `{ ok, var, varPct, confidence, horizon, method, dataPoints }` | ✅ |
| GET | /pnl | `{ ok, pnl: { realized, unrealized, total, currency }, mode }` | ✅ |
| GET | /exposure | `{ ok, exposure: { gross, net, long, short, leverage }, mode }` | ✅ |
| POST | /stress-test | `{ ok, success, scenarios[], portfolioValue, mode }` | ✅ |

### `/api/risk` (riskRoutes.js) — NOUVEAU

| Method | Path | Réponse | Statut |
|--------|------|---------|--------|
| GET | /summary | `{ ok, mode, risk: { var95, grossExposure, maxDrawdown, totalPnL, ... } }` | ✅ CRÉÉ |
| GET | /exposure | `{ ok, mode, exposure: { gross, net, long, short, leverage } }` | ✅ CRÉÉ |
| GET | /drawdown | `{ ok, mode, drawdown: { series[], currentDrawdown, maxDrawdown } }` | ✅ CRÉÉ |
| GET | /var | `{ ok, mode, var, varPct, confidence, horizon }` | ✅ CRÉÉ |
| GET | /limits | `{ ok, limits: { status: 'not_configured', ... } }` | ✅ CRÉÉ |
| GET | /alerts | `{ ok, mode, alerts: [], count: 0 }` | ✅ CRÉÉ |

### `/api/ml` (mlRoutes.js)

| Method | Path | Réponse | Statut |
|--------|------|---------|--------|
| POST | /infer/:symbol | `{ ok, symbol, prediction, confidence, probabilities, ... }` | ✅ |
| GET | /health | `{ ok, workerAlive, pid, restarts, ... }` | ✅ |
| GET | /model | `{ ok, metadata }` | ✅ |
| POST | /train | `{ ok, jobId, symbol, startedAt }` | ✅ |
| GET | /predictions | `{ ok, predictions: [], count: 0, total: 0 }` | ✅ |
| GET | /training-runs | `{ ok, activeJobs: [], count: 0 }` | ✅ |
| GET | /model-runs | `{ ok, activeJobs: [], count: 0 }` | ✅ (alias) |
| GET | /model-card | `{ ok, content }` | ✅ |
| GET | /schema | `{ ok, schema }` | ✅ |
| GET | /signal/:symbol | `{ ok, symbol, signal: null, status: 'no_cached_signal' }` | ✅ CRÉÉ |
| GET | /feature-importance | `{ ok, features: [], count: 0 }` | ✅ CRÉÉ |
| GET | /drift | `{ ok, drift: { psi: {}, status: 'not_enough_data' } }` | ✅ CRÉÉ |

### `/api/providers/health` (marketStreamRoutes.js)

| Champ | Avant | Après |
|-------|-------|-------|
| `providers` | `marketStreamEngine.getProviderHealth()` | inchangé (compat) |
| `canonicalProviders` | absent | ✅ AJOUTÉ — contient `credentialStatus`, `runtimeStatus`, `capabilities` |
| `ok` | absent | ✅ AJOUTÉ |

### `/api/feeds/providers/active` (feedRoutes.js)

| Champ | Avant | Après |
|-------|-------|-------|
| `success` | ✅ | ✅ |
| `ok` | absent | ✅ AJOUTÉ |
| `activeProviders` | absent | ✅ AJOUTÉ (alias de `providers`) |

---

## Inventaire des appels frontend vs routes backend

| Frontend (api.js) | Route backend | Statut |
|-------------------|--------------|--------|
| `GET /api/portfolio/positions` | portfolioRoutes | ✅ |
| `GET /api/portfolio/pnl` | portfolioRoutes | ✅ |
| `GET /api/portfolio/exposure` | portfolioRoutes | ✅ |
| `GET /api/portfolio/drawdown` | portfolioRoutes | ✅ |
| `GET /api/portfolio/var` | portfolioRoutes | ✅ |
| `GET /api/portfolio/summary` | portfolioRoutes | ✅ |
| `GET /api/ml/health` | mlRoutes | ✅ |
| `GET /api/ml/model` | mlRoutes | ✅ |
| `POST /api/ml/train` | mlRoutes | ✅ |
| `GET /api/ml/model-runs` | mlRoutes | ✅ |
| `GET /api/ml/predictions` | mlRoutes | ✅ |
| `GET /api/ml/model-card` | mlRoutes | ✅ |
| `GET /api/ml/feature-importance` | mlRoutes | ✅ CRÉÉ |
| `GET /api/ml/drift` | mlRoutes | ✅ CRÉÉ |
| `GET /api/ml/signal/:symbol` | mlRoutes | ✅ CRÉÉ |
| `GET /api/providers/health` | marketStreamRoutes | ✅ (+ canonicalProviders) |
| `GET /api/feeds/providers` | feedRoutes | ✅ |
| `GET /api/feeds/status` | feedRoutes | ✅ |
| `GET /api/feeds/providers/active` | feedRoutes | ✅ |
| `POST /api/feeds/providers/active` | feedRoutes | ✅ |
| `POST /api/feeds/providers/:id/credentials` | feedRoutes | ✅ |
| `DELETE /api/feeds/providers/:id/credentials` | feedRoutes | ✅ |

---

## Problèmes résiduels (Frontend — ne peut pas être poussé depuis ce repo)

| Bug | Fichier frontend | Correction recommandée |
|-----|-----------------|----------------------|
| `feedStore.saveCredentials` lit `result?.credentialsStatus \|\| 'missing_credentials'` — si la clé manque, defaulte à missing | `src/store/feedStore.js` | Lire `result.credentials?.configured ? 'configured' : result.credentialsStatus` — le backend envoie maintenant `credentialsStatus` |
| `LiveDataWorkspace.parsedProviders` fait `uniqueStrings([...store.activeProviders, ...store.selectedProviders])` — mélange état UI et backend | `src/workspaces/LiveDataWorkspace.jsx` | Afficher uniquement `activeProviders` après save; séparer `draftSelectedProviders` de `savedActiveProviders` |
| `marketRuntimeStore` duplique `activeProviders` et `providerOrder` en parallèle de `feedStore` | `src/store/marketRuntimeStore.js` | Retirer ces champs de `marketRuntimeStore`; seul `feedStore` est source de vérité |
| `wsClient` URL resolution: si `VITE_API_BASE` est absent, fallback `ws://localhost:3001/ws` bloqué en HTTPS | `src/services/wsClient.js` | Dériver de `window.location` en production — CORRECTION DÉJÀ APPLIQUÉE selon PRODUCTION_RECOVERY_REPORT.md |
| `localStorage` peut contenir un `activeProviders` périmé qui écrase l'état backend au rechargement | `feedStore` persist middleware | Re-fetch backend après hydration initiale; ignorer cache localStorage si backend répond |

---

## Variables d'environnement requises

| Variable | Où | Valeur production |
|----------|----|------------------|
| `PORT` | backend (reversal) | 10000 |
| `VITE_API_BASE` | frontend build | `https://reversal.onrender.com` (ou URL réelle) |
| `ALLOWED_ORIGINS` | backend | URL du frontend |
| `JWT_SECRET` | backend | secret fort |
| `USER_TOKEN` | backend | token API optionnel |

---

## Tests manquants (à ajouter)

### Backend (reversal)
1. `GET /api/risk/summary` → 200 avec shape correcte
2. `GET /api/risk/summary?mode=live` → 503 (live non connecté)
3. `GET /api/ml/feature-importance` → 200 avec `{ ok, features: [] }` sans modèle
4. `GET /api/ml/drift` → 200 avec `{ ok, drift: { status: 'not_enough_data' } }`
5. `GET /api/ml/signal/SPY` → 200 avec `{ ok, signal: null }`
6. `GET /api/portfolio/positions` → 200 avec `ok: true`
7. `feedManager.resolveActiveState` avec `fallback_demo: false` → ne force pas fallback_demo
8. `feedManager._getProviderByAnyCase('alphavantage')` → retourne `alphaVantage`
9. `POST /api/feeds/providers/:id/credentials` → réponse inclut `credentialsStatus`
10. `GET /api/providers/health` → réponse inclut `canonicalProviders[]`
