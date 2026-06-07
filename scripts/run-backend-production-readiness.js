#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const commands = [
  ['backend-route-discovery', process.execPath, ['scripts/backend-route-discovery.js']],
  ['api-contract-crawler', process.execPath, ['scripts/api-contract-crawler.js']],
  ['backend-payload-fuzzer', process.execPath, ['scripts/backend-payload-fuzzer.js']],
  ['full-backend-smoke', process.execPath, ['scripts/full-backend-smoke.js']],
  ...(process.env.API_BASE ? [['production-api-contract-smoke', process.execPath, ['scripts/production-api-contract-smoke.js']]] : []),
];
function run(name, command, args) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('close', (code) => resolve({ name, command: [command, ...args].join(' '), exitCode: code, ok: code === 0, durationMs: Date.now() - startedAt, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000) }));
  });
}
async function main() {
  const results = [];
  for (const [name, command, args] of commands) {
    const result = await run(name, command, args);
    results.push(result);
    if (!result.ok) break;
  }
  const output = { ok: results.every((r) => r.ok) && results.length === commands.length, generatedAt: new Date().toISOString(), productionSmokeIncluded: Boolean(process.env.API_BASE), results };
  await writeFile(path.join(root, 'BACKEND_PRODUCTION_READINESS_RESULTS.json'), JSON.stringify(output, null, 2));
  if (!output.ok) { console.error('Backend production readiness failed.'); process.exit(1); }
  console.log('Backend production readiness passed locally.');
}
main().catch((err) => { console.error(err); process.exit(1); });
