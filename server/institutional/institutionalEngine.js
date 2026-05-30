// ── Institutional Toolkit Engine ───────────────────────────────────────────────
//
// SIZING FORMULAS
// ───────────────
//   Volatility-based:
//     dollarRisk    = accountSize × riskPct
//     dailyVol      = annualizedVol / √252
//     horizonVol    = currentPrice × dailyVol × √horizonDays
//     shares        = dollarRisk / horizonVol
//     positionValue = shares × currentPrice
//
//   Kelly (capped, fractional):
//     b             = avgWinPct / avgLossPct          (win/loss ratio)
//     rawKelly      = p - (1-p)/b                     (Kelly fraction)
//     fractional    = rawKelly × kellyFraction         (default ½-Kelly)
//     adjusted      = fractional × mlSignalConfidence  (only if ML provided)
//     cappedKelly   = clamp(adjusted, 0, maxKellyPct)
//     positionValue = accountSize × cappedKelly
//
// AUDIT MODEL
// ───────────
//   Every computation appends an immutable row to institutional_audit.
//   Fields: auditId, timestamp, analysisType, mode, inputs (JSON),
//           outputs (JSON), mlSignalUsed, mlSignalId, mlConfidence, notes.
//
// SCENARIO / STRESS-PACK
// ──────────────────────
//   Each position's P&L impact = quantity × currentPrice × shockPct (long)
//                              = –quantity × currentPrice × shockPct (short)
//   Unknown symbols fall back to shocks['*'] if defined, else 0.
//   Results persisted to institutional_scenarios and linked to the audit row.
//
// EXPORT
// ──────
//   exportDecisionReport() bundles sizing + scenario results + audit refs
//   into a self-contained JSON document (reportVersion: '1.0').
//   The document explicitly states all assumptions and formula definitions
//   so the report is reproducible in isolation.
//
// PAPER / LIVE SEGMENTATION
// ─────────────────────────
//   mode field propagated to every audit entry and scenario record.
//   Live mode requires no special runtime flag here — the engine is
//   analytics-only and never routes orders. The caller supplies mode.

import { randomUUID } from 'node:crypto';
import { institutionalStore } from './institutionalStore.js';

const ENGINE_VERSION = '1.0';

// ── Pre-defined stress-pack catalogue ────────────────────────────────────────

const STRESS_PACKS = {
  gfc_2008: {
    packId:      'gfc_2008',
    name:        '2008 Global Financial Crisis',
    description: 'S&P 500 peak-to-trough drawdown of ~55% (Oct 2007 – Mar 2009).',
    shocks: {
      SPY:  -0.55, QQQ:  -0.52, IWM:  -0.60,
      GLD:  +0.05, TLT:  +0.25,
      XLF:  -0.80, XLK:  -0.52, XLE:  -0.55,
      XLB:  -0.55, XLI:  -0.50, XLY:  -0.60,
      XLP:  -0.30, XLU:  -0.45, XLRE: -0.65, XLC: -0.45,
      '*':  -0.45,
    },
  },
  covid_2020: {
    packId:      'covid_2020',
    name:        'COVID-19 Crash (Feb–Mar 2020)',
    description: 'S&P 500 fell ~34% in 33 calendar days.',
    shocks: {
      SPY:  -0.34, QQQ: -0.28, IWM: -0.42,
      GLD:  -0.12, TLT: +0.15,
      XLE:  -0.55, XLF: -0.40, XLK: -0.22,
      XLB:  -0.40, XLI: -0.40, XLY: -0.35,
      XLP:  -0.20, XLU: -0.30, XLRE: -0.40,
      '*':  -0.34,
    },
  },
  dotcom_2000: {
    packId:      'dotcom_2000',
    name:        'Dot-com Bust (2000–2002)',
    description: 'NASDAQ-100 fell ~83%; broad market -49%.',
    shocks: {
      QQQ: -0.83, XLK: -0.80, SPY: -0.49,
      IWM: -0.45, GLD: +0.15, TLT: +0.20,
      XLF: -0.30, XLE: -0.25, XLB: -0.30,
      '*': -0.35,
    },
  },
  rate_shock_200bps: {
    packId:      'rate_shock_200bps',
    name:        'Rate Shock +200bps',
    description: 'Hypothetical parallel shift of the yield curve +200bps.',
    shocks: {
      TLT: -0.20, IEF: -0.12,
      SPY: -0.15, XLU: -0.20, XLF: +0.05,
      GLD: -0.08, XLRE: -0.18,
      '*': -0.10,
    },
  },
  inflation_surge: {
    packId:      'inflation_surge',
    name:        'Inflation Surge',
    description: 'Commodities and energy outperform; bonds and growth sell off.',
    shocks: {
      GLD: +0.15, XLE: +0.20, XLB: +0.10,
      TLT: -0.25, IEF: -0.15,
      SPY: -0.10, QQQ: -0.18, XLK: -0.20,
      '*': -0.05,
    },
  },
};

