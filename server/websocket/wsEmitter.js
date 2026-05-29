// Singleton that bridges the socket.io `io` instance (created in server.js)
// to interior modules (CVD engine, alert engine, etc.) without circular imports.
// Call setIo(io) once after socket.io is initialized; then any module can
// import wsEmit() and emit to all connected clients.

let _io = null;

export function setIo(io) {
  _io = io;
}

export function wsEmit(event, data) {
  if (_io) _io.emit(event, data);
}

export function wsEmitToRoom(room, event, data) {
  if (_io) _io.to(room).emit(event, data);
}
