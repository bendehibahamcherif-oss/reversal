export function auditLogger(req, res, next) {
  const startedAt = Date.now();

  res.on('finish', () => {
    console.log(
      JSON.stringify({
        type: 'AUDIT_LOG',
        method: req.method,
        path: req.originalUrl,
        user: req.user?.email || null,
        status: res.statusCode,
        durationMs:
          Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      })
    );
  });

  next();
}