// ── ID helpers ────────────────────────────────────────────────────────────────

function genAuditId()    { return `aud_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genScenarioId() { return `scen_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genReportId()   { return `rpt_${Date.now()}_${randomUUID().slice(0, 8)}`; }

// ── Math guards ───────────────────────────────────────────────────────────────

function _r4(n)    { return typeof n === 'number' && isFinite(n) ? Number(n.toFixed(4)) : null; }
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Scenario application ──────────────────────────────────────────────────────

function applyShocks(positions, shocks) {
  const details = positions.map((pos) => {
    const sym       = String(pos.symbol || '').toUpperCase();
    const qty       = Number(pos.quantity || 0);
    const price     = Number(pos.currentPrice ?? pos.entryPrice ?? 0);
    const side      = String(pos.side || 'long').toLowerCase();
    const shockPct  = shocks[sym] ?? shocks['*'] ?? 0;
    const direction = side === 'short' ? -1 : 1;
    const pnl       = direction * qty * price * shockPct;
    return {
      symbol:       sym,
      quantity:     qty,
      currentPrice: price,
      side,
      shockPct:     _r4(shockPct),
      pnlImpact:    _r4(pnl),
      positionValue: _r4(qty * price),
    };
  });

  const totalPnlImpact    = _r4(details.reduce((s, d) => s + (d.pnlImpact ?? 0), 0));
  const totalPositionValue = _r4(details.reduce((s, d) => s + (d.positionValue ?? 0), 0));

  return { details, totalPnlImpact, totalPositionValue };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export const institutionalEngine = {

  STRESS_PACKS,

  // ── Volatility-based sizing ─────────────────────────────────────────────────
  //
  // Inputs:
  //   accountSize        — total capital in account currency
  //   riskPct            — fraction of account to risk (e.g. 0.01 = 1%)
  //   annualizedVol      — annualized volatility as decimal (e.g. 0.20 = 20%)
  //   currentPrice       — current market price of the asset
  //   horizonDays        — holding period in trading days (default 1)
  //   mlSignalConfidence — optional 0-1 confidence from ML champion model;
  //                        scales the resulting shares linearly when provided
  //   mode               — 'paper' | 'live' | 'hypothetical'
  //
  // Returns: shares, positionValue, dollarRisk, effectiveVol, scalingNote

  volatilitySizing({
    accountSize,
    riskPct        = 0.01,
    annualizedVol,
    currentPrice,
    horizonDays    = 1,
    mlSignalConfidence = null,
    mode           = 'paper',
    notes          = '',
  } = {}) {
    const aSize  = Number(accountSize);
    const rPct   = Number(riskPct);
    const aVol   = Number(annualizedVol);
    const price  = Number(currentPrice);
    const hDays  = Math.max(1, Number(horizonDays));
    const mlConf = mlSignalConfidence != null ? _clamp(Number(mlSignalConfidence), 0, 1) : null;

    if (!(aSize > 0))   throw new Error('accountSize must be positive');
    if (!(price > 0))   throw new Error('currentPrice must be positive');
    if (!(aVol > 0))    throw new Error('annualizedVol must be positive');
    if (!(rPct > 0 && rPct <= 1)) throw new Error('riskPct must be in (0, 1]');

    const dollarRisk    = aSize * rPct;
    const dailyVol      = aVol / Math.sqrt(252);
    const horizonVol    = price * dailyVol * Math.sqrt(hDays);
    let   rawShares     = horizonVol > 0 ? dollarRisk / horizonVol : 0;
    const scalingApplied = mlConf != null;
    const scaledShares  = scalingApplied ? rawShares * mlConf : rawShares;

    const result = {
      ok:              true,
      analysisType:    'volatility_sizing',
      mode,
      shares:          _r4(scaledShares),
      sharesUnscaled:  _r4(rawShares),
      positionValue:   _r4(scaledShares * price),
      dollarRisk:      _r4(dollarRisk),
      dailyVol:        _r4(dailyVol),
      horizonVol:      _r4(horizonVol),
      effectiveVolPct: _r4(aVol * 100),
      horizonDays:     hDays,
      mlSignalConfidence: mlConf,
      mlScalingApplied:   scalingApplied,
      scalingNote: scalingApplied
        ? `Shares scaled by ML signal confidence (${(mlConf * 100).toFixed(1)}%): ${_r4(rawShares)} → ${_r4(scaledShares)}`
        : 'No ML signal provided; full vol-based shares used.',
      formulaNote: 'shares = (accountSize × riskPct) / (currentPrice × (annualizedVol/√252) × √horizonDays)',
      engineVersion: ENGINE_VERSION,
    };

    const inputs = { accountSize: aSize, riskPct: rPct, annualizedVol: aVol, currentPrice: price, horizonDays: hDays, mlSignalConfidence: mlConf, mode };
    const auditId = genAuditId();
    institutionalStore.appendAudit({
      auditId, timestamp: new Date().toISOString(),
      analysisType: 'volatility_sizing', mode,
      inputs, outputs: result,
      mlSignalUsed: scalingApplied, mlSignalId: null, mlConfidence: mlConf,
      notes, engineVersion: ENGINE_VERSION,
    });

    return { ...result, auditId };
  },

  // ── Kelly (capped, fractional) sizing ───────────────────────────────────────
  //
  // Inputs:
  //   accountSize        — total capital
  //   winProbability     — empirical win rate (0-1), e.g. 0.55
  //   avgWinPct          — average win as fraction, e.g. 0.08 (8%)
  //   avgLossPct         — average loss magnitude as fraction, e.g. 0.04 (4%)
  //   currentPrice       — asset price (optional; used to compute shares)
  //   kellyFraction      — fraction of full Kelly to use (default 0.5 = ½-Kelly)
  //   maxKellyPct        — hard cap as fraction of account (default 0.25 = 25%)
  //   mlSignalConfidence — optional 0-1; scales fractional Kelly when provided
  //   mode               — 'paper' | 'live' | 'hypothetical'
  //
  // Returns: rawKelly, fractionalKelly, adjustedKelly, cappedKelly, positionValue, shares, edgePositive

  kellySizing({
    accountSize,
    winProbability,
    avgWinPct,
    avgLossPct,
    currentPrice       = null,
    kellyFraction      = 0.5,
    maxKellyPct        = 0.25,
    mlSignalConfidence = null,
    mode               = 'paper',
    notes              = '',
  } = {}) {
    const aSize  = Number(accountSize);
    const p      = Number(winProbability);
    const wPct   = Number(avgWinPct);
    const lPct   = Number(avgLossPct);
    const kFrac  = _clamp(Number(kellyFraction), 0, 1);
    const maxK   = _clamp(Number(maxKellyPct), 0, 1);
    const price  = currentPrice != null ? Number(currentPrice) : null;
    const mlConf = mlSignalConfidence != null ? _clamp(Number(mlSignalConfidence), 0, 1) : null;

    if (!(aSize > 0))                    throw new Error('accountSize must be positive');
    if (!(p >= 0 && p <= 1))             throw new Error('winProbability must be in [0, 1]');
    if (!(wPct > 0))                     throw new Error('avgWinPct must be positive');
    if (!(lPct > 0))                     throw new Error('avgLossPct must be positive');

    const q          = 1 - p;
    const b          = wPct / lPct;           // win/loss ratio
    const rawKelly   = p - q / b;             // f* = p - (1-p)/b
    const fractional = rawKelly * kFrac;
    const adjusted   = mlConf != null ? fractional * mlConf : fractional;
    const cappedKelly = _clamp(adjusted, 0, maxK);
    const positionValue = aSize * cappedKelly;
    const shares        = (price && price > 0) ? positionValue / price : null;
    const expectedValue = p * wPct - q * lPct; // EV per unit risked

    const result = {
      ok:              true,
      analysisType:    'kelly_sizing',
      mode,
      rawKelly:        _r4(rawKelly),
      edgePositive:    rawKelly > 0,
      fractionalKelly: _r4(fractional),
      adjustedKelly:   _r4(adjusted),
      cappedKelly:     _r4(cappedKelly),
      positionValue:   _r4(positionValue),
      shares:          shares != null ? _r4(shares) : null,
      expectedValue:   _r4(expectedValue),
      winLossRatio:    _r4(b),
      inputs: {
        p, q, b, kellyFraction: kFrac, maxKellyPct: maxK,
      },
      mlSignalConfidence:  mlConf,
      mlScalingApplied:    mlConf != null,
      scalingNote: mlConf != null
        ? `Fractional Kelly scaled by ML confidence (${(mlConf * 100).toFixed(1)}%): ${_r4(fractional)} → ${_r4(adjusted)}`
        : 'No ML signal provided; fractional Kelly used unmodified.',
      capNote: adjusted > maxK
        ? `Kelly capped from ${_r4(adjusted)} to ${maxK} (maxKellyPct)`
        : `Kelly within cap (${_r4(adjusted)} ≤ ${maxK}).`,
      formulaNote: 'rawKelly = p − (1−p)/b  where  b = avgWinPct / avgLossPct',
      engineVersion: ENGINE_VERSION,
    };

    const inputs = { accountSize: aSize, winProbability: p, avgWinPct: wPct, avgLossPct: lPct, currentPrice: price, kellyFraction: kFrac, maxKellyPct: maxK, mlSignalConfidence: mlConf, mode };
    const auditId = genAuditId();
    institutionalStore.appendAudit({
      auditId, timestamp: new Date().toISOString(),
      analysisType: 'kelly_sizing', mode,
      inputs, outputs: result,
      mlSignalUsed: mlConf != null, mlSignalId: null, mlConfidence: mlConf,
      notes, engineVersion: ENGINE_VERSION,
    });

    return { ...result, auditId };
  },

  // ── Custom scenario ─────────────────────────────────────────────────────────
  //
  // Apply arbitrary per-symbol price shocks to a position list.
  // Positions: [{ symbol, quantity, currentPrice, entryPrice?, side? }]
  // Shocks:    { SYMBOL: pctChange } e.g. { SPY: -0.10 }; '*' is wildcard

  runScenario({
    name        = 'Custom Scenario',
    description = '',
    shocks      = {},
    positions   = [],
    accountSize = null,
    mode        = 'paper',
    mlSignalConfidence = null,
    notes       = '',
  } = {}) {
    if (!positions.length) throw new Error('positions array must not be empty');

    const { details, totalPnlImpact, totalPositionValue } = applyShocks(positions, shocks);
    const drawdownPct = (accountSize && accountSize > 0)
      ? _r4((totalPnlImpact / Number(accountSize)) * 100)
      : null;

    const result = {
      ok:                  true,
      analysisType:        'scenario',
      name,
      description,
      mode,
      details,
      totalPnlImpact,
      totalPositionValue,
      drawdownPct,
      positionCount:       positions.length,
      mlSignalConfidence:  mlSignalConfidence != null ? _clamp(Number(mlSignalConfidence), 0, 1) : null,
      engineVersion:       ENGINE_VERSION,
    };

    const auditId    = genAuditId();
    const scenarioId = genScenarioId();
    const now        = new Date().toISOString();
    const inputs     = { name, description, shocks, positions, accountSize, mode };

    institutionalStore.appendAudit({
      auditId, timestamp: now, analysisType: 'scenario', mode,
      inputs, outputs: result,
      mlSignalUsed: false, mlSignalId: null, mlConfidence: null,
      notes, engineVersion: ENGINE_VERSION,
    });
    institutionalStore.saveScenario({
      scenarioId, auditId, name, packId: null, mode,
      inputs, results: result, createdAt: now,
    });

    return { ...result, auditId, scenarioId };
  },

  // ── Preset stress pack ──────────────────────────────────────────────────────

  runStressPack({
    packId,
    positions   = [],
    accountSize = null,
    mode        = 'paper',
    notes       = '',
  } = {}) {
    const pack = STRESS_PACKS[packId];
    if (!pack) throw new Error(`Unknown stress pack: ${packId}. Available: ${Object.keys(STRESS_PACKS).join(', ')}`);
    if (!positions.length) throw new Error('positions array must not be empty');

    const { details, totalPnlImpact, totalPositionValue } = applyShocks(positions, pack.shocks);
    const drawdownPct = (accountSize && accountSize > 0)
      ? _r4((totalPnlImpact / Number(accountSize)) * 100)
      : null;

    const result = {
      ok:                true,
      analysisType:      'stress_pack',
      packId,
      name:              pack.name,
      description:       pack.description,
      mode,
      details,
      totalPnlImpact,
      totalPositionValue,
      drawdownPct,
      positionCount:     positions.length,
      shocksApplied:     pack.shocks,
      engineVersion:     ENGINE_VERSION,
    };

    const auditId    = genAuditId();
    const scenarioId = genScenarioId();
    const now        = new Date().toISOString();
    const inputs     = { packId, positions, accountSize, mode };

    institutionalStore.appendAudit({
      auditId, timestamp: now, analysisType: 'stress_pack', mode,
      inputs, outputs: result,
      mlSignalUsed: false, mlSignalId: null, mlConfidence: null,
      notes, engineVersion: ENGINE_VERSION,
    });
    institutionalStore.saveScenario({
      scenarioId, auditId, name: pack.name, packId, mode,
      inputs, results: result, createdAt: now,
    });

    return { ...result, auditId, scenarioId };
  },

  // ── Decision report export ──────────────────────────────────────────────────
  //
  // Bundles one or more prior audit entries into a self-contained JSON report.
  // The report document is designed to be reproducible in isolation:
  //   • All assumptions are stated explicitly
  //   • Formula definitions are embedded in the document
  //   • auditIds link back to the immutable audit trail
  //
  // No file is written; the caller streams the returned object as JSON.

  exportDecisionReport({
    auditIds    = [],
    accountSize = null,
    mode        = 'paper',
    analyst     = 'system',
    notes       = '',
    title       = 'Decision Report',
  } = {}) {
    const reportId   = genReportId();
    const now        = new Date().toISOString();

    // Resolve referenced audit entries
    const auditEntries = auditIds
      .map((id) => institutionalStore.getAuditEntry(id))
      .filter(Boolean);

    // Group by analysis type
    const sizingEntries   = auditEntries.filter((e) => ['volatility_sizing', 'kelly_sizing'].includes(e.analysisType));
    const scenarioEntries = auditEntries.filter((e) => ['scenario', 'stress_pack'].includes(e.analysisType));

    // Aggregate scenario P&L range
    const pnlValues = scenarioEntries.map((e) => e.outputs?.totalPnlImpact).filter((v) => v != null);
    const worstCase = pnlValues.length ? Math.min(...pnlValues) : null;
    const bestCase  = pnlValues.length ? Math.max(...pnlValues) : null;

    const report = {
      reportId,
      reportVersion: '1.0',
      title,
      generatedAt:   now,
      analyst,
      mode,
      modeBadge:     mode === 'live' ? 'LIVE' : mode === 'paper' ? 'PAPER' : 'HYPOTHETICAL',
      engineVersion: ENGINE_VERSION,

      // All assumptions stated explicitly for reproducibility
      assumptions: {
        accountSize:   accountSize != null ? Number(accountSize) : null,
        mode,
        notes,
        formulaDefinitions: {
          volatilitySizing: 'shares = (accountSize × riskPct) / (currentPrice × (annualizedVol/√252) × √horizonDays)',
          kellySizing:      'rawKelly = p − (1−p)/b  where  b = avgWinPct / avgLossPct',
          fractionalKelly:  'fractional = rawKelly × kellyFraction  (default ½-Kelly)',
          cappedKelly:      'cappedKelly = clamp(fractional × mlConf, 0, maxKellyPct)',
          scenarioPnL:      'pnlImpact = direction × quantity × currentPrice × shockPct  (long→+1, short→–1)',
          mlAdjustment:     'When mlSignalConfidence provided: sizing is multiplied by confidence score',
        },
      },

      summary: {
        auditEntriesReferenced: auditEntries.length,
        sizingAnalyses:         sizingEntries.length,
        scenarioAnalyses:       scenarioEntries.length,
        worstCasePnl:           worstCase != null ? _r4(worstCase) : null,
        bestCasePnl:            bestCase  != null ? _r4(bestCase)  : null,
      },

      sizingResults:   sizingEntries.map((e) => ({ auditId: e.auditId, analysisType: e.analysisType, timestamp: e.timestamp, mode: e.mode, outputs: e.outputs })),
      scenarioResults: scenarioEntries.map((e) => ({ auditId: e.auditId, analysisType: e.analysisType, timestamp: e.timestamp, mode: e.mode, outputs: e.outputs })),
      auditTrail:      auditEntries.map((e) => ({ auditId: e.auditId, analysisType: e.analysisType, timestamp: e.timestamp, mode: e.mode, mlSignalUsed: e.mlSignalUsed })),
    };

    // Record the export itself in the audit trail
    const exportAuditId = genAuditId();
    institutionalStore.appendAudit({
      auditId: exportAuditId, timestamp: now, analysisType: 'export', mode,
      inputs:  { auditIds, accountSize, analyst, title },
      outputs: { reportId, auditEntriesReferenced: auditEntries.length },
      mlSignalUsed: false, mlSignalId: null, mlConfidence: null,
      notes, engineVersion: ENGINE_VERSION,
    });

    return { ok: true, report, exportAuditId };
  },

  // ── Audit trail ─────────────────────────────────────────────────────────────

  getAuditTrail(params = {}) {
    return institutionalStore.listAudit(params);
  },

  getAuditEntry(auditId) {
    return institutionalStore.getAuditEntry(auditId);
  },

  // ── Scenario catalogue ───────────────────────────────────────────────────────

  getPresetScenarios() {
    return Object.values(STRESS_PACKS);
  },

  listScenarios(params = {}) {
    return institutionalStore.listScenarios(params);
  },

  getScenario(scenarioId) {
    return institutionalStore.getScenario(scenarioId);
  },
};
