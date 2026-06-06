# ML Signal Engine — Phase 9 · Résumé du code Python

> **Repo** : `bendehibahamcherif-oss/reversal`  
> **Branche** : `claude/feed-chart-routes-format-f6bKw`  
> **Tests** : 219 passants  
> **Date** : 2026-05-31

---

## Architecture générale

```
server/ai/
├── training/
│   ├── feature_builder.py      # 30 features, 7 familles, zéro lookahead
│   ├── feature_schema.py       # Catalogue JSON des features
│   ├── label_builder.py        # Labels P1 : SHORT(0) / NEUTRAL(1) / LONG(2)
│   ├── dataset_builder.py      # Fusion X + y, hash SHA-256, Parquet
│   ├── train_pipeline.py       # LR + XGBoost + LightGBM, split 70/15/15
│   ├── dataset_utils.py        # time_series_cv, split temporel, hashes
│   └── metrics.py              # ROC-AUC, F1, Brier, calibration curve
├── inference/
│   ├── infer_worker.py         # Subprocess persistant JSON-Lines
│   └── prediction_service.py  # PredictionService + watchdog + auto-restart
├── registry/
│   ├── registry.py             # SQLite ModelRegistry (5 tables)
│   ├── registry_service.py     # Service haut niveau
│   └── migrations/
│       └── 001_initial.sql     # DDL IF NOT EXISTS
├── monitoring/
│   ├── drift_monitor.py        # PSI feature + prediction drift
│   └── metrics_monitor.py      # Latence p50/p95/p99, Prometheus text
└── tests/
    ├── test_labels.py          # 36 tests
    ├── test_training.py        # 29 tests
    ├── test_inference.py       # 39 tests
    └── test_model_registry.py  # 20 tests
```

---

## Invariants absolus

```
entry_price = open[t + 1]            # jamais open[t] — fill réaliste
exit_price  = close[t + horizon]
net_return  = (exit_price - entry_price) / entry_price

gap CV      ≥ horizon                # TimeSeriesSplit(gap=horizon)
split       = 70 / 15 / 15          # chronologique strict, jamais de shuffle
p95 latence < 500 ms                 # testé dans test_inference.py
inv_label_map = {"0":"SHORT", "1":"NEUTRAL", "2":"LONG"}
```

---

## 1 · `feature_builder.py`

### Catalogue des 30 features

```python
FEATURE_FAMILIES: Dict[str, List[str]] = {
    "PRICE_ACTION": [
        "ret_1",          # (close[t] - close[t-1]) / close[t-1]
        "ret_5",          # (close[t] - close[t-5]) / close[t-5]
        "ret_10",         # (close[t] - close[t-10]) / close[t-10]
        "log_return",     # log(close[t] / close[t-1])
        "body_pct",       # |close - open| / (high - low + ε)
        "upper_wick_pct", # (high - max(open,close)) / (high - low + ε)
        "lower_wick_pct", # (min(open,close) - low) / (high - low + ε)
        "range_pct",      # (high - low) / close
    ],
    "VOLATILITY": [
        "rolling_vol_5",  # std(log_returns, 5) × √252
        "rolling_vol_20", # std(log_returns, 20) × √252
        "atr",            # EWM(True Range, span=14)
    ],
    "VOLUME": [
        "rvol",           # volume[t] / rolling_mean(volume, 20)
        "volume_zscore",  # (volume - mean20) / std20
        "volume_delta",   # volume[t] - volume[t-1]
    ],
    "VOLUME_PROFILE": [
        "dist_poc",          # (close - poc) / close   [optionnel → 0.0]
        "dist_vah",          # (close - vah) / close   [optionnel → 0.0]
        "dist_val",          # (close - val) / close   [optionnel → 0.0]
        "inside_value_area", # 1 si val ≤ close ≤ vah, sinon 0  [optionnel]
    ],
    "ORDERFLOW": [
        "spread",            # ask - bid                [optionnel → 0.0]
        "mid_price",         # (ask + bid) / 2          [optionnel → close]
        "queue_imbalance",   # (bid_sz - ask_sz) / (bid_sz + ask_sz + ε)
        "bid_ask_pressure",  # bid_sz / (ask_sz + ε)    [optionnel → 0.0]
    ],
    "FOOTPRINT": [
        "cvd",                      # cumsum(volume_delta)      [optionnel]
        "cvd_slope",                # diff(cvd, 5) / vol_mean5  [optionnel]
        "footprint_imbalance_count",# rolling_sum(|imbalance|,5)[optionnel]
        "stacked_imbalance",        # streak ≥ 3 imbalances même signe
    ],
    "SESSION": [
        "hour_sin",  # sin(2π × hour / 24)   [0.0 si pas de DatetimeIndex]
        "hour_cos",  # cos(2π × hour / 24)
        "day_sin",   # sin(2π × weekday / 5)
        "day_cos",   # cos(2π × weekday / 5)
    ],
}

ALL_FEATURE_NAMES: List[str] = [f for fam in FEATURE_FAMILIES.values() for f in fam]
# len(ALL_FEATURE_NAMES) == 30
```

