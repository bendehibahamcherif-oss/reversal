# API Contract Matrix

Generated during backend stabilization on 2026-06-05. Frontend source was not present in `/workspace`, so the matrix covers required platform endpoints, mounted aliases, and product-visible consumers.

| Frontend endpoint | Backend route | Method | Exists | Mounted | Response schema | Consumer | Status | Fix |
|---|---|---|---|---|---|---|---|---|
| `/api/ml/health` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, status, worker }` | ML dashboard/diagnostics | fixed | added explicit `status: available` and worker availability object |
| `/api/ml/model` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, champion, challengers, status }` | Model registry/champion model | green | no change |
| `/api/ml/model-runs` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, runs }` | Training runs/model registry | green | no change |
| `/api/ml/predictions` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, predictions }` | ML predictions panel | green | no change |
| `/api/ml/feature-importance` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, features }` | ML diagnostics | green | no change |
| `/api/ml/drift` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, drift }` | Drift diagnostics | green | no change |
| `/api/ml/model-card` | `server/api/mlRoutes.js` | GET | yes | `/api/ml` | `{ ok, modelCard, status }` with JSON Accept | Model card | green | no change |
| `/api/ml/infer/:symbol` | `server/api/mlRoutes.js` | POST | yes | `/api/ml` | no_champion_model or prediction | Champion inference | green | no change |
| `/api/providers/health` | `server/api/providerCredentialRoutes.js` | GET | yes | `/api/providers` | canonical provider list | Providers/diagnostics | green | no change |
| `/api/providers/credentials` | `server/api/providerCredentialRoutes.js` | GET | yes | `/api/providers` | masked credential map | Credentials | green | no change |
| `/api/providers/credentials/:providerId` | `server/api/providerCredentialRoutes.js` | POST | yes | `/api/providers` | configured provider + masked credential | Credentials | green | no change |
| `/api/providers/credentials/:providerId` | `server/api/providerCredentialRoutes.js` | DELETE | yes | `/api/providers` | missing provider + canonical state | Credentials | green | no change |
| `/api/providers/active` | `server/api/providerCredentialRoutes.js` | GET | yes | `/api/providers` | activeProviders/providerOrder | Providers | green | no change |
| `/api/providers/active` | `server/api/providerCredentialRoutes.js` | POST | yes | `/api/providers` | canonical saved activeProviders or structured 400 | Providers | green | no change |
| `/api/feed/status` | `server/api/feedRoutes.js` | GET | yes | `/api/feed` | feed status/canonical providers | Stream status/live data | green | no change |
| `/api/feeds/tick/:symbol` | `server/api/feedRoutes.js` | GET | yes | `/api/feeds` | `{ success: true, ...tick/null }` | Live data | green | no change |
| `/api/feeds/candle/:symbol` | `server/api/feedRoutes.js` | GET | yes | `/api/feeds` | `{ success: true, ...candle/null }` | Chart/live data | green | no change |
| `/api/feeds/orderbook/:symbol` | `server/api/feedRoutes.js` | GET | yes | `/api/feeds` | `{ success: true, ...orderbook/null }` | Live data/orderbook | green | no change |
| `/api/portfolio/summary` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | safe summary | Portfolio | green | no change |
| `/api/portfolio/positions` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | `{ ok, positions }` | Portfolio | green | no change |
| `/api/portfolio/pnl` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | `{ ok, pnl }` | Portfolio | green | no change |
| `/api/portfolio/exposure` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | `{ ok, exposure }` | Portfolio/risk | green | no change |
| `/api/portfolio/drawdown` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | `{ ok, drawdown }` | Portfolio/risk | green | no change |
| `/api/portfolio/history` | `server/api/portfolioRoutes.js` | GET | yes | `/api/portfolio` | `{ ok, history, status }` | Portfolio history | fixed | added route to remove raw 404 risk |
| `/api/risk/summary` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, risk }` | Risk | fixed | empty status normalized to `not_enough_data` |
| `/api/risk/limits` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, limits }` | Risk | green | no change |
| `/api/risk/var` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, var, varPct }` | Risk | green | no change |
| `/api/risk/drawdown` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, drawdown }` | Risk | green | no change |
| `/api/risk/exposure` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, exposure }` | Risk | green | no change |
| `/api/risk/alerts` | `server/api/riskRoutes.js` | GET | yes | `/api/risk` | `{ ok, alerts }` | Risk | green | no change |
| `/api/volume-profile/*` | `server/api/volumeProfileRoutes.js` | mixed | yes | `/api/volume-profile` | route-specific | Volume profile | mounted | frontend source unavailable for deeper contract |
| `/api/alerts/*` | `server/api/alertRoutes.js` | mixed | yes | `/api/alerts` | route-specific | Alerts | mounted | frontend source unavailable for deeper contract |
| `/api/paper/*` | `server/api/paperTradingRoutes.js` | mixed | yes | `/api/paper` | route-specific | Paper trading | mounted | frontend source unavailable for deeper contract |
| `/api/strategy-lab/*` | `server/api/strategyLabRoutes.js` | mixed | yes | `/api/strategy-lab` | route-specific | Strategy Lab | mounted | frontend source unavailable for deeper contract |
| `/api/quant/*` | `server/api/quantRoutes.js` | mixed | yes | `/api/quant` | route-specific | Quant Lab | mounted | frontend source unavailable for deeper contract |
| `/api/replay/*` | `server/api/replayRoutes.js` | mixed | yes | `/api/replay` | route-specific | Replay | mounted | frontend source unavailable for deeper contract |
| `/api/runtime/health` | inline runtime route | GET | yes | root app | runtime health | Settings/More | mounted | no change |
