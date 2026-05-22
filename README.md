# Reversal Engine — Backend Proxy

Backend Node/Express qui sert de proxy entre le frontend React et Yahoo Finance. Résout les problèmes des proxies CORS publics (rate limiting, fiabilité) et prépare le terrain pour passer à Polygon/Twelve Data sans exposer de clé API.

## Fonctionnalités

- Proxy Yahoo Finance avec User-Agent spoofé (Yahoo bloque les requêtes sans UA crédible)
- Cache mémoire 30s par défaut (réduit drastiquement les appels Yahoo)
- CORS configurable (restreindre aux origines autorisées en prod)
- Validation des paramètres (symbol/interval/range)
- Timeout 8s sur les requêtes upstream
- Health check pour Render

## Endpoints

- `GET /` — Status JSON (uptime, cache size, etc.)
- `GET /health` — Health check pour Render
- `GET /yahoo/chart/:symbol?interval=5m&range=1d` — Proxy Yahoo Finance

## Déploiement sur Render

1. Push ce dossier sur un repo GitHub séparé (par ex. `reversal-proxy`)
2. Render → New + → **Web Service** → sélectionner le repo
3. Render lit `render.yaml` automatiquement (Node, plan Starter, etc.)
4. **Important** : aller dans Environment et définir `ALLOWED_ORIGINS` :
   - En dev : `*` (tout le monde, dangereux en prod)
   - En prod : `https://intraday-reversal-engine.onrender.com,https://tondomaine.com`
5. Deploy → l'URL du service apparaît (par ex. `reversal-proxy-xxxx.onrender.com`)

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `10000` | Port d'écoute (Render le fournit) |
| `ALLOWED_ORIGINS` | `*` | Origines CORS autorisées (séparées par virgules) |
| `CACHE_TTL_MS` | `30000` | Durée du cache mémoire (ms) |

## Configurer le frontend

Dans le frontend React, créer un fichier `.env` à la racine :

```
VITE_API_BASE=https://reversal-proxy-xxxx.onrender.com
```

Puis re-build et redéployer le Static Site.

## Tester en local

```bash
npm install
npm start
```

Puis dans un autre terminal :

```bash
curl http://localhost:10000/yahoo/chart/SPY?interval=5m&range=1d
```

## Sécurité

- `ALLOWED_ORIGINS` doit être restreint en production — sinon n'importe qui peut utiliser ton proxy
- Pas d'authentification implémentée — si tu sers beaucoup de monde, ajouter un rate-limit par IP (`express-rate-limit`)
- Validation regex stricte sur les paramètres pour éviter les abus

## Évolutions possibles

- Ajouter Polygon.io comme source (clé dans env var, jamais exposée au client)
- Cache Redis pour partager entre instances
- Logger les erreurs sur Sentry
- Endpoint `/yahoo/quote/:symbol` pour les snapshots temps réel