### API publique

```python
def build_features(
    df: pd.DataFrame,
    feature_names: Optional[List[str]] = None,
) -> pd.DataFrame:
    """
    Calcule les features pour chaque barre du DataFrame.

    Paramètres
    ----------
    df           : OHLCV(+) trié ascendant. Colonnes requises :
                   open, high, low, close, volume.
                   Colonnes optionnelles : poc, vah, val, ask, bid,
                   ask_size, bid_size, cvd, footprint_imbalance.
    feature_names: Sous-ensemble de ALL_FEATURE_NAMES (défaut = tous).

    Retourne
    --------
    pd.DataFrame — même index que df, colonnes = feature_names.
    Jamais de NaN sur colonnes optionnelles absentes (→ 0.0).

    Lève
    ----
    KeyError   : colonne requise OHLCV manquante.
    ValueError : nom inconnu dans feature_names.
    """
```

### Règle zéro-lookahead

```python
# Toute feature à l'indice t n'utilise que df.iloc[:t+1].
# Vérification dans test_training.py :

X50 = build_features(df.iloc[:50])
X51 = build_features(df.iloc[:51])
# X50.iloc[49] == X51.iloc[49]  pour toute feature  ← doit être VRAI
```

---

## 2 · `label_builder.py`

### Constantes

```python
SHORT      = 0
NEUTRAL_P1 = 1
LONG       = 2
```

### `build_p1_labels` — Label principal

```python
def build_p1_labels(
    df: pd.DataFrame,
    horizon: int,
    tau_up: float   = 0.003,   # +0.3 % → LONG
    tau_down: float = -0.003,  # −0.3 % → SHORT
    open_col: str   = "open",
    close_col: str  = "close",
) -> pd.Series:
    """
    Labels LONG(2) / NEUTRAL(1) / SHORT(0) pour le moteur P1.

    Pour chaque barre t :
        entry_price = open[t + 1]          # prochain open (fill réaliste)
        exit_price  = close[t + horizon]   # clôture H barres plus tard
        net_return  = (exit_price - entry_price) / entry_price

        LONG    (2.0) : net_return >= tau_up
        SHORT   (0.0) : net_return <= tau_down
        NEUTRAL (1.0) : sinon
        NaN           : dernières *horizon* barres (pas de fenêtre future)

    Lève ValueError si horizon < 1, tau_up ≤ 0, tau_down ≥ 0.
    """
    opens  = df[open_col].to_numpy(dtype=float)
    closes = df[close_col].to_numpy(dtype=float)
    n      = len(df)
    labels = np.full(n, np.nan)

    for t in range(n - horizon):
        entry = opens[t + 1] if (t + 1) < n else np.nan
        exit_ = closes[t + horizon]

        if not (np.isfinite(entry) and np.isfinite(exit_)) or entry == 0:
            labels[t] = float(NEUTRAL_P1)
            continue

        net_ret = (exit_ - entry) / entry

        if net_ret >= tau_up:
            labels[t] = float(LONG)
        elif net_ret <= tau_down:
            labels[t] = float(SHORT)
        else:
            labels[t] = float(NEUTRAL_P1)

    labels[n - horizon:] = np.nan        # queue inconnaissable
    return pd.Series(labels, index=df.index, dtype=float)
```

### Autres fonctions du module

