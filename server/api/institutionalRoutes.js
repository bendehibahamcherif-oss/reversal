import { Router } from 'express';
import { institutionalEngine } from '../institutional/institutionalEngine.js';

const institutionalRoutes = Router();

// ── Volatility-based sizing ────────────────────────────────────────────────────

// POST /api/institutional/sizing/volatility
// Body: { accountSize, riskPct, annualizedVol, currentPrice, horizonDays?,
//         mlSignalConfidence?, mode?, notes? }
// Response: { ok, shares, positionValue, dollarRisk, ... auditId }
institutionalRoutes.post('/sizing/volatility', (req, res) => {
  try {
    const body = req.body || {};
    if (body.accountSize   == null) return res.status(400).json({ ok: false, error: 'accountSize is required' });
    if (body.annualizedVol == null) return res.status(400).json({ ok: false, error: 'annualizedVol is required' });
    if (body.currentPrice  == null) return res.status(400).json({ ok: false, error: 'currentPrice is required' });
    const result = institutionalEngine.volatilitySizing(body);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Kelly sizing ───────────────────────────────────────────────────────────────

// POST /api/institutional/sizing/kelly
// Body: { accountSize, winProbability, avgWinPct, avgLossPct,
//         currentPrice?, kellyFraction?, maxKellyPct?,
//         mlSignalConfidence?, mode?, notes? }
// Response: { ok, rawKelly, cappedKelly, positionValue, shares?, ... auditId }
institutionalRoutes.post('/sizing/kelly', (req, res) => {
  try {
    const body = req.body || {};
    if (body.accountSize    == null) return res.status(400).json({ ok: false, error: 'accountSize is required' });
    if (body.winProbability == null) return res.status(400).json({ ok: false, error: 'winProbability is required' });
    if (body.avgWinPct      == null) return res.status(400).json({ ok: false, error: 'avgWinPct is required' });
    if (body.avgLossPct     == null) return res.status(400).json({ ok: false, error: 'avgLossPct is required' });
    const result = institutionalEngine.kellySizing(body);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Scenario analysis ──────────────────────────────────────────────────────────

// GET /api/institutional/scenarios/presets
// Response: { ok, presets: [ { packId, name, description, shocks } ] }
institutionalRoutes.get('/scenarios/presets', (_req, res) => {
  return res.json({ ok: true, presets: institutionalEngine.getPresetScenarios() });
});

// GET /api/institutional/scenarios
// Query: mode?, limit?
// Response: { ok, scenarios, count }
institutionalRoutes.get('/scenarios', (req, res) => {
  try {
    const scenarios = institutionalEngine.listScenarios({
      mode:  req.query.mode,
      limit: req.query.limit,
    });
    return res.json({ ok: true, scenarios, count: scenarios.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/institutional/scenarios/:scenarioId
institutionalRoutes.get('/scenarios/:scenarioId', (req, res) => {
  const scenario = institutionalEngine.getScenario(req.params.scenarioId);
  if (!scenario) return res.status(404).json({ ok: false, error: 'Scenario not found' });
  return res.json({ ok: true, scenario });
});

// POST /api/institutional/scenarios/run
// Body: { name?, description?, shocks, positions, accountSize?, mode?, notes? }
// Response: { ok, totalPnlImpact, drawdownPct, details, auditId, scenarioId }
institutionalRoutes.post('/scenarios/run', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.shocks)     return res.status(400).json({ ok: false, error: 'shocks is required' });
    if (!Array.isArray(body.positions) || !body.positions.length) {
      return res.status(400).json({ ok: false, error: 'positions must be a non-empty array' });
    }
    const result = institutionalEngine.runScenario(body);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/institutional/scenarios/stress-pack/:packId
// Body: { positions, accountSize?, mode?, notes? }
// Response: { ok, packId, name, totalPnlImpact, drawdownPct, details, auditId, scenarioId }
institutionalRoutes.post('/scenarios/stress-pack/:packId', (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.positions) || !body.positions.length) {
      return res.status(400).json({ ok: false, error: 'positions must be a non-empty array' });
    }
    const result = institutionalEngine.runStressPack({ ...body, packId: req.params.packId });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Decision report export ─────────────────────────────────────────────────────

// POST /api/institutional/report/export
// Body: { auditIds?, accountSize?, mode?, analyst?, notes?, title? }
// Response: { ok, report: { reportId, reportVersion, assumptions, summary,
//             sizingResults, scenarioResults, auditTrail }, exportAuditId }
institutionalRoutes.post('/report/export', (req, res) => {
  try {
    const result = institutionalEngine.exportDecisionReport(req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Audit trail ────────────────────────────────────────────────────────────────

// GET /api/institutional/audit
// Query: mode?, analysisType?, limit?
// Response: { ok, entries, count }
institutionalRoutes.get('/audit', (req, res) => {
  try {
    const entries = institutionalEngine.getAuditTrail({
      mode:         req.query.mode,
      analysisType: req.query.analysisType,
      limit:        req.query.limit,
    });
    return res.json({ ok: true, entries, count: entries.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/institutional/audit/:auditId
institutionalRoutes.get('/audit/:auditId', (req, res) => {
  const entry = institutionalEngine.getAuditEntry(req.params.auditId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Audit entry not found' });
  return res.json({ ok: true, entry });
});

export default institutionalRoutes;
