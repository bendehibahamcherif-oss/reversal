#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_ROUTES } from './backend-contract-routes.js';

const root = process.cwd();
const runtimePath = path.join(root, 'server/bootstrap/runtimeIntegration.js');
const serverPath = path.join(root, 'server.js');

function normalizeRoute(route) {
  if (!route || route === '/') return '';
  return route.replace(/\/+/g, '/').replace(/\/$/, '').replace(/:id\b/g, ':datasetId').replace(/:symbolOrRunId\b/g, ':runId');
}

function joinRoute(prefix, route) {
  return normalizeRoute(`${normalizeRoute(prefix)}/${normalizeRoute(route)}`);
}

async function main() {
  const runtime = await readFile(runtimePath, 'utf8');
  const server = await readFile(serverPath, 'utf8');
  const importMap = new Map();
  for (const m of runtime.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) {
    importMap.set(m[1], path.normalize(path.join(path.dirname(runtimePath), m[2])) + (m[2].endsWith('.js') ? '' : '.js'));
  }

  const mounts = [];
  for (const m of runtime.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(?:[^,()]+\([^)]*\)\s*,\s*)?(\w+)/g)) {
    const file = importMap.get(m[2]);
    if (file) mounts.push({ prefix: m[1], varName: m[2], file });
  }

  const discovered = [];
  for (const mount of mounts) {
    const src = await readFile(mount.file, 'utf8').catch(() => '');
    const routerNames = [...src.matchAll(/const\s+(\w+)\s*=\s*Router\s*\(/g)].map((m) => m[1]);
    const names = routerNames.length ? routerNames : [mount.varName];
    for (const name of names) {
      const re = new RegExp(`${name}\\.(get|post|put|delete)\\(\\s*['\"]([^'\"]+)['\"]`, 'g');
      for (const r of src.matchAll(re)) {
        discovered.push({ method: r[1].toUpperCase(), route: joinRoute(mount.prefix, r[2]), handlerFile: path.relative(root, mount.file) });
      }
    }
  }
  for (const r of server.matchAll(/app\.(get|post|put|delete)\(\s*['"]([^'"]+)['"]/g)) {
    discovered.push({ method: r[1].toUpperCase(), route: normalizeRoute(r[2]), handlerFile: 'server.js' });
  }

  const results = REQUIRED_ROUTES.map((required) => {
    const aliases = [required.route];
    if (required.route === '/api/historical/datasets/:datasetId') aliases.push('/api/historical/datasets/:id');
    if (required.route === '/api/historical/datasets/:datasetId/diagnostics') aliases.push('/api/historical/datasets/:id/diagnostics');
    const match = discovered.find((d) => d.method === required.method && aliases.includes(d.route));
    return { Route: required.route, Method: required.method, 'Handler file': match?.handlerFile ?? null, Mounted: Boolean(match), Category: required.category, 'Expected consumer': required.expectedConsumer, Risk: required.risk };
  });

  const missing = results.filter((r) => !r.Mounted);
  const output = { ok: missing.length === 0, generatedAt: new Date().toISOString(), routeCount: results.length, missingCount: missing.length, missing, routes: results, discovered };
  await writeFile(path.join(root, 'BACKEND_ROUTE_DISCOVERY_RESULTS.json'), JSON.stringify(output, null, 2));
  if (missing.length) {
    console.error(`Route discovery failed: ${missing.length} required routes missing/unmounted`);
    for (const r of missing) console.error(`${r.Method} ${r.Route}`);
    process.exit(1);
  }
  console.log(`Route discovery passed: ${results.length} required routes mounted.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