```python
def make_labels(df, horizon, price_col="close") -> pd.Series:
    # +1 (hausse) / -1 (baisse) / 0 (égal) / NaN (queue)

def create_labels(df, horizon, up_threshold, down_threshold,
                  price_col="close") -> pd.Series:
    # "UP" / "DOWN" / "NEUTRAL" / NaN  (seuils en rendement relatif)

def create_triple_barrier_labels(df, horizon, profit_target, stop_loss,
                                 price_col, high_col, low_col) -> pd.Series:
    # Premier barrier touché : profit_target → UP, stop_loss → DOWN
```

---

## 3 · `dataset_builder.py`

```python
def build_dataset(
    df: pd.DataFrame,
    horizon: int          = 5,
    tau_up: float         = 0.003,
    tau_down: float       = -0.003,
    feature_names         = None,
    symbol: str           = "UNKNOWN",
    timeframe: str        = "1m",
    output_dir: str       = None,
) -> Dict:
    """
    Pipeline complet données → dataset ML.

    Étapes
    ------
    1. dataset_hash  = SHA-256(df → parquet bytes)
    2. X_df          = build_features(df, feature_names)
    3. y_raw         = _compute_labels(df, horizon, tau_up, tau_down)
       → entry=open[t+1], exit=close[t+horizon], classes 0/1/2
    4. Alignement : index commun X ∩ y, suppression des NaN
    5. feature_schema_hash = MD5(sorted(feature_names))
    6. Sauvegarde Parquet si output_dir fourni :
       <symbol>_<timeframe>_<UTC>.parquet
    7. Retourne le dict ci-dessous.

    Retourne
    --------
    {
      "X":                   pd.DataFrame,   # zéro NaN
      "y":                   pd.Series,      # ∈ {0, 1, 2}
      "feature_names":       List[str],
      "feature_schema_hash": str,            # MD5
      "dataset_hash":        str,            # SHA-256
      "n_samples":           int,
      "label_distribution":  {
          "SHORT (0)": int,
          "NEUTRAL (1)": int,
          "LONG (2)": int,
      },
      "symbol":    str,
      "timeframe": str,
    }

    Lève ValueError si horizon<1, tau_up≤0, tau_down≥0.
    Lève KeyError si colonne OHLCV manquante.
    """

def load_dataset(parquet_path: str) -> Dict:
    """Recharge X, y, feature_names, n_samples depuis un fichier Parquet."""
```

---

## 4 · `train_pipeline.py`

### Constantes

```python
LABEL_CLASSES   = ["SHORT", "NEUTRAL", "LONG"]   # index = valeur label
LABEL_CLASS_MAP = {"SHORT": 0, "NEUTRAL": 1, "LONG": 2}
INV_LABEL_MAP   = {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"}

FEATURE_VERSION    = "p1_v1"
LABEL_SPEC_VERSION = "ls_v1"
```

### Grilles hyperparamètres

```python
XGB_PARAM_GRID = {
    "max_depth":        [3, 4, 5, 6],
    "learning_rate":    [0.01, 0.03, 0.05, 0.1],
    "n_estimators":     [200, 300, 400],
    "subsample":        [0.7, 0.8, 0.9],
    "colsample_bytree": [0.6, 0.7, 0.8],
    "min_child_weight": [3, 5, 7],
    "reg_lambda":       [0.5, 1.0, 2.0],
}

LGB_PARAM_GRID = {
    "max_depth":         [3, 4, 5, 6],
    "learning_rate":     [0.01, 0.03, 0.05, 0.1],
    "n_estimators":      [200, 300, 400],
    "num_leaves":        [15, 31, 63],
    "subsample":         [0.7, 0.8, 0.9],
    "colsample_bytree":  [0.6, 0.7, 0.8],
    "min_child_samples": [10, 20, 30],
    "reg_lambda":        [0.5, 1.0, 2.0],
}
```

### Fonction principale

