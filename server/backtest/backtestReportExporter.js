export function exportHtmlReport(run) {
  const m = run.metrics ?? {};
  const trades = Array.isArray(run.trades) ? run.trades : [];
  const warnings = Array.isArray(run.warnings) ? run.warnings : [];
  const cfg = run.config ?? {};

  const pnlClass = (v) => (Number(v) >= 0 ? 'pos' : 'neg');
  const fmt = (v, d = 2) => Number(v || 0).toFixed(d);

  const tradeRows = trades.map((t, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${t.direction ?? '-'}</td>
      <td>${t.entryTime ?? '-'}</td>
      <td>${fmt(t.entryPrice, 4)}</td>
      <td>${t.exitTime ?? '-'}</td>
      <td>${fmt(t.exitPrice, 4)}</td>
      <td class="${pnlClass(t.pnl)}">${fmt(t.pnl)}</td>
      <td class="${pnlClass(t.pnlPercent)}">${fmt(t.pnlPercent)}%</td>
      <td>${t.reason ?? '-'}</td>
    </tr>`).join('');

  const warnHtml = warnings.length
    ? `<h2>Warnings</h2><div class="warn-box"><ul>${warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>`
    : '';

  const metaRows = [
    ['Symbol', run.symbol],
    ['Timeframe', run.timeframe],
    ['Run Type', run.runType ?? 'standard'],
    ['No Look-ahead Verified', run.noLookaheadVerified ? '✓ Yes' : '✗ Unverified'],
    ['Dataset Version', run.datasetVersion ?? '—'],
    ['Source Provider', run.sourceProvider ?? '—'],
    ['Candle Count', run.candleCount ?? '—'],
    ['Range Start', run.candleRangeStart ? new Date(run.candleRangeStart).toISOString() : '—'],
    ['Range End', run.candleRangeEnd ? new Date(run.candleRangeEnd).toISOString() : '—'],
    ['Stop Loss', cfg.stopLossPercent != null ? `${fmt(cfg.stopLossPercent * 100)}%` : '—'],
    ['Take Profit', cfg.takeProfitPercent != null ? `${fmt(cfg.takeProfitPercent * 100)}%` : '—'],
    ['Commission / Trade', cfg.commissionPerTrade ?? '—'],
    ['Slippage', cfg.slippagePercent != null ? `${fmt(cfg.slippagePercent * 100, 4)}%` : '—'],
  ].map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('');

  const tradesSection = trades.length
    ? `<h2>Trades (${trades.length})</h2>
       <table>
         <thead><tr><th>#</th><th>Dir</th><th>Entry Time</th><th>Entry Price</th>
           <th>Exit Time</th><th>Exit Price</th><th>P&amp;L</th><th>P&amp;L %</th><th>Reason</th></tr></thead>
         <tbody>${tradeRows}</tbody>
       </table>`
    : '<p class="muted">No trades executed.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backtest Report — ${run.symbol} ${run.timeframe}</title>
<style>
  :root{--bg:#0f1117;--surface:#1e2330;--surface2:#151926;--text:#e2e8f0;
    --muted:#64748b;--sub:#94a3b8;--blue:#7dd3fc;--green:#4ade80;
    --red:#f87171;--warn:#fbbf24;--warn-bg:#2d1f00;--warn-border:#78350f}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--bg);color:var(--text);padding:28px;line-height:1.5}
  h1{color:var(--blue);font-size:1.6em;margin-bottom:4px}
  h2{color:var(--blue);font-size:1.05em;margin:28px 0 10px;font-weight:600}
  .sub{color:var(--sub);font-size:.88em;margin-bottom:20px}
  .disclaimer{background:var(--warn-bg);border:1px solid var(--warn-border);
    border-radius:8px;padding:14px 16px;margin:20px 0;font-size:.82em;color:var(--warn)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
    gap:10px;margin-bottom:6px}
  .card{background:var(--surface);border-radius:8px;padding:14px 16px}
  .card-label{font-size:.72em;color:var(--muted);text-transform:uppercase;
    letter-spacing:.08em;margin-bottom:4px}
  .card-value{font-size:1.35em;font-weight:600}
  .pos{color:var(--green)}.neg{color:var(--red)}.neu{color:var(--blue)}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:.84em;margin-bottom:8px}
  th{background:var(--surface);padding:9px 12px;text-align:left;
    color:var(--sub);font-weight:500}
  td{padding:7px 12px;border-bottom:1px solid var(--surface2)}
  tr:hover td{background:var(--surface2)}
  .meta-table td:first-child{color:var(--sub);width:210px}
  .warn-box{background:var(--surface2);border-radius:8px;padding:14px 16px;
    margin-bottom:6px}
  .warn-box ul{padding-left:18px;color:var(--warn);font-size:.84em;line-height:1.7}
</style>
</head>
<body>
<h1>Backtest Report</h1>
<p class="sub">
  ${run.symbol} &bull; ${run.timeframe} &bull;
  ${run.strategyName ?? run.strategyId ?? 'Unknown Strategy'} &bull;
  Generated ${new Date(run.createdAt ?? Date.now()).toLocaleString()}
</p>
<div class="disclaimer">
  RESEARCH &amp; EDUCATIONAL USE ONLY — Past performance does not guarantee future results.
  This report is NOT financial advice and is NOT validated for live trading.
</div>
<h2>Performance Metrics</h2>
<div class="grid">
  <div class="card"><div class="card-label">Total P&amp;L</div>
    <div class="card-value ${pnlClass(m.totalPnL)}">${fmt(m.totalPnL)}</div></div>
  <div class="card"><div class="card-label">Total P&amp;L %</div>
    <div class="card-value ${pnlClass(m.totalPnLPercent)}">${fmt(m.totalPnLPercent)}%</div></div>
  <div class="card"><div class="card-label">Win Rate</div>
    <div class="card-value neu">${fmt(Number(m.winRate ?? 0) * 100, 1)}%</div></div>
  <div class="card"><div class="card-label">Profit Factor</div>
    <div class="card-value ${Number(m.profitFactor ?? 0) >= 1 ? 'pos' : 'neg'}">
      ${m.profitFactor == null ? '—' : fmt(m.profitFactor)}</div></div>
  <div class="card"><div class="card-label">Max Drawdown</div>
    <div class="card-value neg">${fmt(m.maxDrawdown)}</div></div>
  <div class="card"><div class="card-label">Expectancy</div>
    <div class="card-value ${pnlClass(m.expectancy)}">${fmt(m.expectancy)}</div></div>
  <div class="card"><div class="card-label">Trades</div>
    <div class="card-value neu">${m.numberOfTrades ?? 0}</div></div>
  <div class="card"><div class="card-label">Avg Win</div>
    <div class="card-value pos">${fmt(m.averageWin)}</div></div>
  <div class="card"><div class="card-label">Avg Loss</div>
    <div class="card-value neg">${fmt(m.averageLoss)}</div></div>
</div>
<h2>Metadata</h2>
<table class="meta-table"><tbody>${metaRows}</tbody></table>
${warnHtml}
${tradesSection}
</body>
</html>`;
}
