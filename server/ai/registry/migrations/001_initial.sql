-- ML Signal Engine — initial registry schema
-- Migration 001

CREATE TABLE IF NOT EXISTS MODEL_VERSION (
    id                    TEXT PRIMARY KEY,
    model_type            TEXT NOT NULL,
    symbol                TEXT NOT NULL DEFAULT '*',
    status                TEXT NOT NULL DEFAULT 'registered',
    -- status: registered | trained | champion | challenger | archived
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

CREATE TABLE IF NOT EXISTS TRAIN_RUN (
    id               TEXT PRIMARY KEY,
    model_version_id TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'running',
    -- status: running | completed | failed
    config_json      TEXT NOT NULL DEFAULT '{}',
    metrics_json     TEXT NOT NULL DEFAULT '{}',
    started_at       TEXT NOT NULL,
    completed_at     TEXT,
    FOREIGN KEY (model_version_id) REFERENCES MODEL_VERSION(id)
);

CREATE TABLE IF NOT EXISTS FEATURE_SCHEMA (
    hash               TEXT PRIMARY KEY,
    feature_names_json TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS DATASET_VERSION (
    id           TEXT PRIMARY KEY,
    symbol       TEXT NOT NULL,
    timeframe    TEXT NOT NULL DEFAULT '1m',
    dataset_hash TEXT NOT NULL,
    parquet_path TEXT NOT NULL DEFAULT '',
    row_count    INTEGER NOT NULL DEFAULT 0,
    feature_count INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS MODEL_CARD (
    model_version_id TEXT PRIMARY KEY,
    card_markdown    TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    FOREIGN KEY (model_version_id) REFERENCES MODEL_VERSION(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_model_version_symbol  ON MODEL_VERSION(symbol);
CREATE INDEX IF NOT EXISTS idx_model_version_status  ON MODEL_VERSION(status);
CREATE INDEX IF NOT EXISTS idx_model_version_created ON MODEL_VERSION(created_at);
CREATE INDEX IF NOT EXISTS idx_train_run_model       ON TRAIN_RUN(model_version_id);
CREATE INDEX IF NOT EXISTS idx_dataset_symbol        ON DATASET_VERSION(symbol);