```python
def train_pipeline(
    data_path: str,
    output_dir: str,
    symbol: str        = "*",
    horizon: int       = 20,
    up_threshold: float   = 0.005,
    down_threshold: float = -0.005,
    train_ratio: float    = 0.70,
    val_ratio: float      = 0.15,
    cv_splits: int        = 5,
    seed: int             = 42,
) -> dict:

    # ── 1. Chargement ────────────────────────────────────────────────
    df = pd.read_parquet(data_path).sort_index()
    dataset_hash = compute_dataframe_hash(df)

    # ── 2. Labels P1 ─────────────────────────────────────────────────
    y_raw = build_p1_labels(df, horizon, tau_up=up_threshold,
                            tau_down=down_threshold)
    df    = df.loc[y_raw.notna()]
    y_int = y_raw.dropna().astype(int).to_numpy()
    y     = np.array([LABEL_CLASSES[i] for i in y_int])

    # ── 3. Features 30 ───────────────────────────────────────────────
    X_df = build_features(df)                    # (n, 30)
    X_df = X_df[X_df.notna().all(axis=1)]
    X    = X_df.to_numpy(dtype=float)

    # ── 4. Split chronologique 70 / 15 / 15 ─────────────────────────
    n         = len(X)
    train_end = int(n * 0.70)
    val_end   = int(n * 0.85)
    # Anti-leakage :
    assert timestamps[train_end-1] < timestamps[train_end]
    assert timestamps[val_end-1]   < timestamps[val_end]
    assert val_end - train_end >= horizon

    X_train, y_int_train = X[:train_end],          y_int[:train_end]
    X_val,   y_int_val   = X[train_end:val_end],   y_int[train_end:val_end]
    X_test,  y_int_test  = X[val_end:],            y_int[val_end:]

    # ── 5. Logistic Regression (baseline) ───────────────────────────
    lr = LogisticRegression(
        max_iter=2000, solver="lbfgs",
        # multi_class removed — deprecated/removed in scikit-learn 1.7+;
        # lbfgs solves multinomial automatically.
        class_weight="balanced",          # ← équilibrage classes
        C=1.0, random_state=seed,
    )
    lr.fit(X_train, y_int_train)

    # ── 6. XGBoost — recherche HP ────────────────────────────────────
    cv = TimeSeriesSplit(n_splits=5, gap=horizon)
    xgb_search = HalvingRandomSearchCV(       # fallback RandomizedSearchCV
        XGBClassifier(objective="multi:softprob",
                      num_class=3, verbosity=0),
        param_distributions=XGB_PARAM_GRID,
        cv=cv, scoring="roc_auc_ovr",
        n_iter=20, random_state=seed,
    )
    xgb_search.fit(X_train, y_int_train)
    xgb = xgb_search.best_estimator_

    # ── 7. LightGBM — recherche HP ───────────────────────────────────
    lgb_search = HalvingRandomSearchCV(
        LGBMClassifier(objective="multiclass", num_class=3, verbose=-1),
        param_distributions=LGB_PARAM_GRID,
        cv=cv, scoring="roc_auc_ovr",
        n_iter=20, random_state=seed,
    )
    lgb_search.fit(X_train, y_int_train)
    lgb = lgb_search.best_estimator_

    # ── 8. Sélection champion (ROC-AUC val) ──────────────────────────
    best_model_name = max(val_metrics,
                          key=lambda k: val_metrics[k]["roc_auc"] or 0.0)

    # ── 9. Artefacts sauvegardés ─────────────────────────────────────
    # logistic_baseline.pkl
    # xgb_champion.json
    # lgb_challenger.txt
    # model_metadata.json   ← métadonnées complètes
    # metrics.json          ← métriques test
    # feature_schema.json   ← catalogue features
    # metadata.json         ← alias model_metadata.json
    # model_card.md         ← fiche modèle en Markdown

    # ── 10. Registry SQLite ──────────────────────────────────────────
    try:
        registry_service.register_and_promote(
            model_type=best_model_name, symbol=symbol,
            artifact_path=..., metrics=test_metrics,
            feature_names=feature_names,
            feature_schema_hash=feature_schema_hash,
            dataset_hash=dataset_hash, git_sha=git_sha,
            label_definition=metadata["label_definition"],
        )
    except Exception:
        pass   # registry failure ne bloque jamais le pipeline
```

### Métriques calculées

```python
# metrics.py → evaluate_classification_metrics(y_true, y_pred, y_proba)
{
    "roc_auc":          float,   # OVR macro
    "f1_macro":         float,
    "brier_score":      float,   # OvR sur classe LONG
    "confusion_matrix": [[int]], # 3×3
    "per_class": {
        "SHORT":   {"precision": float, "recall": float, "f1": float, "support": int},
        "NEUTRAL": {...},
        "LONG":    {...},
    },
    "calibration_curve": {
        "prob_true": [float],
        "prob_pred": [float],
        "class": "LONG",
    },
    "n_samples": int,
}
```

