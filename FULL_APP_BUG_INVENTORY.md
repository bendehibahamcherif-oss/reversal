# Full App Bug Inventory

Generated: 2026-06-06

## Scope and source scan evidence

The working tree only contains the backend repository (`reversal`). A separate `intraday-reversal-engine` frontend repository is not present under `/workspace`; the only `package.json` found is `/workspace/reversal/package.json`. Backend source scans were completed with `rg` for route mounts, route handlers, JSON responses, non-finite values, dataset wiring, providers, ML lifecycle, and smoke scripts. Frontend items below are therefore inventoried as external/blocker items, not as modified source files.

## A. Workspace matrix

| Workspace/Menu | Desktop component | Mobile component | Store | API calls | Backend routes | Duplicates? | Risk | Fix |
|---|---|---|---|---|---|---|---|---|
| Chart | Frontend repo absent | Frontend repo absent | Unknown | `/api/chart`, `/api/feeds/*` | Mounted via `chartRoutes`, `feedRoutes` | Unknown | Cannot verify route registry/mobile access without frontend repo | Documented blocker; backend feed routes smoke-covered |
| Markets | Frontend repo absent | Frontend repo absent | Unknown | `/api/feeds/*`, `/api/feed/status` | Mounted via `feedRoutes` | Unknown | Cannot verify menus | Documented blocker; backend feed status smoke-covered |
| Live Data | Frontend repo absent | Frontend repo absent | Provider/feed state | `/api/feed/status`, `/api/feeds/tick/:symbol`, `/api/feeds/candle/:symbol`, `/api/feeds/orderbook/:symbol` | Mounted via `feedRoutes` | Unknown | Provider state can diverge if frontend trusts localStorage | Backend remains source of truth; smoke covers active providers/status |
| Providers | Frontend repo absent | Frontend repo absent | Provider state | `/api/providers/health`, `/api/providers/active` | Mounted before feed alias via `marketStreamRoutes` plus credentials routes | Unknown | Alpha Vantage/fallback_demo consistency | Existing provider tests and smoke cover consistency |
| Credentials | Frontend repo absent | Frontend repo absent | Provider credentials | `/api/providers/credentials`, `/api/providers/credentials/:providerId` | Mounted via `providerCredentialRoutes` | Unknown | Cannot verify UI masking | Backend route smoke inventory includes credentials |
| Stream Status | Frontend repo absent | Frontend repo absent | Feed status | `/api/feed/status` | Mounted | Unknown | Cannot verify WS UI | Backend route smoke-covered |
| Provider Diagnostics | Frontend repo absent | Frontend repo absent | Provider state | `/api/providers/health` | Mounted | Unknown | Cannot verify diagnostic panels | Backend provider tests cover configured/missing states |
| Volume Profile | Frontend repo absent | Frontend repo absent | Unknown | `/api/volume-profile/*` | Mounted | Unknown | Not part of canonical smoke list | Documented in backend mounted routes |
| Alerts | Frontend repo absent | Frontend repo absent | Unknown | `/api/alerts/*` | Mounted | Unknown | Cannot verify menu | Backend mounted |
| AI Lab | Frontend repo absent | Frontend repo absent | selectedMlDataset | `/api/ml/model`, `/api/ml/train`, `/api/ml/model-runs`, `/api/ml/promote/:modelId`, `/api/ml/infer/:symbol` | Mounted | Unknown | Known stale `/api/ai/*` cannot be removed without frontend repo | Backend canonical ML routes smoke-covered |
| ML Dashboard | Frontend repo absent | Frontend repo absent | ML registry | `/api/ml/model`, `/api/ml/model-runs` | Mounted | Unknown | Duplicate stale components possible in absent frontend repo | Documented blocker |
| ML Model Card | Frontend repo absent | Frontend repo absent | ML registry | `/api/ml/model-card` | Mounted | Unknown | None backend-side | Backend smoke covers route |
| ML Training Runs | Frontend repo absent | Frontend repo absent | ML registry | `/api/ml/model-runs` | Mounted | Unknown | None backend-side | Backend smoke covers route |
| ML Predictions | Frontend repo absent | Frontend repo absent | Predictions | `/api/ml/predictions`, `/api/ml/infer/:symbol` | Mounted | Unknown | Inference must not fake predictions | Backend returns precise no_champion / worker statuses |
| ML Diagnostics & Drift | Frontend repo absent | Frontend repo absent | Drift | `/api/ml/drift`, `/api/ml/feature-importance` | Mounted | Unknown | None backend-side | Backend smoke covers route |
| ML Champion Inference | Frontend repo absent | Frontend repo absent | Champion | `/api/ml/model`, `/api/ml/infer/:symbol` | Mounted | Unknown | Frontend might call stale champion route | Frontend blocker; backend canonical endpoints present |
| Historical Data | Frontend repo absent | Frontend repo absent | selected dataset store | `/api/historical/*` | Mounted | Unknown | Dataset propagation needs frontend store | Backend use-for endpoints validate real datasetId |
| Backtesting | Frontend repo absent | Frontend repo absent | selectedBacktestDataset | `/api/backtest/run`, `/api/backtest/runs`, `/api/backtest/runs/:runId` | `/run` mounted; `/runs` canonical gap found | Unknown | Canonical `/api/backtest/runs` and `/runs/:runId` ambiguous/missing | Add canonical run-list/run-detail compatibility |
| Paper Trading | Frontend repo absent | Frontend repo absent | Paper engine | `/api/paper/*` | Mounted | Unknown | Cannot verify UI safe empty states | Backend mounted |
| Portfolio | Frontend repo absent | Frontend repo absent | Portfolio engine | `/api/portfolio/summary`, `/positions`, `/pnl`, `/exposure`, `/drawdown`, `/history` | Mounted | Unknown | `.map`/undefined UI cannot be verified | Backend safe empty-state tests exist |
| Risk | Frontend repo absent | Frontend repo absent | Risk engine | `/api/risk/summary`, `/limits`, `/var`, `/drawdown`, `/exposure`, `/alerts` | Mounted | Unknown | NaN UI cannot be verified | Backend safe empty-state tests exist |
| Macro / Multi-Asset | Frontend repo absent | Frontend repo absent | selectedCorrelationDataset | `/api/macro/correlation`, `/api/macro/beta`, sector/volatility | Mounted | Unknown | Frontend NaN rendering cannot be verified | Backend returns null/not_enough_data and sanitizer applied |
| Correlation | Frontend repo absent | Frontend repo absent | selectedCorrelationDataset | `/api/macro/correlation` | Mounted | Unknown | DatasetId propagation frontend-side | Backend accepts datasetId |
| Beta | Frontend repo absent | Frontend repo absent | selectedCorrelationDataset | `/api/macro/beta` | Mounted | Unknown | Rolling beta NaN in UI | Backend returns null instead of NaN |
| Strategy Lab | Frontend repo absent | Frontend repo absent | Strategy store | `/api/strategy-lab/*` | Mounted | Unknown | Cannot verify menu | Backend mounted |
| Quant Lab | Frontend repo absent | Frontend repo absent | Quant state | `/api/quant/*` | Mounted | Unknown | Cannot verify menu | Backend mounted |
| Replay | Frontend repo absent | Frontend repo absent | Replay state | `/api/replay/*` | Mounted | Unknown | Cannot verify menu | Backend mounted |
| Settings / More | Frontend repo absent | Frontend repo absent | Settings/localStorage | Multiple | Backend routes mounted | Unknown | Cannot verify mobile More registry | Documented blocker |

