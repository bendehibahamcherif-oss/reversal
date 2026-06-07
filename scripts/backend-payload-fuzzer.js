#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.PAYLOAD_FUZZ_PORT || 18102);
const baseUrl = process.env.PAYLOAD_FUZZ_BASE_URL || `http://127.0.0.1:${port}`;
const startedByFuzzer = !process.env.PAYLOAD_FUZZ_BASE_URL;
const timeoutMs = Number(process.env.PAYLOAD_FUZZ_TIMEOUT_MS || 10000);
const preciseStatuses = new Set(['dataset_required','dataset_not_found','dataset_file_missing','dataset_file_empty','dataset_csv_missing','dataset_not_usable_for_target','symbol_required','invalid_symbol','invalid_provider','model_not_found','no_champion_model','feature_vector_required','invalid_payload','validation_error','missing_credentials','unknown_provider','NO_PROVIDER_SELECTED','not_enough_data','training_failed','python_dependency_missing','invalid_purpose']);

const endpoints = [
  ['POST', '/api/historical/download'], ['POST', '/api/historical/use-for-ml'], ['POST', '/api/historical/use-for-backtest'], ['POST', '/api/historical/use-for-correlation'],
  ['POST', '/api/ml/train'], ['POST', '/api/ml/promote/__missing_model__'], ['POST', '/api/ml/infer/SPY'], ['POST', '/api/backtest/run'],
  ['POST', '/api/providers/active'], ['POST', '/api/providers/credentials/__invalid_provider__'],
];
const cases = [
  ['missing_body', undefined], ['empty_body', {}], ['null_body', null], ['datasetId_undefined_string', { datasetId: 'undefined', symbol: 'SPY' }], ['datasetId_null', { datasetId: null, symbol: 'SPY' }],
  ['unknown_datasetId', { datasetId: '__unknown_dataset__', symbol: 'SPY' }], ['symbol_undefined_string', { symbol: 'undefined' }], ['symbol_null', { symbol: null }], ['symbol_lowercase', { symbol: 'spy' }], ['symbol_empty', { symbol: '' }],
  ['symbols_empty', { symbols: [] }], ['symbols_string', { symbols: 'SPY,QQQ', provider: 'yahoo', timeframe: '1d' }], ['malformed_dates', { symbols: ['SPY'], provider: 'yahoo', startDate: 'not-a-date', endDate: 'also-bad' }],
  ['bad_timeframe', { symbols: ['SPY'], provider: 'yahoo', timeframe: 'bad' }], ['fallback_demo', { datasetId: 'fallback_demo', provider: 'fallback_demo', symbols: ['SPY'], symbol: 'SPY' }],
  ['modelId_unknown', {}], ['invalid_provider', { providers: ['does_not_exist'], providerOrder: ['does_not_exist'], apiKey: 'x' }],
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer() { for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`${baseUrl}/health`)).ok) return true; } catch {} await wait(250); } return false; }
function hasNonFiniteToken(text) { return /(?<![\w"])(NaN|-?Infinity|undefined)(?![\w"])/.test(text); }
function looksLikeHtml(text, ct) { return /text\/html/i.test(ct) || /^\s*(<!doctype|<html)/i.test(text); }
function extractStatus(body) { return body?.status || body?.error?.code || body?.code || (body?.ok === true || body?.success === true ? 'accepted' : null); }
async function fuzzOne(method, urlPath, caseName, body) {
  if (urlPath === '/api/historical/download' && body && typeof body === 'object') {
    const hasSymbol = Boolean(body.symbol || (Array.isArray(body.symbols) ? body.symbols.length : body.symbols));
    if (hasSymbol && !['symbols_empty', 'bad_timeframe', 'malformed_dates', 'fallback_demo'].includes(caseName)) body = { ...body, provider: 'does_not_exist' };
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const startedAt = Date.now(); const errors = [];
  try {
    const init = { method, headers: { accept: 'application/json' }, signal: controller.signal };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetch(`${baseUrl}${urlPath}`, init); const ct = response.headers.get('content-type') || ''; const text = await response.text();
    let parsed = null; let validJson = false; try { parsed = text ? JSON.parse(text) : null; validJson = text.length > 0; } catch { errors.push('invalid_json'); }
    if (looksLikeHtml(text, ct)) errors.push('html_response');
    if (!/application\/json/i.test(ct)) errors.push('non_json_content_type');
    if (response.status >= 500) errors.push('server_error');
    if (hasNonFiniteToken(text)) errors.push('non_finite_or_undefined_token');
    const status = extractStatus(parsed);
    if (response.status >= 400 && !preciseStatuses.has(status)) errors.push(`imprecise_status:${status ?? 'missing'}`);
    return { method, url: urlPath, case: caseName, httpStatus: response.status, contentType: ct, validJson, status, preview: text.slice(0, 400), durationMs: Date.now() - startedAt, errors };
  } catch (err) {
    return { method, url: urlPath, case: caseName, httpStatus: null, contentType: null, validJson: false, status: null, preview: '', durationMs: Date.now() - startedAt, errors: [err.name === 'AbortError' ? 'timeout' : `network_error:${err.message}`] };
  } finally { clearTimeout(timer); }
}
let child = null;
async function main() {
  if (startedByFuzzer) { child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RATE_LIMIT_MAX: '10000', RATE_LIMIT_STRICT_MAX: '10000' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`)); child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`)); if (!(await waitForServer())) throw new Error('local backend did not become healthy'); }
  const results = [];
  for (const [method, endpoint] of endpoints) for (const [caseName, body] of cases) results.push(await fuzzOne(method, endpoint, caseName, body));
  const failing = results.filter((r) => r.errors.length);
  const output = { ok: failing.length === 0, generatedAt: new Date().toISOString(), baseUrl, total: results.length, failingCount: failing.length, results };
  await writeFile(path.join(root, 'BACKEND_PAYLOAD_FUZZ_RESULTS.json'), JSON.stringify(output, null, 2));
  if (failing.length) { console.error(`Payload fuzzer failed: ${failing.length}/${results.length}`); for (const r of failing.slice(0, 40)) console.error(`${r.method} ${r.url} ${r.case}: ${r.errors.join(', ')}`); process.exit(1); }
  console.log(`Payload fuzzer passed: ${results.length} malformed payloads stayed JSON-safe.`);
}
main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { if (child) child.kill('SIGTERM'); });