---

## 5 · `registry/registry.py` — SQLite ModelRegistry

### Schéma (5 tables)

```sql
CREATE TABLE MODEL_VERSION (
    id                    TEXT PRIMARY KEY,   -- uuid4
    model_type            TEXT NOT NULL,      -- xgb | lgb | logistic
    symbol                TEXT NOT NULL DEFAULT '*',
    status                TEXT NOT NULL DEFAULT 'registered',
    -- registered | trained | champion | challenger | archived
    artifact_path         TEXT NOT NULL DEFAULT '',
    metrics_json          TEXT NOT NULL DEFAULT '{}',
    feature_schema_hash   TEXT NOT NULL DEFAULT '',
    dataset_hash          TEXT NOT NULL DEFAULT '',
    git_sha               TEXT NOT NULL DEFAULT '',
    feature_names_json    TEXT NOT NULL DEFAULT '[]',
    label_definition_json TEXT NOT NULL DEFAULT '{}',
    notes                 TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE TABLE TRAIN_RUN (
    id               TEXT PRIMARY KEY,
    model_version_id TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'running',
    config_json      TEXT NOT NULL DEFAULT '{}',
    metrics_json     TEXT NOT NULL DEFAULT '{}',
    started_at       TEXT NOT NULL,
    completed_at     TEXT,
    FOREIGN KEY (model_version_id) REFERENCES MODEL_VERSION(id)
);

CREATE TABLE FEATURE_SCHEMA (
    hash               TEXT PRIMARY KEY,
    feature_names_json TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
);

CREATE TABLE DATASET_VERSION (
    id            TEXT PRIMARY KEY,
    symbol        TEXT NOT NULL,
    timeframe     TEXT NOT NULL DEFAULT '1m',
    dataset_hash  TEXT NOT NULL,
    parquet_path  TEXT NOT NULL DEFAULT '',
    row_count     INTEGER NOT NULL DEFAULT 0,
    feature_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE TABLE MODEL_CARD (
    model_version_id TEXT PRIMARY KEY,
    card_markdown    TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    FOREIGN KEY (model_version_id) REFERENCES MODEL_VERSION(id)
);
```

### API Python

```python
class ModelRegistry:

    def initialize(self):
        """Crée les tables (idempotent — IF NOT EXISTS)."""

    def register_model(
        self, model_type, symbol, artifact_path,
        feature_names, feature_schema_hash, dataset_hash,
        git_sha="", metrics={}, label_definition={}, notes="",
    ) -> str:
        """Insère MODEL_VERSION + upsert FEATURE_SCHEMA. Retourne l'uuid."""

    def promote_champion(self, model_id: str):
        """
        Atomique :
          1. ancien champion → status = 'challenger'
          2. model_id       → status = 'champion'
        Lève ValueError si model_id inexistant.
        """

    def get_champion(self, symbol: str = None) -> dict | None:
        """Retourne le champion (filtre symbol optionnel) ou None."""

    def get_model(self, model_id: str) -> dict | None

    def list_models(self, symbol=None, status=None) -> List[dict]

    def log_train_run(
        self, model_id, config={}, metrics={}, status="completed"
    ) -> str:
        """Enregistre un run d'entraînement. Retourne run_id."""

    def record_dataset_version(
        self, symbol, timeframe, dataset_hash,
        parquet_path="", row_count=0, feature_count=0,
    ) -> str

    def write_model_card(self, model_id: str, card_markdown: str)

    def get_model_card(self, model_id: str) -> str | None


# Singleton module-level
registry = ModelRegistry()   # DB = ML_REGISTRY_DB env var ou registry.db
```

### `registry_service.py`

```python
class RegistryService:
    def register_and_promote(
        self, model_type, symbol, artifact_path, metrics,
        feature_names, feature_schema_hash, dataset_hash,
        git_sha, label_definition, notes="",
    ) -> str:
        model_id = self._reg.register_model(...)
        self._reg.promote_champion(model_id)
        return model_id

    def log_training_run(self, model_id, config, metrics,
                         status="completed") -> str

    def get_champion_info(self, symbol=None) -> dict | None

    def list_recent_runs(self, limit=20) -> List[dict]


registry_service = RegistryService()   # singleton
```

