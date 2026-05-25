import replayRoutes from '../api/replayRoutes.js';
import replayLegacyRoutes from '../api/replaySessionRoutes.js';

export function applyRuntimeIntegration(app) {
  const runtimeHealthResponse = (req, res) => {
    res.json({
      ok: true,
      runtime: 'active',
      service: 'reversal-proxy',
    });
  };

  app.get('/api/runtime/health', runtimeHealthResponse);
  app.get('/api/runtime/runtime-status', runtimeHealthResponse);
  app.get('/api/monitoring/runtime-status', runtimeHealthResponse);

  app.use('/api/replay', replayRoutes);
  app.use('/api/replay-legacy', replayLegacyRoutes);
}