## B. API matrix

| Frontend call | Method | Current URL | Expected URL | Backend exists? | Mounted? | Response shape | Fix |
|---|---|---|---|---|---|---|---|
| ML deps | GET | Frontend absent | `/api/ml/dependencies` | Yes | Yes | `{ok,status,dependencies}` | Smoke covers |
| ML health | GET | Frontend absent | `/api/ml/health` | Yes | Yes | `{ok,status,worker}` | Smoke covers |
| Champion model | GET | Frontend absent | `/api/ml/model` | Yes | Yes | `{ok,champion,status}` | Smoke covers |
| Model runs | GET | Frontend absent | `/api/ml/model-runs` | Yes | Yes | `{ok,runs,models}` | Smoke covers |
| Predictions | GET | Frontend absent | `/api/ml/predictions` | Yes | Yes | `{ok,predictions,status}` | Smoke covers |
| Feature importance | GET | Frontend absent | `/api/ml/feature-importance` | Yes | Yes | `{ok,features,status}` | Smoke covers |
| Drift | GET | Frontend absent | `/api/ml/drift` | Yes | Yes | `{ok,drift}` | Smoke covers |
| Model card | GET | Frontend absent | `/api/ml/model-card` | Yes | Yes | `{ok,modelCard,status}` | Smoke covers |
| Train | POST | Frontend absent | `/api/ml/train` | Yes | Yes | structured dataset_missing/not_found/etc. | Smoke covers dry error contract |
| Promote | POST | Frontend absent | `/api/ml/promote/:modelId` | Yes | Yes | `{ok,status,model}` or `{ok:false,status:model_not_found}` | Route smoke covers JSON/non-HTML |
| Infer | POST | Frontend absent | `/api/ml/infer/:symbol` | Yes | Yes | precise no_champion/feature_vector_required/worker statuses | Smoke covers |
| Historical providers | GET | Frontend absent | `/api/historical/providers` | Yes | Yes | `{ok,providers}` | Smoke covers |
| Historical datasets | GET | Frontend absent | `/api/historical/datasets` | Yes | Yes | `{ok,datasets,count}` | Smoke covers |
| Historical detail | GET | Frontend absent | `/api/historical/datasets/:datasetId` | Yes | Yes | `{ok,dataset}` or dataset_not_found | Smoke covers negative JSON |
| Historical diagnostics | GET | Frontend absent | `/api/historical/datasets/:datasetId/diagnostics` | Yes | Yes | diagnostic JSON | Smoke covers negative JSON |
| Historical download | POST | Frontend absent | `/api/historical/download` | Yes | Yes | `{ok,dataset,datasetId}` or precise errors | Tests cover symbols parsing |
| Use for ML | POST | Frontend absent | `/api/historical/use-for-ml` | Yes | Yes | `{ok,status,datasetId}` or precise error | Smoke covers missing datasetId |
| Use for backtest | POST | Frontend absent | `/api/historical/use-for-backtest` | Yes | Yes | `{ok,status,datasetId}` or precise error | Smoke covers missing datasetId |
| Use for correlation | POST | Frontend absent | `/api/historical/use-for-correlation` | Yes | Yes | `{ok,status,datasetId}` or precise error | Smoke covers missing datasetId |
| Backtest run | POST | Frontend absent | `/api/backtest/run` | Yes | Yes | `{ok,symbol,result,dataSource}` | Smoke covers datasetId error |
| Backtest runs | GET | Frontend absent | `/api/backtest/runs` | Gap found | Mounted after fix | `{ok,runs}` | Add canonical route |
| Backtest run detail | GET | Frontend absent | `/api/backtest/runs/:runId` | Ambiguous gap found | Mounted after fix | `{ok,run}` or JSON not found | Add compatibility handler |
| Macro correlation | GET | Frontend absent | `/api/macro/correlation` | Yes | Yes | `{ok,status,matrix}` with null/no NaN | Smoke covers |
| Macro beta | GET | Frontend absent | `/api/macro/beta` | Yes | Yes | `{ok,status,beta:null|number,r2:null|number}` | Smoke covers |
| Providers health | GET | Frontend absent | `/api/providers/health` | Yes | Yes | provider diagnostic JSON | Smoke covers |
| Provider credentials | GET/POST/DELETE | Frontend absent | `/api/providers/credentials[...]` | Yes | Yes | credential JSON | Smoke covers GET |
| Feed status | GET | Frontend absent | `/api/feed/status` | Yes | Yes | provider feed JSON | Smoke covers |
| Feeds tick/candle/orderbook | GET | Frontend absent | `/api/feeds/{tick,candle,orderbook}/:symbol` | Yes | Yes | JSON | Smoke covers canonical routes |
| Portfolio safe states | GET | Frontend absent | `/api/portfolio/*` | Yes | Yes | safe empty JSON | Smoke covers |
| Risk safe states | GET | Frontend absent | `/api/risk/*` | Yes | Yes | safe empty JSON | Smoke covers |
| Unknown API | Any | n/a | `/api/__unknown__` | Yes 404 handler | Yes | JSON endpoint_not_found | Harden method/sanitizer |