---

## 6 · `inference/infer_worker.py` — Subprocess persistant

### Protocole JSON-Lines

```
stdin  ← requête JSON (une ligne)
stdout → réponse JSON (une ligne)
stderr → logs diagnostics (ignoré par le parent)
```

### Startup

```python
# Première ligne stdout après chargement du modèle :
{"ready": true, "model_version": "xgb@p1_v1", "loaded_at": "2026-05-31T..."}

# Si le modèle ne peut pas être chargé :
{"ready": false, "error": "...", "code": "FileNotFoundError"}
# → exit(1)
```

### Requête / Réponse

```python
# Requête (stdin) :
{
    "request_id":    "uuid4",
    "features":      {"ret_1": 0.0012, "atr": 0.0045, ...},
    "feature_names": ["ret_1", "atr", "rvol", ...],   # ordre du modèle
    "inv_label_map": {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"}
}

# Réponse succès (stdout) :
{
    "request_id":    "uuid4",
    "ok":            true,
    "signal":        "LONG",
    "probability":   0.712,
    "confidence":    0.712,
    "probabilities": {"SHORT": 0.091, "NEUTRAL": 0.197, "LONG": 0.712},
    "latency_ms":    3.2
}

# Réponse erreur (stdout) :
{
    "request_id": "uuid4",
    "ok":         false,
    "error":      "Feature 'ret-1' invalid name",
    "code":       "ValidationError"
}
```

### Validation entrée

```python
_FEATURE_NAME_RE = re.compile(r"^[a-zA-Z0-9_]{1,64}$")
_MAX_FEATURES    = 256

def _validate_request(payload: dict):
    # Clés requises : request_id, features, feature_names, inv_label_map
    # request_id     : str non vide
    # features       : dict, valeurs float finies (pas NaN, pas Inf)
    # feature_names  : list, chaque nom ∈ [a-zA-Z0-9_]{1,64}
    # len(feature_names) ≤ 256
```

### Inférence

```python
def _run_inference(model_type, model, feature_names, features, inv_label_map):
    # Alignement : vecteur ordonné selon feature_names
    # Feature manquante → 0.0
    vec = np.array([float(features.get(name, 0.0))
                    for name in feature_names]).reshape(1, -1)

    # Prédiction selon format du modèle
    if model_type == "xgb":
        proba = xgb.DMatrix(vec) → model.predict(dm)
    elif model_type == "lgb":
        proba = model.predict(vec)
    else:  # sklearn
        proba = model.predict_proba(vec)[0]

    # Normalisation (garde contre dérive flottante)
    proba /= proba.sum()

    pred_idx   = int(np.argmax(proba))
    confidence = round(float(proba[pred_idx]), 6)
    signal     = inv_label_map.get(str(pred_idx), str(pred_idx))
    probabilities = {inv_label_map.get(str(i), str(i)): round(float(p), 6)
                     for i, p in enumerate(proba)}

    return signal, confidence, confidence, probabilities
```

### Chargement du modèle

```python
def _load_champion() -> (model_type, model, metadata):
    # Lit model_metadata.json
    # best_model → "xgb" | "lgb" | "logistic"
    # Carte d'extension :
    #   "xgb"      → xgb_champion.json   → xgb.Booster
    #   "lgb"      → lgb_challenger.txt  → lgb.Booster
    #   "logistic" → logistic_baseline.pkl → joblib
```

---

## 7 · `inference/prediction_service.py`

```python
class PredictionService:
    """
    Gère le cycle de vie du subprocess infer_worker.py.
    Redémarre automatiquement si le worker plante (max MAX_RESTARTS fois).
    """

    def __init__(self, worker_script=None, model_dir=None,
                 timeout_ms=400, max_restarts=3):
        self._worker_script = worker_script or _DEFAULT_WORKER_SCRIPT
        self._timeout_ms    = timeout_ms
        self._max_restarts  = max_restarts
        self._proc          = None
        self._ready         = False
        self._lock          = threading.Lock()
        # Thread lecteur stdout
        self._stdout_thread = None
        # Thread watchdog
        self._watchdog_thread = None
        self._pending: Dict[str, queue.Queue] = {}

    def predict(self, request: dict, timeout_ms: int = None) -> dict:
        """
        Envoie une requête au worker et attend la réponse.
        Génère automatiquement un request_id si absent.
        Lève TimeoutError si > timeout_ms ms.
        Lève RuntimeError si le worker est mort.
        """

    def health(self) -> dict:
        """
        {
          "ok": bool,
          "workerAlive": bool,
          "pid": int | None,
          "restarts": int,
          "totalRequests": int,
          "errors": int,
        }
        """

    def shutdown(self):
        """Ferme stdin → SIGTERM → rejette toutes les requêtes en attente."""
```

