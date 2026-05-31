"""
sklearn Pipeline factory for the ML Signal Engine.

Returns a pre-processing pipeline (imputation → scaling) that can be
composed with a classifier.  The pipeline is intentionally fit on the
training set only — never on validation or test data.

Feature-name validation: sklearn >= 1.0 records the feature names seen
during fit() when the input is a DataFrame; a subsequent transform() with
different column names raises ValueError automatically.
"""

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


def create_pipeline() -> Pipeline:
    """
    Return a fresh imputation + scaling Pipeline.

    Steps
    -----
    imputer : SimpleImputer(strategy='mean')
        Replaces NaN with the column mean computed on the fit data.
    scaler  : StandardScaler()
        Standardises to zero mean / unit variance using fit-set statistics.

    Usage
    -----
    >>> pipe = create_pipeline()
    >>> pipe.fit(X_train, y_train)      # statistics captured here
    >>> X_val_scaled = pipe.transform(X_val)   # same stats applied
    """
    return Pipeline([
        ("imputer", SimpleImputer(strategy="mean")),
        ("scaler",  StandardScaler()),
    ])


# Alias expected by some test cases imported as 'train_pipeline'
train_pipeline = create_pipeline
