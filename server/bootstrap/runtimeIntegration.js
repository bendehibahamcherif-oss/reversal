import replayRoutes from '../api/replayRoutes.js';
import replayLegacyRoutes from '../api/replaySessionRoutes.js';
import replaySessionRoutes from '../api/replaySessionControlRoutes.js';
import alphaRoutes from '../api/alphaRoutes.js';
import patternRoutes from '../api/patternRoutes.js';
import strategyRoutes from '../api/strategyRoutes.js';
import quantRoutes from '../api/quantRoutes.js';

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

  app.use('/api/replay', replayRoutes);
  app.use('/api/replay-legacy', replayLegacyRoutes);
  app.use('/api/replay-session', replaySessionRoutes);
  app.use('/api/alpha', alphaRoutes);
  app.use('/api/patterns', patternRoutes);
  app.use('/api/strategies', strategyRoutes);
  app.use('/api/quant', quantRoutes);
}