---

## 8 · `monitoring/drift_monitor.py`

```python
PSI_THRESHOLDS = {"stable": 0.1, "moderate": 0.2}
# PSI < 0.10 → stable
# PSI < 0.20 → surveillance modérée
# PSI ≥ 0.20 → drift significatif

def compute_psi(expected: np.ndarray, actual: np.ndarray,
                n_bins: int = 10) -> float:
    """
    PSI = Σ (actual_pct - expected_pct) × ln(actual_pct / expected_pct)
    Retourne 0.0 si l'une des distributions est vide ou constante.
    """

def monitor_feature_drift(
    reference_X: pd.DataFrame,
    current_X:   pd.DataFrame,
    feature_names: List[str],
) -> Dict[str, Dict]:
    """
    Retourne pour chaque feature :
    { "psi": float, "status": "stable"|"moderate"|"high" }
    """

def monitor_prediction_drift(
    reference_preds: np.ndarray,
    current_preds:   np.ndarray,
    class_labels:    List[str] = None,
) -> dict:
    """
    Calcule le PSI sur la distribution des prédictions.
    Retourne { "overall_psi": float, "status": str, "per_class": {...} }
    """

class DriftMonitor:
    def set_reference(self, X: pd.DataFrame, feature_names: List[str])
    def check(self, X: pd.DataFrame, feature_names: List[str]) -> dict:
        """Rapport complet avec timestamp ISO."""
    def summary(self) -> dict
```

---

## 9 · `monitoring/metrics_monitor.py`

```python
@dataclass
class InferenceRecord:
    request_id: str
    symbol:     str
    signal:     str        # "SHORT" | "NEUTRAL" | "LONG" | ""
    latency_ms: float
    error:      bool
    timestamp:  str = field(default_factory=lambda: datetime.utcnow().isoformat())

class MetricsMonitor:

    def record(self, record: InferenceRecord):
        """Enregistre une inférence (thread-safe)."""

    def latency_percentiles(self) -> dict:
        """{"p50": float, "p95": float, "p99": float, "mean": float}"""

    def error_rate(self) -> float:
        """Taux d'erreur ∈ [0.0, 1.0]. Retourne 0.0 si aucun enregistrement."""

    def prediction_distribution(self) -> dict:
        """{"SHORT": float, "NEUTRAL": float, "LONG": float} — proportions."""

    def prometheus_text(self) -> str:
        """
        Format Prometheus 0.0.4 (text/plain).
        Métriques exposées :
          ml_inference_latency_ms{quantile="0.50|0.95|0.99"}
          ml_inference_requests_total
          ml_inference_errors_total
          ml_inference_error_rate
          ml_prediction_distribution{signal="SHORT|NEUTRAL|LONG"}
        """

    def to_dict(self) -> dict:
        """Sérialisation JSON complète."""


metrics_monitor = MetricsMonitor()   # singleton
```

---

## 10 · Tests (219 passants)

### `test_labels.py` — 36 tests

```python
class TestMakeLabels:          # make_labels() : +1/-1/0/NaN
class TestCreateLabels:        # create_labels() : UP/DOWN/NEUTRAL
class TestRefBuildP1Labels:    # implémentation de référence locale
class TestRealBuildP1LabelsParity:  # parité avec label_builder.build_p1_labels
    @pytest.mark.parametrize("seed", [0, 7, 42, 99])
    def test_matches_reference_random(self, seed):
        # build_p1_labels == référence sur données aléatoires

    @pytest.mark.parametrize("horizon", [1, 5, 10])
    def test_real_parametrize_horizons(self, horizon):
        # Derniers *horizon* labels = NaN
```

### `test_training.py` — 29 tests

