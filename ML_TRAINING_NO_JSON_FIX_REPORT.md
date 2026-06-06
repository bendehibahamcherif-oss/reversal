# ML Training “No JSON Result” Fix Report

## 1. Exact Python command before fix

```bash
python3 server/ai/train_pipeline.py --symbol SPY --horizon 10
```

Node production training uses the same script through this command shape:

```bash
python3 server/ai/train_pipeline.py \
  --dataset <resolvedDatasetPath> \
  --symbol SPY \
  --timeframe 1d \
  --horizon 10 \
  --model-type XGBoost \
  --output-dir server/ai/artifacts \
  --cost-bps 0 \
  --tau-up 0.001 \
  --tau-dn 0.001
```

## 2. stdout before fix

The missing-required-argument reproduction exited with no stdout:

```text

```

## 3. stderr before fix

```text
usage: train_pipeline.py [-h] --dataset DATASET --symbol SYMBOL
                         [--timeframe TIMEFRAME] [--horizon HORIZON]
                         [--cost-bps COST_BPS] [--tau-up TAU_UP]
                         [--tau-dn TAU_DN] [--output-dir OUTPUT_DIR]
                         [--model-type MODEL_TYPE]
train_pipeline.py: error: the following arguments are required: --dataset/--data
```

Exit code: `2`.

## 4. Root cause of no JSON

`argparse` handled CLI validation failures itself. On a missing required argument it wrote usage/error text to stderr and exited through `SystemExit` before the pipeline could emit a JSON object. The Node wrapper only had a generic parse fallback and returned `Training returned no JSON result.` without preserving enough subprocess diagnostics.

A second related risk was that Python result payloads could contain JSON-invalid values such as `NaN`/`Infinity` or numpy/pandas scalar/array objects, causing `json.dumps` or downstream JSON parsing to fail.

## 5. `train_pipeline.py` JSON handling changes

- Added a JSON-only stdout contract: the CLI now emits exactly one final JSON object to stdout on both success and failure.
- Added `JsonArgumentParser`, which raises a Python exception instead of letting `argparse` print plain stderr and exit with empty stdout.
- Added top-level `main()`/`try`/`except` handling that returns structured JSON failures containing `ok`, `status`, `stage`, `message`, `errorType`, and a bounded traceback.
- Added `sanitize_for_json()` to recursively convert non-JSON-native and invalid JSON values:
  - `NaN`/`Infinity` → `null`
  - numpy scalars → Python scalars or `null` if non-finite
  - arrays/matrices → lists
  - timestamps/dates/paths → strings
  - dict/list/tuple/set values recursively sanitized
- Added training-stage tracking (`argparse`, `dataset_validation`, `dependency_imports`, `load_dataset`, `feature_engineering`, `label_or_split`) so failures report where they occurred.
- Converted small dataset, one-class label, and too-small split outcomes into structured `not_enough_data` JSON responses with row counts, usable rows, class distribution, and split details.
- Added `--promote` as an accepted but ignored Python argument because promotion is handled by Node.

## 6. `trainingService.js` parsing/diagnostic changes

- Captures and returns subprocess metadata for JSON parse failures and process failures:
  - `exitCode`
  - `signal`
  - `stdoutPreview`
  - `stderrPreview`
  - `pythonBin`
  - `command`
  - `args`
  - `script`
  - `datasetId`
  - `datasetPath`
  - `timeoutMs`
  - `cwd`
- Replaced the generic `Training returned no JSON result.` response with a structured `training_failed` response at stage `python_json_parse` and message `Training pipeline did not return valid JSON.`
- Preserves Python failure payloads (`ok:false`) while adding subprocess diagnostics under `details.process`.
- Parses clean stdout first, then line-delimited JSON, then the last JSON object embedded in stdout for defensive compatibility with accidental logs.
- Redacts obvious secret/token/password/API-key values from diagnostic previews.
- Logs the exact Python command and arguments before spawn.

## 7. Tests added

- Python JSON sanitizer coverage for `NaN`, `Infinity`, numpy scalars, arrays, and pandas timestamps.
- Python argparse error coverage showing missing required args produce JSON instead of empty stdout.
- Python top-level exception JSON-shape coverage.
- Python small dataset coverage returning structured `not_enough_data`.
- Python one-class label coverage returning structured `not_enough_data` when ML dependencies are available.
- Python CLI subprocess tests for missing dataset JSON, argparse JSON, and valid CSV structured output.
- Node `TrainingService` subprocess test proving invalid stdout returns `python_json_parse` with stdout/stderr previews and subprocess metadata.

## 8. Validation result

- `npm test` passed.
- `npm run build` passed.
- Focused Python JSON-contract tests passed.
- Full `python3 -m pytest server/ai/tests -v` could not complete in this environment because `numpy`/`pandas`/`sklearn`/`joblib` are not installed in the active Python interpreter; this is an environment limitation, and the pipeline now returns structured `python_dependency_missing` JSON for that condition.
- Manual CLI validation with a valid CSV-shaped test dataset returned structured JSON instead of empty stdout. In this environment it reported `python_dependency_missing` with the missing dependency list, which is the expected safe failure shape.
