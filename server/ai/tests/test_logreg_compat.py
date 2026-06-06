"""Regression tests for the LogisticRegression scikit-learn compatibility bug.

scikit-learn 1.7+ removed the ``multi_class`` keyword from
``LogisticRegression.__init__``. Passing it raised::

    TypeError: LogisticRegression.__init__() got an unexpected keyword
    argument 'multi_class'

Because LogisticRegression is the baseline candidate, that failure previously
aborted *every* training run (all model types) before any model could fit.
These tests guard against the keyword being reintroduced and confirm the
version-safe constructor actually fits on the installed scikit-learn.
"""
import pathlib
import re

import numpy as np
from sklearn.linear_model import LogisticRegression

AI_DIR = pathlib.Path(__file__).resolve().parents[1]

# train_pipeline.py files that construct a LogisticRegression baseline.
PIPELINE_SOURCES = [
    AI_DIR / "train_pipeline.py",
    AI_DIR / "training" / "train_pipeline.py",
]

# Matches a LogisticRegression( ... ) call body (across newlines) so we can
# assert multi_class is not passed *to the constructor*. roc_auc_score(..,
# multi_class="ovr") is a different, valid API and must not be flagged.
LOGREG_CALL = re.compile(r"LogisticRegression\((.*?)\)", re.DOTALL)


def test_logistic_regression_sources_do_not_pass_multi_class():
    for source in PIPELINE_SOURCES:
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8")
        for call_body in LOGREG_CALL.findall(text):
            assert "multi_class" not in call_body, (
                f"{source} passes multi_class to LogisticRegression — "
                "removed in scikit-learn 1.7+ and breaks the baseline candidate."
            )


def test_version_safe_logistic_regression_fits():
    """The exact constructor used by the active pipeline must fit on this sklearn."""
    rng = np.random.default_rng(0)
    x = rng.normal(size=(60, 4))
    y = rng.integers(0, 3, size=60)  # 3 classes, like the SHORT/NEUTRAL/LONG labels
    model = LogisticRegression(max_iter=1000, solver="lbfgs", class_weight="balanced")
    model.fit(x, y)
    preds = model.predict(x)
    assert preds.shape == (60,)
    assert set(model.classes_.tolist()).issubset({0, 1, 2})