## C. State matrix

| State | Store | Persisted key | Used by | Backend truth? | Risk | Fix |
|---|---|---|---|---|---|---|
| selectedMlDatasetId | Frontend repo absent | Unknown | AI Lab/ML training | Historical dataset registry | Cannot implement/hydrate absent store | Backend validates `datasetId` and never treats undefined as success |
| selectedMlDataset | Frontend repo absent | Unknown | AI Lab display | Historical dataset detail | Cannot implement absent store | Documented blocker |
| selectedBacktestDatasetId | Frontend repo absent | Unknown | Backtest payload | Historical dataset registry | Cannot implement absent store | Backend accepts/validates datasetId |
| selectedCorrelationDatasetId | Frontend repo absent | Unknown | Macro correlation/beta payloads | Historical dataset registry | Cannot implement absent store | Backend accepts/validates datasetId |
| Champion model | Backend model registry | `server/ai/artifacts/registry.json` | ML model/inference/promote | Backend | Frontend stale champion cache possible | Backend canonical `/api/ml/model` returns source-of-truth champion |
| Provider active selection | Backend activeProviderStore | `server/persistence/secure/activeProviders.json` | Feed/provider diagnostics | Backend | Frontend localStorage could override | Backend provider tests prevent fallback_demo resurrection |
| Credentials | Backend credentialStore | `server/persistence/secure/providerCredentials.json` | Provider health/live data | Backend | External creds unavailable in CI | Backend masks and derives configured/missing states |
| Backtest runs | SQLite/backtestStore | Runtime DB | Backtesting history | Backend | Canonical `/api/backtest/runs` gap | Add run-list/run-detail compatibility |
| Portfolio/Risk | Portfolio engine | Runtime DB | Portfolio/risk pages | Backend | Undefined arrays in UI | Backend returns empty arrays/zero/null safe states |
| WebSocket status | Frontend repo absent | Unknown | Live status | Backend socket.io server | Cannot verify frontend retry cap | Documented blocker |
| activeWorkspace | Frontend repo absent | Unknown | Desktop/mobile nav | Frontend registry | Cannot implement registry | Documented blocker |

