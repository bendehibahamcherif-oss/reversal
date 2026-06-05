# Platform Functional Matrix

Generated during the backend stabilization pass for `reversal` on 2026-06-05. The sibling frontend repository `intraday-reversal-engine` is not present in this workspace, so frontend component/store names are listed from the product workspace contract and known panel names rather than verified source files. Backend route existence is verified against mounted routes in `server/bootstrap/runtimeIntegration.js`.

| Workspace | Panel | Frontend component | Store/hook | API method | Endpoint | Backend route exists? | Expected response | Current status | Fix required | Test added |
|---|---|---|---|---|---|---|---|---|---|---|
| Chart | Main chart data | Chart workspace panel | market/feed hook | GET | `/api/chart/*`, `/api/feeds/candle/:symbol` | yes | JSON candle/chart payload or safe empty state | mounted | none in backend pass | platform smoke covers feed candle |
| Markets | Market list/status | Markets workspace panel | market/feed hook | GET | `/api/market/status`, `/api/feed/status` | yes via feed alias | provider/feed status JSON | mounted | keep frontend on mounted alias | platform smoke covers feed status |
| Live Data | Latest tick | Live data panel | feed store | GET | `/api/feeds/tick/:symbol` | yes | `{ success: true, ...tick/null }` | mounted; no 404 | none | platformSafeRoutes + platform smoke |
| Live Data | Latest candle | Live data panel | feed store | GET | `/api/feeds/candle/:symbol` | yes | `{ success: true, ...candle/null }` | mounted; no 404 | none | platformSafeRoutes + platform smoke |
| Live Data | Order book | Live data panel | feed store | GET | `/api/feeds/orderbook/:symbol` | yes | `{ success: true, ...orderbook/null }` | mounted; no 404 | none | platformSafeRoutes + platform smoke |
| Providers | Provider health | Providers tab | provider store | GET | `/api/providers/health` | yes | canonical provider list | mounted | none | providerState + platform smoke |
| Credentials | Credential list | Credentials tab | provider store | GET | `/api/providers/credentials` | yes | masked credential status map | mounted | none | providerState + platform smoke |
| Credentials | Save credential | Credentials tab | provider store | POST | `/api/providers/credentials/:providerId` | yes | structured configured provider status | mounted | none | providerState |
| Credentials | Delete credential | Credentials tab | provider store | DELETE | `/api/providers/credentials/:providerId` | yes | structured missing provider status | mounted | none | providerState |
| Providers | Active provider selection | Providers tab | provider store | GET/POST | `/api/providers/active` | yes | canonical activeProviders/providerOrder | mounted | none | providerState + platform smoke |
| Stream Status | Feed status | Stream status panel | feed/ws store | GET | `/api/feed/status` | yes | feed status with provider runtime statuses | mounted | none | platformSafeRoutes + platform smoke |
| Provider Diagnostics | Runtime diagnostics | Diagnostics panel | provider store | GET | `/api/providers/health` | yes | canonical provider diagnostics | mounted | none | providerState |
| Volume Profile | Profile data | Volume profile panel | volume profile hook | GET | `/api/volume-profile/*` | yes | profile data or safe empty state | mounted | none in backend pass | not added |
| Alerts | Alert list/rules | Alerts panel | alerts hook | GET/POST | `/api/alerts/*` | yes | alert data or empty list | mounted | none in backend pass | not added |
| ML Dashboard | ML health | ML dashboard | ML store | GET | `/api/ml/health` | yes | `{ ok: true, status: 'available', worker }` | fixed/hardened | worker contract added | mlRoutes + platformSafeRoutes + platform smoke |
| ML Dashboard | Model registry | Model registry panel | ML store | GET | `/api/ml/model` | yes | champion null/challengers[]/no_model | mounted | none | mlRoutes + platform smoke |
| ML Training Runs | Runs list | Training runs panel | ML store | GET | `/api/ml/model-runs` | yes | `{ ok: true, runs: [] }` | mounted | none | mlRoutes + platform smoke |
| ML Predictions | Predictions list | Predictions panel | ML store | GET | `/api/ml/predictions` | yes | `{ ok: true, predictions: [] }` | mounted | none | mlRoutes + platform smoke |
| ML Diagnostics & Drift | Drift panel | Diagnostics/drift panel | ML store | GET | `/api/ml/drift` | yes | not_enough_data drift object | mounted | none | mlRoutes + platform smoke |
| ML Diagnostics & Drift | Feature importance | Feature importance panel | ML store | GET | `/api/ml/feature-importance` | yes | `{ ok: true, features: [] }` | mounted | none | mlRoutes + platform smoke |
| ML Model Card | Model card | Model card panel | ML store | GET | `/api/ml/model-card` | yes | modelCard null/not_available | mounted | none | mlRoutes + platform smoke |
| ML Champion Inference | Live inference | Champion inference panel | ML store | POST | `/api/ml/infer/:symbol` | yes | no_champion_model structured state before training | mounted | none | mlRoutes |
| Paper Trading | Paper orders/fills | Paper trading panel | paper store | GET/POST | `/api/paper/*` | yes | paper trading state | mounted | none in backend pass | not added |
| Portfolio | Summary | Portfolio panel | portfolio store | GET | `/api/portfolio/summary` | yes | safe paper summary | mounted | none | platformSafeRoutes + platform smoke |
| Portfolio | Positions | Portfolio panel | portfolio store | GET | `/api/portfolio/positions` | yes | `{ ok: true, positions: [] }` when empty | mounted | none | platformSafeRoutes + platform smoke |
| Portfolio | PnL | Portfolio panel | portfolio store | GET | `/api/portfolio/pnl` | yes | zero PnL object | mounted | none | platformSafeRoutes + platform smoke |
| Portfolio | Exposure | Portfolio panel | portfolio store | GET | `/api/portfolio/exposure` | yes | zero exposure object | mounted | none | platformSafeRoutes + platform smoke |
| Portfolio | Drawdown | Portfolio panel | portfolio store | GET | `/api/portfolio/drawdown` | yes | zero drawdown object | mounted | none | platformSafeRoutes + platform smoke |
| Portfolio | History | Portfolio panel | portfolio store | GET | `/api/portfolio/history` | yes | empty history state | added | backend route added | platformSafeRoutes |
| Risk | Summary | Risk panel | risk store | GET | `/api/risk/summary` | yes | not_enough_data risk object | fixed | status normalized | platformSafeRoutes + platform smoke |
| Risk | Limits | Risk panel | risk store | GET | `/api/risk/limits` | yes | not_configured limits | mounted | none | platformSafeRoutes |
| Risk | VaR | Risk panel | risk store | GET | `/api/risk/var` | yes | safe zero VaR | mounted | none | platformSafeRoutes |
| Risk | Drawdown | Risk panel | risk store | GET | `/api/risk/drawdown` | yes | zero drawdown | mounted | none | platformSafeRoutes + platform smoke |
| Risk | Exposure | Risk panel | risk store | GET | `/api/risk/exposure` | yes | zero exposure | mounted | none | platformSafeRoutes + platform smoke |
| Risk | Alerts | Risk panel | risk store | GET | `/api/risk/alerts` | yes | `{ ok: true, alerts: [] }` | mounted | none | platformSafeRoutes |
| Strategy Lab | Strategy laboratory | Strategy lab panel | strategy lab hook | GET/POST | `/api/strategy-lab/*` | yes | strategy lab data or safe empty state | mounted | none in backend pass | not added |
| Quant Lab | Quant analysis | Quant lab panel | quant hook | GET/POST | `/api/quant/*` | yes | quant features/signals or safe empty state | mounted | none in backend pass | not added |
| Replay | Replay controls/session | Replay panel | replay hook | GET/POST | `/api/replay/*`, `/api/replay-session/*` | yes | replay state/session data | mounted | none in backend pass | not added |
| Settings / More | Runtime/settings | Settings panel | settings/app store | GET | `/api/runtime/health` | yes | runtime health JSON | mounted | none | not added |
| WebSocket | Stream connection | Stream/ws indicator | websocket store | WS | Socket.IO server on app origin | yes (server) | CONNECTING/CONNECTED/UNAVAILABLE client state | backend available; frontend absent | frontend status model not editable here | not added |
| Placeholder panels | Future modules | Placeholder panel | none | none | none | not_implemented_but_safe | no API call should be made | safe if frontend avoids calls | frontend audit required when repo exists | not added |
