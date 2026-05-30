// Singleton that bridges the socket.io `io` instance (created in server.js)
// to interior modules (CVD engine, alert engine, etc.) without circular imports.
// Call setIo(io) once after socket.io is initialized; then any module can
// import wsEmit() and emit to all connected clients.
//
// ── WebSocket scaling path ─────────────────────────────────────────────────────
// Current adapter: in-memory (single instance only).
//
// To scale horizontally, swap to the Redis adapter BEFORE any emits:
//
//   import { createAdapter } from '@socket.io/redis-adapter';
//   import { createClient }  from 'ioredis';
//
//   const pub = createClient({ url: process.env.REDIS_URL });
//   const sub = pub.duplicate();
//   await Promise.all([pub.connect(), sub.connect()]);
//   io.adapter(createAdapter(pub, sub));
//   setIo(io);
//
// This change is backward-compatible: wsEmit/wsEmitToRoom calls are unchanged.
// The adapter swap must happen in server.js before setIo() is called.

let _io               = null;
let _connectionCount  = 0;

export function setIo(io) {
  _io = io;
  io.on('connection', (socket) => {
    _connectionCount++;
    socket.on('disconnect', () => {
      _connectionCount = Math.max(0, _connectionCount - 1);
    });
  });
}

export function wsEmit(event, data) {
  if (_io) _io.emit(event, data);
}

export function wsEmitToRoom(room, event, data) {
  if (_io) _io.to(room).emit(event, data);
}

// Returns current WebSocket connection stats for the observability endpoint.
export function getWsStats() {
  return {
    connectedClients:    _connectionCount,
    adapterType:         'in-memory',
    scalingReady:        false,
    scalingNote:         'Swap to @socket.io/redis-adapter for multi-instance scaling (see wsEmitter.js header).',
    redisAdapterPackage: '@socket.io/redis-adapter',
    upgradeSteps: [
      'npm install @socket.io/redis-adapter ioredis',
      'Configure REDIS_URL environment variable',
      'Apply io.adapter(createAdapter(pub, sub)) in server.js before setIo(io)',
    ],
  };
}
