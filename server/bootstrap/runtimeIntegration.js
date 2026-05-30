import marketStreamRoutes from '../api/marketStreamRoutes.js';
import { marketStreamEngine } from '../marketStream/MarketStreamEngine.js';
import { alertEngine } from '../alerts/AlertEngine.js';
import { cvdEngine } from '../charting/cvdEngine.js';
import { footprintEngine } from '../charting/footprintEngine.js';
import replayRoutes from '../api/replayRoutes.js';
import replayLegacyRoutes from '../api/replaySessionRoutes.js';
import replaySessionRoutes from '../api/replaySessionControlRoutes.js';
import alphaRoutes from '../api/alphaRoutes.js';
import patternRoutes from '../api/patternRoutes.js';
import strategyRoutes from '../api/strategyRoutes.js';
import quantRoutes from '../api/quantRoutes.js';
import qualityRoutes from '../api/qualityRoutes.js';
import analyticsRoutes from '../api/analyticsRoutes.js';
import backtestRoutes from '../api/backtestRoutes.js';
import validationRoutes from '../api/validationRoutes.js';
import strategyLabRoutes from '../api/strategyLabRoutes.js';
import ruleEngineRoutes from '../api/ruleEngineRoutes.js';
import strategyTemplateRoutes from '../api/strategyTemplateRoutes.js';
import sessionContextRoutes from '../api/sessionContextRoutes.js';
import reversalRoutes from '../api/reversalRoutes.js';
import paperTradingRoutes from '../api/paperTradingRoutes.js';
import feedRoutes from '../api/feedRoutes.js';
import chartRoutes from '../api/chartRoutes.js';
import alertRoutes from '../api/alertRoutes.js';
import volumeProfileRoutes from '../api/volumeProfileRoutes.js';
import aiRoutes from '../api/aiRoutes.js';
import providerCredentialRoutes from '../api/providerCredentialRoutes.js';
import portfolioRoutes from '../api/portfolioRoutes.js';
import executionRoutes from '../api/executionRoutes.js';
import omsRoutes from '../api/omsRoutes.js';

export function applyRuntimeIntegration(app) {
  const runtimeHealthResponse = (req, res) => {
    res.json({
      ok: true,
      runtime: 'active',
      service: 'reversal-proxy',
      market: {
        status: 'closed-or-idle-safe',
        ticksRequiredForHealth: false,
      },
      feed: {
        credentialsConfigured: Boolean(process.env.MARKET_FEED_KEY),
        degradedMode: !process.env.MARKET_FEED_KEY,
      },
    });
  };

  app.get('/api/runtime/health', runtimeHealthResponse);
  app.get('/api/runtime/runtime-status', runtimeHealthResponse);
  app.get('/api/monitoring/runtime-status', runtimeHealthResponse);

  // MarketStreamEngine diagnostic routes — mounted at /api to intercept
  // /api/providers/health, /api/market/runtime, /api/market/subscriptions
  // before the generic /api/market → feedRoutes alias below.
  app.use('/api', marketStreamRoutes);

  // Initialize the stream engine asynchronously after routes are mounted
  marketStreamEngine.initialize().catch((e) =>
    console.warn('[runtimeIntegration] MarketStreamEngine init failed:', e?.message),
  );

  // Start alert evaluation engine
  alertEngine.start();

  // Start CVD engine WebSocket push loop
  cvdEngine.start();

  // Start footprint engine WebSocket push loop
  footprintEngine.start();

  app.use('/api/replay', replayRoutes);
  app.use('/api/replay-legacy', replayLegacyRoutes);
  app.use('/api/replay-session', replaySessionRoutes);
  app.use('/api/alpha', alphaRoutes);
  app.use('/api/patterns', patternRoutes);
  app.use('/api/strategies', strategyRoutes);
  app.use('/api/quant', quantRoutes);
  app.use('/api/quality', qualityRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/backtest', backtestRoutes);
  app.use('/api/validation', validationRoutes);
  app.use('/api/strategy-lab', strategyLabRoutes);
  app.use('/api/rules', ruleEngineRoutes);
  app.use('/api/templates', strategyTemplateRoutes);
  app.use('/api/session-context', sessionContextRoutes);
  app.use('/api/reversals', reversalRoutes);
  app.use('/api/paper', paperTradingRoutes);
  app.use('/api/feeds', feedRoutes);
  app.use('/api/feed', feedRoutes);
  app.use('/api/market', feedRoutes);
  app.use('/api/chart', chartRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/volume-profile', volumeProfileRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/providers', providerCredentialRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/execution', executionRoutes);
  app.use('/api/oms', omsRoutes);
}
