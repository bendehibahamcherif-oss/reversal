import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRAIN_SCRIPT  = path.join(__dirname, 'ml', 'train.py');
const INFER_SCRIPT  = path.join(__dirname, 'ml', 'infer.py');
const TIMEOUT_MS    = 60_000;
const PYTHON_BIN    = process.env.PYTHON_BIN || 'python3';

function runScript(scriptPath, inputPayload) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; proc.kill('SIGKILL'); reject(new Error(`ML script timed out after ${TIMEOUT_MS}ms`)); }
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (errChunks.length) process.stderr.write(`[mlBridge] ${scriptPath}: ${Buffer.concat(errChunks).toString('utf-8')}`);
      try {
        const result = JSON.parse(raw);
        resolve(result);
      } catch {
        reject(new Error(`ML script returned non-JSON (exit ${code}): ${raw.slice(0, 300)}`));
      }
    });

    proc.on('error', (err) => { done = true; clearTimeout(timer); reject(err); });

    const json = JSON.stringify(inputPayload);
    proc.stdin.write(json);
    proc.stdin.end();
  });
}

export async function trainModel({ trainRows, valRows, testRows, featureNames, modelType = 'XGBoost', horizon = 5, params = {} }) {
  const payload = {
    train_features: trainRows.map((r) => featureNames.map((n) => Number(r.features?.[n] ?? 0))),
    train_labels:   trainRows.map((r) => r.label),
    val_features:   valRows.map((r)   => featureNames.map((n) => Number(r.features?.[n] ?? 0))),
    val_labels:     valRows.map((r)   => r.label),
    test_features:  testRows.map((r)  => featureNames.map((n) => Number(r.features?.[n] ?? 0))),
    test_labels:    testRows.map((r)  => r.label),
    feature_names:  featureNames,
    model_type:     modelType,
    horizon,
    params,
  };

  const result = await runScript(TRAIN_SCRIPT, payload);
  if (!result.ok) throw new Error(`Train script error: ${result.error}`);
  return result;
}

export async function runInference({ modelB64, featureRow, featureNames, labelMap, invLabelMap }) {
  const payload = {
    model_b64:     modelB64,
    features:      featureNames.map((n) => Number(featureRow?.[n] ?? 0)),
    feature_names: featureNames,
    label_map:     labelMap,
    inv_label_map: invLabelMap,
  };

  const result = await runScript(INFER_SCRIPT, payload);
  if (!result.ok) throw new Error(`Infer script error: ${result.error}`);
  return result;
}
