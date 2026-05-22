import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { requireAuth } from './auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// 🌍 CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ================== HEALTH ==================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ================== AUTH TEST ==================
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ================== MARKET DATA (CORE API) ==================
app.get('/api/v1/market/price/:symbol', requireAuth, async (req, res) => {
  const { symbol } = req.params;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`;

    const response = await fetch(url);
    const data = await response.json();

    res.json({
      symbol,
      data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== SIGNAL ENGINE (BASIC CORE) ==================
app.post('/api/v1/signal/generate', requireAuth, (req, res) => {
  const { rsi, atr, gapPct, vix } = req.body;

  let score = 0;

  if (rsi > 70) score += 0.3;
  if (gapPct > 1) score += 0.2;
  if (vix > 20) score += 0.2;
  if (atr > 1) score += 0.1;

  const signal = score > 0.5 ? 'PUT' : 'CALL';

  res.json({
    signal,
    confidence: score
  });
});

// ================== BACKTEST PLACEHOLDER ==================
app.post('/api/v1/backtest', requireAuth, (req, res) => {
  res.json({
    message: 'Backtest engine will be upgraded in next phase'
  });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API running on ${PORT}`);
});