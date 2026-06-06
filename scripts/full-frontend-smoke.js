#!/usr/bin/env node
/**
 * Frontend source smoke.
 * If the sibling/embedded frontend repo is present, this fails on stale ML
 * endpoints, undefined dataset path builders, and missing workspace registry
 * exports. If it is absent in this checkout, it records an explicit unavailable
 * result so release reports cannot pretend frontend source was validated here.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

const candidates = [
  process.env.FRONTEND_REPO,
  'intraday-reversal-engine',
  '../intraday-reversal-engine',
  'frontend',
].filter(Boolean);

const forbiddenEndpointPatterns = [
  { name: 'stale_ai_ml_lifecycle', re: /['"`]\/api\/ai\/(?:ml|models|champion|inference)[^'"`]*/g },
  { name: 'stale_ml_champion', re: /['"`]\/api\/ml\/champion[^'"`]*/g },
  { name: 'ai_models_champion', re: /['"`]\/api\/ai\/models\/[^'"`]+\/champion[^'"`]*/g },
  { name: 'undefined_path_param', re: /\/api\/[^'"`]*\$\{\s*(?:datasetId|symbol)\s*\}/g },
];

const requiredCanonicalSnippets = [
  '/api/ml/model',
  '/api/ml/model-runs',
  '/api/ml/promote/',
  '/api/ml/infer/',
  '/api/historical/use-for-ml',
  '/api/historical/use-for-backtest',
  '/api/historical/use-for-correlation',
  '/api/backtest/run',
  '/api/macro/correlation',
  '/api/macro/beta',
];

async function existsDir(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function hasPackageJson(path) {
  try { return (await stat(join(path, 'package.json'))).isFile(); } catch { return false; }
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '.git', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function main() {
  let frontendRoot = null;
  for (const candidate of candidates) {
    if (candidate && await existsDir(candidate) && await hasPackageJson(candidate)) {
      frontendRoot = candidate;
      break;
    }
  }
  if (!frontendRoot) {
    const payload = {
      ok: true,
      status: 'frontend_repo_unavailable',
      frontendRepoAvailable: false,
      message: 'No intraday-reversal-engine frontend repository is present in this checkout; source-level frontend smoke could not be executed here.',
      generatedAt: new Date().toISOString(),
      checkedCandidates: candidates,
      results: [],
    };
    await writeFile('FULL_FRONTEND_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ ok: payload.ok, status: payload.status }, null, 2));
    return;
  }

  const files = await walk(frontendRoot);
  const findings = [];
  const allTextParts = [];
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    allTextParts.push(text);
    for (const pattern of forbiddenEndpointPatterns) {
      for (const match of text.matchAll(pattern.re)) {
        findings.push({ ok: false, type: pattern.name, file: relative(frontendRoot, file), match: match[0] });
      }
    }
    if (/\bNaN\b|\bInfinity\b/.test(text) && !/Number\.isFinite|isFinite|Number\.isNaN/.test(text)) {
      findings.push({ ok: false, type: 'unsafe_non_finite_render_risk', file: relative(frontendRoot, file) });
    }
  }

  const allText = allTextParts.join('\n');
  const canonicalPresence = requiredCanonicalSnippets.map((snippet) => ({ snippet, present: allText.includes(snippet) }));
  const workspaceRegistryPresent = /workspaceRegistry|WORKSPACES|workspaceDefinitions|activeWorkspace/.test(allText);
  if (!workspaceRegistryPresent) findings.push({ ok: false, type: 'workspace_registry_not_detected' });

  const payload = {
    ok: findings.length === 0,
    status: findings.length === 0 ? 'passed' : 'failed',
    frontendRepoAvailable: true,
    frontendRoot,
    generatedAt: new Date().toISOString(),
    summary: { filesScanned: files.length, findings: findings.length },
    canonicalPresence,
    results: findings,
  };
  await writeFile('FULL_FRONTEND_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (!payload.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  await writeFile('FULL_FRONTEND_SMOKE_RESULTS.json', `${JSON.stringify({ ok: false, status: 'error', error: error.message }, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
});