## D. Bug matrix

| Bug class | Evidence | Root cause | Files | Fix | Test |
|---|---|---|---|---|---|
| Missing frontend repository | `find /workspace -maxdepth 3 -name package.json` finds only backend package | `intraday-reversal-engine` is not present in this workspace | n/a | Document blocker; add frontend smoke that records missing repo instead of pretending validated | `node scripts/full-frontend-smoke.js` |
| Backtest canonical route gap | Canonical list requires `GET /api/backtest/runs`; backend only had `/runs/:symbol` | Symbol-scoped legacy route did not expose unscoped canonical run list | `server/api/backtestRoutes.js` | Add `/runs` and compatibility `/runs/:symbolOrRunId` | `node scripts/full-backend-smoke.js`, `npm test` |
| API HTML under `/api` | `/api/backtest/export/:symbol/:runId` set `Content-Type: text/html` and used `res.send(html)` | Report export predates JSON-only `/api/*` contract | `server/api/backtestRoutes.js` | Return JSON containing HTML report and filename metadata | Backend smoke HTML guard |
| API 404/error contract incomplete | `/api` 404 lacked `method`; error handler did not sanitize Error/NaN/BigInt/circular | Local handler duplicated response sanitizer logic | `server.js`, `server/utils/apiResponse.js` | Use sanitizer and include required method/requestId fields | `node scripts/full-backend-smoke.js` |
| Route smoke too narrow | Existing smoke omitted several canonical endpoints and forbidden class checks | Release gate could miss stale/absent backend APIs | `scripts/full-backend-smoke.js` | Expand canonical route checks, JSON/non-finite/HTML assertions | `node scripts/full-backend-smoke.js` |
| Platform smoke absent | Required `scripts/full-platform-contract-smoke.js` was missing | Backend-only repo had older `full-platform-smoke.js` | `scripts/full-platform-contract-smoke.js` | Add combined contract smoke that invokes backend/frontend gates | `node scripts/full-platform-contract-smoke.js` |
| Frontend stale endpoints/mobile/localStorage | User observed stale ML endpoint and mobile menu issues, but frontend repo absent | Cannot inspect or edit absent source | n/a | Document precise blocker in inventory/report; frontend smoke emits unavailable evidence | `node scripts/full-frontend-smoke.js` |
| Python dependency validation | `python3 -m pytest server/ai/tests -v` fails collecting numpy/joblib in current environment | ML Python packages not installed in container | `server/ai/tests/*` | Document environment limitation; JS dependency endpoint reports missing optional/required truth | `python3 -m pytest server/ai/tests -v` warning |
