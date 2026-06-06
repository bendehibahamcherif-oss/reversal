# ML All Models Training Compatibility Fix Report

## 1. Why all models failed

Training failed because the mandatory scikit-learn `LogisticRegression` baseline was constructed with the removed/unsupported `multi_class` keyword argument. In newer scikit-learn releases this raises:

```text
LogisticRegression.__init__() got an unexpected keyword argument 'multi_class'
```

## 2. Why the LogisticRegression baseline affected every model

The minimal production training pipeline trained the LogisticRegression baseline before fitting any selected/champion candidate. Because that baseline constructor/fitting step was not isolated, its failure aborted the pipeline before XGBoost, LightGBM, or HistGradientBoosting could be attempted.

## 3. Files where `multi_class` was removed

Removed `multi_class` from LogisticRegression constructors in:

- `server/ai/train_pipeline.py`
- `server/ai/training/train_pipeline.py`

Remaining `multi_class="ovr"` references are metric calls to `roc_auc_score`, not LogisticRegression constructors.

## 4. Before/after constructor

Before:

```python
LogisticRegression(max_iter=1000, multi_class="auto")
```

and in the copied training pipeline:

```python
LogisticRegression(
    max_iter=2000,
    solver="lbfgs",
    multi_class="multinomial",
    C=1.0,
    class_weight="balanced",
    random_state=seed,
)
```

After production helper:

```python
def make_logistic_regression():
    return LogisticRegression(
        max_iter=1000,
        solver="lbfgs",
        class_weight="balanced",
    )
```

The copied training pipeline now omits `multi_class` from its constructor as well.

## 5. Whether the baseline is still trained

Yes. The production pipeline still attempts the LogisticRegression baseline before the selected candidate model and records baseline status in `train_report.json` under:

```json
"baseline": {
  "status": "trained" | "failed",
  "modelType": "logistic_regression",
  "error": null
}
```

## 6. Whether selected model still trains if baseline fails

Yes. Baseline fitting is now isolated from candidate fitting. If the baseline fails, the pipeline records `baseline_failed`, then still attempts the requested candidate/fallback model when possible. The full training only fails if no model can be trained.

If all model fitting fails, the pipeline returns structured JSON with:

- `ok: false`
- `status: training_failed`
- `stage: model_fit`
- per-model `errors[]` entries with `modelType`, `errorType`, and `message`

If the baseline fails but the candidate succeeds, the pipeline returns success with:

```json
"warnings": ["baseline_failed"]
```

## 7. Tests added

Added synthetic-dataset regression coverage in `server/ai/tests/test_minimal_train_pipeline.py` for:

1. `make_logistic_regression()` instantiation without `multi_class`.
2. LogisticRegression model-type training not producing `multi_class` errors.
3. XGBoost model-type training/fallback not producing `multi_class` errors.
4. HistGradientBoosting model-type training not producing `multi_class` errors.
5. LightGBM model-type training/fallback not producing `multi_class` errors.
6. Baseline failure does not block a trainable selected model.
7. All-models-failed output includes `stage` and per-model error metadata.

The tests skip ML-dependent execution when Python ML dependencies are absent from the environment.

## 8. Validation results

Commands requested by the mission were run. In this container, Python ML dependencies are not installed, so Python training/pytest limitations are documented as environment warnings rather than code failures.

- `python3 server/ai/train_pipeline.py --help`: passed.
- `python3 -m pytest server/ai/tests -v`: collection failed because `numpy`/`joblib` are not installed for existing ML tests in this container.
- `python3 -m pytest server/ai/tests/test_minimal_train_pipeline.py -v`: passed 3 tests and skipped 6 ML-fit tests because Python ML dependencies are absent.
- `npm test`: passed (64/64 Node tests).
- `npm run build`: passed.
- `node scripts/create-synthetic-ml-dataset.js /tmp/features_snapshot.csv 300`: passed and generated a 300-row CSV.
- Local training smoke commands returned `python_dependency_missing` because `numpy`, `pandas`, `sklearn`, and `joblib` are absent in this container; no command produced a `multi_class` error.
