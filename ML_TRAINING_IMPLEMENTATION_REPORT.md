# ML Training Implementation Report

## 1. Why training was failing
Training was failing because `POST /api/ml/train` only checked a hard-coded Parquet dataset path and spawned a background script. It did not discover CSV snapshots, did not parse a training result, did not write the JSON registry used by the API, and did not promote a champion. The old Python training entry point also depended on unavailable ML packages at import time.

## 2. Dataset expected
Training accepts CSV or Parquet snapshots containing at least:
- `timestamp`
- `symbol`
- `open`
- `high`
- `low`
- `close`
- `volume`

Optional engineered features are used when present. Otherwise the pipeline computes P1 OHLCV features without future shifts.

Default discovery paths:
1. `server/ai/data/features_snapshot.parquet`
2. `server/ai/data/features_snapshot.csv`
3. `data/features_snapshot.parquet`
4. `data/features_snapshot.csv`
5. `datasets/features_snapshot.parquet`
6. `datasets/features_snapshot.csv`

## 3. Training script added/modified
Added `server/ai/train_pipeline.py` as the minimal real trainable path. It:
- loads CSV or Parquet;
- validates required columns;
- filters the requested symbol;
- creates labels with `entry=open[t+1]` and `exit=close[t+horizon]`;
- drops the final horizon rows;
- builds basic P1 features from OHLCV;
- performs chronological train/validation/test splitting with a gap equal to the horizon;
- trains logistic regression and an XGBoost candidate when available, falling back to sklearn HistGradientBoosting;
- emits structured JSON for Node to parse.

## 4. Node wrapper added/modified
Added `server/ai/trainingService.js`. It validates the request body, discovers datasets, spawns Python with a configurable timeout, captures stdout/stderr, parses JSON, and returns JSON-only errors such as `dataset_missing`, `not_enough_data`, and `training_failed`.

## 5. Registry implementation
Added `server/ai/modelRegistry.js`, backed by `server/ai/artifacts/registry.json` by default. It supports list, get, champion lookup, registering candidate runs, and champion promotion with previous-champion archival.

## 6. Artifacts generated
Successful training saves artifacts under `server/ai/artifacts/<model_id>/`:
- `model.json` for XGBoost JSON artifacts or `model.joblib` for trusted local sklearn artifacts;
- `manifest.json`;
- `metrics.json`;
- `feature_schema.json`;
- `model_card.md`;
- `train_report.json`.

## 7. Tests added
Backend route tests now cover:
- `dataset_missing` JSON when no snapshot exists;
- small synthetic CSV returning structured `not_enough_data` JSON;
- `/api/ml/model-runs` without a required symbol;
- `/api/ml/model` empty champion behavior;
- `/api/ml/promote/:modelId` setting a champion.

The Python script exposes pure functions for label generation and chronological splitting so Python tests can validate no-lookahead behavior when pytest and ML dependencies are installed.

## 8. How to train the first model
1. Install Python ML dependencies:
   ```bash
   pip install -r requirements-ml.txt
   ```
2. Generate a synthetic dataset if no real dataset is available:
   ```bash
   node scripts/create-synthetic-ml-dataset.js server/ai/data/features_snapshot.csv SPY 240
   ```
3. Start the API and call:
   ```bash
   curl -s -X POST http://localhost:3000/api/ml/train \
     -H 'content-type: application/json' \
     -d '{"symbol":"SPY","timeframe":"1m","horizon":20,"promote":true}'
   ```
4. Confirm registry/champion:
   ```bash
   curl -s http://localhost:3000/api/ml/model-runs
   curl -s http://localhost:3000/api/ml/model
   ```

## 9. Remaining limitations
- Live feature extraction is not wired into inference. After a champion exists, `/api/ml/infer/:symbol` asks for `featureVector` instead of fabricating features.
- The artifact execution worker for newly registered artifacts is not yet wired; inference validates champion and feature schema and returns an explicit worker-not-wired status rather than fake predictions.
- Parquet loading requires `pyarrow` or another pandas parquet engine.
- Training requires installing `requirements-ml.txt`; dependency-light CI can still exercise missing dataset and not-enough-data JSON paths.
