#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(process.argv[2] || 'server/ai/data/features_snapshot.csv');
const arg3 = process.argv[3];
const arg4 = process.argv[4];
const symbol = arg3 && Number.isNaN(Number(arg3)) ? arg3 : 'SPY';
const rows = Number((arg3 && !Number.isNaN(Number(arg3)) ? arg3 : arg4) || 240);
fs.mkdirSync(path.dirname(output), { recursive: true });

const lines = ['timestamp,symbol,open,high,low,close,volume'];
let price = 100;
const start = Date.UTC(2026, 0, 2, 14, 30, 0);
for (let i = 0; i < rows; i += 1) {
  const drift = Math.sin(i / 11) * 0.08 + Math.cos(i / 29) * 0.04;
  const open = price;
  const close = open + drift;
  const high = Math.max(open, close) + 0.15;
  const low = Math.min(open, close) - 0.15;
  const volume = 1000 + Math.round(150 * Math.sin(i / 7) + (i % 13) * 20);
  const ts = new Date(start + i * 60_000).toISOString();
  lines.push(`${ts},${symbol},${open.toFixed(4)},${high.toFixed(4)},${low.toFixed(4)},${close.toFixed(4)},${volume}`);
  price = close;
}
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(JSON.stringify({ ok: true, output, rows, symbol }));
