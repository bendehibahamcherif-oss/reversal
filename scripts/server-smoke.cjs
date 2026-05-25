const { spawn } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 19090);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const checks = [
  { method: 'GET', path: '/api/runtime/health' },
  { method: 'GET', path: '/api/runtime/runtime-status' },
  { method: 'GET', path: '/api/monitoring/runtime-status' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=1m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=5m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=15m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=1H' },
  { method: 'POST', path: '/api/replay-session/start' },
  { method: 'POST', path: '/api/replay-session/pause' },
  { method: 'POST', path: '/api/replay-session/resume' },
  { method: 'POST', path: '/api/replay-session/stop' },
  { method: 'GET', path: '/api/alpha/signals/SPY' },
  { method: 'POST', path: '/api/alpha/analyze/SPY' },
  { method: 'GET', path: '/api/patterns/signals/SPY' },
  { method: 'POST', path: '/api/patterns/analyze/SPY' },
  { method: 'GET', path: '/api/strategies/candidates/SPY' },
  { method: 'POST', path: '/api/strategies/generate/SPY' },
  { method: 'GET', path: '/api/quant/features/SPY' },
  { method: 'GET', path: '/api/quality/scores/SPY' },
  { method: 'POST', path: '/api/quality/score/SPY' },
  { method: 'POST', path: '/api/quant/extract/SPY' },
  { method: 'GET', path: '/api/quant/pipeline/SPY' },
  { method: 'POST', path: '/api/quant/pipeline/SPY' },
];

async function waitForReady(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/runtime/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready on ${BASE_URL}`);
}

async function run() {
  const server = spawn(process.execPath, ['server/index.cjs'], {
    env: { ...process.env, PORT: String(PORT), MONGO_URI: process.env.MONGO_URI || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  try {
    await waitForReady();
    for (const check of checks) {
      const response = await fetch(`${BASE_URL}${check.path}`, {
        method: check.method,
        headers: { 'Content-Type': 'application/json' },
      });

      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${check.method} ${check.path} did not return JSON`);
      }

      if (!response.ok) {
        throw new Error(`${check.method} ${check.path} failed with ${response.status}: ${JSON.stringify(parsed)}`);
      }

      if (check.path === '/api/quant/pipeline/SPY' && !Array.isArray(parsed.qualityScores)) {
        throw new Error('POST /api/quant/pipeline/SPY missing qualityScores array');
      }

      console.log(`OK ${check.method} ${check.path}`);
    }
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
