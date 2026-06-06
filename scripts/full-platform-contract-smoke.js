#!/usr/bin/env node
/** Combined platform contract smoke. */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve({ command: [command, ...args].join(' '), code }));
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch (error) { return { ok: false, error: error.message }; }
}

const backend = await run(process.execPath, ['scripts/full-backend-smoke.js']);
const frontend = await run(process.execPath, ['scripts/full-frontend-smoke.js']);
const backendResults = await readJson('FULL_BACKEND_SMOKE_RESULTS.json');
const frontendResults = await readJson('FULL_FRONTEND_SMOKE_RESULTS.json');
const payload = {
  ok: backend.code === 0 && frontend.code === 0 && backendResults.ok === true && frontendResults.ok === true,
  generatedAt: new Date().toISOString(),
  commands: { backend, frontend },
  backend: backendResults,
  frontend: frontendResults,
};
await writeFile('FULL_PLATFORM_CONTRACT_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ ok: payload.ok, backend: backend.code, frontend: frontend.code }, null, 2));
if (!payload.ok) process.exitCode = 1;
