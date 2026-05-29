const requests = new Map();

export function rateLimiter({
  windowMs = 60000,
  max = Number(process.env.RATE_LIMIT_MAX) || 100,
} = {}) {
  return (req, res, next) => {
    const key = req.ip;

    const now = Date.now();

    if (!requests.has(key)) {
      requests.set(key, []);
    }

    const timestamps = requests
      .get(key)
      .filter((t) => now - t < windowMs);

    timestamps.push(now);

    requests.set(key, timestamps);

    if (timestamps.length > max) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
      });
    }

    next();
  };
}
