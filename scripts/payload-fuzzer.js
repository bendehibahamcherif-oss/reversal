#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.PAYLOAD_FUZZER_PORT || 18102);
const baseUrl = process.env.API_BASE_LOCAL || `http://127.0.0.1:${port}`;
const startedByFuzzer = !process.env.API_BASE_LOCAL;
const timeoutMs = Number(process.env.PAYLOAD_FUZZER_TIMEOUT_MS || 12000);
const cases = [
  ['/api/macro/correlation?symbols=SPY,NFLX&datasetIds=__missing_a__,__missing_b__&window=20', 'GET'],
  ['/api/macro/beta?asset=NFLX&benchmark=SPY&symbols=SPY,NFLX&datasetIds=__missing_a__,__missing_b__&window=20', 'GET'],
  ['/api/macro/correlation?symbols=&datasetIds=&window=-1', 'GET'],
  ['/api/historical/use-for-correlation', 'POST', {}],
  ['/api/backtest/run', 'POST', { symbol: '', datasetId: '__missing__' }],
  ['/api/ml/train', 'POST', { symbol: 'SPY', timeframe: '1d', horizon: 1, datasetId: '__missing__' }],
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
}
function hasBadToken(text) { return /(?<![\w"])(NaN|-?Infinity|undefined)(?![\w"])/.test(text); }
async function call([url, method, body]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const errors = [];
  try {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { errors.push('invalid_json'); }
    if (!/application\/json/i.test(contentType)) errors.push('non_json_content_type');
    if (/^\s*(<!doctype|<html)/i.test(text)) errors.push('html_response');
    if (response.status >= 500) errors.push(`server_error_${response.status}`);
    if (hasBadToken(text)) errors.push('non_finite_or_undefined_token');
    if (!json || (!Object.hasOwn(json, 'ok') && !Object.hasOwn(json, 'success'))) errors.push('missing_ok_or_success');
    return { method, url, status: response.status, contentType, preview: text.slice(0, 500), errors };
  } catch (err) {
    return { method, url, status: null, contentType: null, preview: '', errors: [err.name === 'AbortError' ? 'timeout' : `network_error:${err.message}`] };
  } finally {
    clearTimeout(timer);
  }
}

let child = null;
async function main() {
  if (startedByFuzzer) {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    if (!(await waitForServer())) throw new Error('local backend did not become healthy');
  }
  const results = [];
  for (const item of cases) results.push(await call(item));
  const failing = results.filter((result) => result.errors.length);
  const output = { ok: failing.length === 0, generatedAt: new Date().toISOString(), baseUrl, total: results.length, failingCount: failing.length, results };
  await writeFile(path.join(root, 'PAYLOAD_FUZZER_RESULTS.json'), JSON.stringify(output, null, 2));
  if (failing.length) {
    console.error(`Payload fuzzer failed: ${failing.length}/${results.length}`);
    for (const result of failing) console.error(`${result.method} ${result.url}: ${result.errors.join(', ')}`);
    process.exit(1);
  }
  console.log(`Payload fuzzer passed: ${results.length} malformed payloads returned JSON-safe responses.`);
}
main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { if (child) child.kill('SIGTERM'); });
