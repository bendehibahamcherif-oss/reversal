import watchlistsRoutes from '../routes/watchlists.js';
import layoutsRoutes from '../routes/layouts.js';
import executionsRoutes from '../routes/executions.js';

import { rateLimiter } from '../security/rateLimiter.js';

export function applyProductionIntegration(app) {
  app.use(rateLimiter());

  app.use('/watchlists', watchlistsRoutes);
  app.use('/layouts', layoutsRoutes);
  app.use('/executions', executionsRoutes);
}
