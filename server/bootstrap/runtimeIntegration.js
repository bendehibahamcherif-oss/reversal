import replayRoutes from '../api/replayRoutes.js';
import replayLegacyRoutes from '../api/replaySessionRoutes.js';

export function applyRuntimeIntegration(app) {
  app.get('/api/runtime/runtime-status', (req, res) => {
    res.json({
      ok: true,
      runtime: 'active',
      service: 'reversal-proxy',
    });
  });

  app.use('/api/replay', replayRoutes);
  app.use('/api/replay-legacy', replayLegacyRoutes);
}
