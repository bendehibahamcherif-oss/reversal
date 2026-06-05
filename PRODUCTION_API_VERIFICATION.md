# Production API Verification

Production base tested: `https://reversal.onrender.com`

> Environment note: this container could not complete outbound CONNECT/fetch calls to Render. A direct `curl -I https://reversal.onrender.com/health` returned `CONNECT tunnel failed, response 403`, and the Node smoke script recorded `fetch failed` / timeout entries. The same smoke script passes against the updated local backend; see `LOCAL_API_SMOKE_RESULTS.json`.

| Endpoint | Status | Content-Type | Valid JSON? | Shape OK? | Problem |
|---|---:|---|---|---|---|
| GET /api/ml/health | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| GET /api/ml/model | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/ml/model-runs?symbol=SPY | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| GET /api/ml/training-runs?symbol=SPY | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/ml/predictions?symbol=SPY | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| GET /api/ml/feature-importance | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/ml/drift | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/ml/model-card | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| POST /api/ml/train | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| POST /api/ml/infer/SPY | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/multi-asset/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| GET /api/multi-asset/sector-rotation?window=20&timeframe=1d&benchmark=SPY | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/multi-asset/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/macro/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/macro/beta?asset=QQQ&benchmark=SPY&window=20 | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |
| GET /api/macro/sector-rotation?window=20&timeframe=1d&benchmark=SPY | n/a | n/a | No | No | Verification blocked by container outbound network / timeout |
| GET /api/macro/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d | n/a | n/a | No | No | Verification blocked by container outbound network (`fetch failed`) |

## Local contract verification using exact smoke list

`API_BASE=http://127.0.0.1:18080 REQUEST_TIMEOUT_MS=5000 node scripts/production-api-smoke.js` passed every endpoint after these fixes. The captured artifact is `LOCAL_API_SMOKE_RESULTS.json`.