```python
class TestFeatureBuilder:      # 10 tests
    def test_all_features_present     # 30 colonnes exactes
    def test_no_future_data           # X50.iloc[49] == X51.iloc[49]
    def test_fallback_zero_for_missing_cols   # optionnelles → 0.0
    def test_session_features         # hour_sin varie avec DatetimeIndex
    def test_session_features_range_index_zero  # → 0.0 sans DatetimeIndex
    def test_atr_always_positive
    def test_volume_features_with_zero_volume   # ne plante pas
    def test_subset_feature_names     # sélection sous-ensemble
    def test_unknown_feature_name_raises
    def test_missing_required_column_raises

class TestDatasetBuilder:      # 10 tests
    def test_x_y_aligned
    def test_no_nan_in_final_dataset
    def test_label_distribution_in_output
    def test_feature_names_in_output
    def test_n_samples_consistent
    def test_y_contains_only_valid_labels   # ∈ {0, 1, 2}
    def test_invalid_horizon_raises
    def test_invalid_tau_up_raises
    def test_invalid_tau_down_raises
    def test_dataset_hash_reproducible

class TestTimeSeriesSplitGap:  # 9 tests
    @pytest.mark.parametrize("horizon", [1, 5, 10, 20])
    def test_gap_enforcement:
        # Pour chaque fold : test_start - train_end - 1 >= horizon
    def test_n_splits_count
    def test_no_train_test_overlap
    def test_chronological_order
    def test_gap_attribute_matches_horizon
    def test_train_sets_grow_monotonically
```

### `test_inference.py` — 39 tests

```python
class TestInferWorkerValidation:  # 10 tests
    # Clés manquantes, request_id vide, features non-dict,
    # trop de features, nom invalide, valeur non-finie, NaN

class TestPSIComputation:         # 10 tests
    # PSI ≈ 0 distributions identiques, PSI élevé si distribution décalée,
    # non-négatif, arrays vides, feature constante, filtre NaN

class TestMetricsMonitor:         # 8 tests
    # Percentiles après 100 enregistrements, taux d'erreur 20%,
    # distribution somme=1, format Prometheus, valeurs sûres si vide

class TestInferPyBridge:          # 11 tests
    # Roundtrip subprocess avec LogisticRegression encodé en base64,
    # probabilities sum=1, latencyMs présent, cas d'erreur
```

### `test_model_registry.py` — 20 tests

```python
class TestModelRegistryInit:    # 3 tests : tables créées, idempotent, chemin custom
class TestRegisterModel:        # 5 tests : uuid, ligne créée, status, FEATURE_SCHEMA
class TestPromoteChampion:      # 5 tests : champion, démote précédent, inexistant
class TestTrainRun:             # 4 tests : uuid, ligne créée, id invalide, list
class TestDatasetAndCard:       # 3 tests : record_dataset, write_card, get_card None
```

---

## 11 · CLI — `train_pipeline.py`

```bash
python server/ai/training/train_pipeline.py \
    --data          server/ai/datasets/snapshot.parquet \
    --output        server/ai/models \
    --symbol        BTCUSDT \
    --horizon       20 \
    --up-threshold  0.005 \
    --down-threshold -0.005 \
    --train-ratio   0.70 \
    --val-ratio     0.15 \
    --cv-splits     5 \
    --seed          42
```

**Sorties dans `--output` :**

```
logistic_baseline.pkl    # joblib LogisticRegression
xgb_champion.json        # XGBoost Booster (best HP)
lgb_challenger.txt       # LightGBM Booster (best HP)
model_metadata.json      # métadonnées complètes (features, métriques, hashes)
metrics.json             # métriques test uniquement
feature_schema.json      # catalogue JSON des 30 features
metadata.json            # alias de model_metadata.json
model_card.md            # fiche modèle Markdown générée automatiquement
```

---

## 12 · Lancer les tests

```bash
# Depuis la racine du repo
python3 -m pytest tests/ server/ai/tests/ -v

# Résultat attendu
219 passed, 2 warnings
```

| Suite | Fichier | Tests |
|---|---|---|
| Labels | `server/ai/tests/test_labels.py` | 36 |
| Training | `server/ai/tests/test_training.py` | 29 |
| Inference | `server/ai/tests/test_inference.py` | 39 |
| Registry | `server/ai/tests/test_model_registry.py` | 20 |
| Spécification | `tests/test_cases_table.py` | 95 |
| **Total** | | **219** |
