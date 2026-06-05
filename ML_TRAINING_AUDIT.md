# ML Training Audit

## Current train endpoint behavior
- `POST /api/ml/train` previously validated only `symbol`, `horizon`, and thresholds, then attempted to spawn `server/ai/training/train_pipeline.py` asynchronously.
- It returned `{ ok: true, jobId, message: "Training started" }` immediately instead of returning a trained model, metrics, registry entry, or promotion result.
- If the script or hard-coded dataset was missing, it returned `training_unavailable` with worker/dataset details.

## Whether it called a real Python script
- The route pointed at `server/ai/training/train_pipeline.py`, which is a real training script, but it imported optional packages (`lightgbm`, `xgboost`, pandas, sklearn) at module import time and required a Parquet file.
- In the current environment those Python ML dependencies are not installed, so the old script cannot start successfully.

## Expected dataset path
- The old route hard-coded `server/ai/datasets/snapshot.parquet`.
- The implemented dataset discovery now accepts a request `datasetPath` or searches:
  1. `server/ai/data/features_snapshot.parquet`
  2. `server/ai/data/features_snapshot.csv`
  3. `data/features_snapshot.parquet`
  4. `data/features_snapshot.csv`
  5. `datasets/features_snapshot.parquet`
  6. `datasets/features_snapshot.csv`

## Expected feature schema
Minimum snapshot columns:
- `timestamp`
- `symbol`
- `open`
- `high`
- `low`
- `close`
- `volume`

Optional precomputed features accepted if present:
- `ret_1`, `ret_5`, `range_1`, `body_pct`, `rsi14`, `ema9_spread`, `ema20_spread`, `vwap_spread`, `dist_poc`, `dist_vah`, `dist_val`, `cvd_slope`, `l1_queue_imbalance`, `footprint_imbalance_count`

If engineered features are missing, the new pipeline computes P1 OHLCV features using only current and historical bars:
- `ret_1`, `ret_5`, `ret_20`, `range_pct`, `body_pct`, `upper_wick_pct`, `lower_wick_pct`, `volume_zscore_20`, `realized_vol_20`, `ema9_spread`, `ema20_spread`, `vwap_spread`

## Model artifact path
- The old route saved under `server/ai/models` and expected flat files such as `model_metadata.json`.
- The implemented path saves each run under `server/ai/artifacts/<model_id>/` with:
  - `model.json` or `model.joblib`
  - `manifest.json`
  - `metrics.json`
  - `feature_schema.json`
  - `model_card.md`
  - `train_report.json`

## Registry path
- The minimum registry is now `server/ai/artifacts/registry.json` unless overridden by `ML_ARTIFACTS_DIR`.
- It stores model id, creation time, symbol, timeframe, horizon, dataset hash, feature schema hash, metrics, artifact path, artifact type, and status.

## Champion selection
- The old Node endpoint did not promote a champion after training. The old Python script attempted its own SQLite registry promotion, but that was not connected to `/api/ml/model` or `/api/ml/model-runs`.
- The implemented route registers each successful run as `candidate` and promotes it only through `POST /api/ml/promote/:modelId` or `POST /api/ml/train` with `promote: true`.

## Why worker showed stopped
- `/api/ml/health` reports inference worker health, not training-worker health. With no model metadata and no active inference worker, the UI interpreted that as stopped.
- Training was also asynchronous and not tied to a persisted run registry, so the UI could not observe a completed model.

## Why dataset was `missing_or_empty`
- The old train endpoint checked only `server/ai/datasets/snapshot.parquet`.
- If that one file was absent, every train request returned unavailable even if a CSV or snapshot existed elsewhere.
