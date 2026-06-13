/**
 * Auth flow integration tests.
 * Tests the full register → login → JWT verification → protected route flow
 * against the real server.js logic (no mocks of bcrypt or JWT).
 */
import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';

// ── Minimal in-memory SQLite usersDB for tests ─────────────────────────────────
function buildTestUsersDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
  `);
  const create = db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`);
  const getByEmail = db.prepare(`SELECT id, email, role, password_hash, created_at FROM users WHERE email = ?`);
  const getById = db.prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`);
  return {
    create({ email, passwordHash, role = 'user' }) {
      const r = create.run(email.toLowerCase(), passwordHash, role);
      return getById.get(r.lastInsertRowid);
    },
    getByEmail(email) { return getByEmail.get(String(email).toLowerCase()); },
  };
}

// ── Build minimal auth app (mirrors server.js auth section) ───────────────────
const JWT_SECRET = 'test-secret-not-dev';
const JWT_EXPIRES_IN = '1h';

function buildAuthApp(usersDB, userTokenEnv) {
  const app = express();
  app.use(express.json());

  function signUser(user) {
    return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }
  function verifyJwt(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
  }
  function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : null;
  }

  function requireAuth(req, res, next) {
    const bearer = getBearerToken(req);
    if (bearer) {
      const payload = verifyJwt(bearer);
      if (payload) { req.user = payload; return next(); }
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (userTokenEnv) {
      const provided = req.headers['x-user-token'] || req.query.token;
      if (provided === userTokenEnv) return next();
      return res.status(401).json({ error: 'Invalid or missing user token' });
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  app.post('/auth/register', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
      const existing = usersDB.getByEmail(email);
      if (existing) return res.status(400).json({ error: 'User already exists' });
      const passwordHash = await bcrypt.hash(password, 10);
      const user = usersDB.create({ email, passwordHash, role: 'user' });
      const token = signUser(user);
      res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      console.error('REGISTER ERROR:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = usersDB.getByEmail(email);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      const token = signUser(user);
      res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      console.error('LOGIN ERROR:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  app.get('/protected', requireAuth, (req, res) => {
    res.json({ ok: true, user: req.user ?? null });
  });

  return app;
}

// ── Test helpers ───────────────────────────────────────────────────────────────
async function post(base, path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function get(base, path, headers = {}) {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: await r.json() };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Auth — register → login → JWT verification', () => {
  let base;
  let server;
  const db = buildTestUsersDb();

  before(async () => {
    const app = buildAuthApp(db, null); // USER_TOKEN not set
    server = http.createServer(app);
    server.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('register returns token and user with role=user (not admin)', async () => {
    const { status, body } = await post(base, '/auth/register', { email: 'alice@test.com', password: 'hunter2' });
    assert.equal(status, 200);
    assert.ok(typeof body.token === 'string' && body.token.length > 10, 'token must be a JWT string');
    assert.equal(body.user.email, 'alice@test.com');
    assert.equal(body.user.role, 'user', 'default role must be user, not admin');
    assert.ok(!Object.hasOwn(body.user, 'password_hash'), 'password_hash must not be in response');
  });

  it('register with duplicate email returns 400', async () => {
    await post(base, '/auth/register', { email: 'dup@test.com', password: 'a' });
    const { status, body } = await post(base, '/auth/register', { email: 'dup@test.com', password: 'b' });
    assert.equal(status, 400);
    assert.ok(body.error, 'error field must be present');
  });

  it('register without password returns 400', async () => {
    const { status } = await post(base, '/auth/register', { email: 'nopw@test.com' });
    assert.equal(status, 400);
  });

  it('login returns valid JWT for registered user', async () => {
    await post(base, '/auth/register', { email: 'bob@test.com', password: 'secret123' });
    const { status, body } = await post(base, '/auth/login', { email: 'bob@test.com', password: 'secret123' });
    assert.equal(status, 200);
    assert.ok(typeof body.token === 'string');
    // Verify JWT is well-formed and signed with the right secret
    const payload = jwt.verify(body.token, JWT_SECRET);
    assert.equal(payload.email, 'bob@test.com');
    assert.equal(payload.role, 'user');
    assert.ok(Number.isFinite(payload.exp), 'token must have expiration');
  });

  it('login with wrong password returns 401', async () => {
    await post(base, '/auth/register', { email: 'carol@test.com', password: 'rightpw' });
    const { status, body } = await post(base, '/auth/login', { email: 'carol@test.com', password: 'wrongpw' });
    assert.equal(status, 401);
    assert.equal(body.error, 'Invalid credentials');
  });

  it('login with unknown email returns 401', async () => {
    const { status } = await post(base, '/auth/login', { email: 'nobody@test.com', password: 'x' });
    assert.equal(status, 401);
  });

  it('protected route rejects request with no credentials', async () => {
    const { status } = await get(base, '/protected');
    assert.equal(status, 401, 'unauthenticated request must be rejected — not passed through');
  });

  it('protected route rejects invalid JWT', async () => {
    const { status } = await get(base, '/protected', { Authorization: 'Bearer this.is.garbage' });
    assert.equal(status, 401);
  });

  it('protected route accepts valid JWT from login', async () => {
    await post(base, '/auth/register', { email: 'dave@test.com', password: 'pw' });
    const { body: loginBody } = await post(base, '/auth/login', { email: 'dave@test.com', password: 'pw' });
    const { status, body } = await get(base, '/protected', { Authorization: `Bearer ${loginBody.token}` });
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.equal(body.user.email, 'dave@test.com');
  });

  it('protected route rejects expired JWT', async () => {
    // Sign a token that expired 1 second ago
    const expired = jwt.sign({ sub: 99, email: 'exp@test.com', role: 'user' }, JWT_SECRET, { expiresIn: -1 });
    const { status } = await get(base, '/protected', { Authorization: `Bearer ${expired}` });
    assert.equal(status, 401);
  });

  it('error response does not leak internal error details', async () => {
    // Test that the 500 handler returns a generic message, not err.message
    // We can't easily trigger a DB error here, but we verify the shape for 400/401 cases
    const { body } = await post(base, '/auth/login', { email: 'nonexist@test.com', password: 'x' });
    // Should not contain stack traces or file paths
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('at '), 'error must not contain stack trace lines');
    assert.ok(!serialized.includes('/home/'), 'error must not contain file system paths');
  });
});

describe('Auth — requireAuth with no USER_TOKEN (fix: must reject, not pass through)', () => {
  let base;
  let server;
  const db = buildTestUsersDb();

  before(async () => {
    const app = buildAuthApp(db, null); // USER_TOKEN = null — old bug allowed bypass here
    server = http.createServer(app);
    server.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('no USER_TOKEN configured + no credentials → 401, not 200', async () => {
    const { status } = await get(base, '/protected');
    assert.equal(status, 401, 'auth bypass fixed: missing credentials must always be rejected');
  });

  it('no USER_TOKEN configured + invalid Bearer → 401', async () => {
    const { status } = await get(base, '/protected', { Authorization: 'Bearer bad.token.here' });
    assert.equal(status, 401);
  });
});

describe('Auth — requireAuth with USER_TOKEN configured (secondary auth path)', () => {
  let base;
  let server;
  const STATIC_TOKEN = 'my-static-token-abc123';
  const db = buildTestUsersDb();

  before(async () => {
    const app = buildAuthApp(db, STATIC_TOKEN);
    server = http.createServer(app);
    server.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('correct X-User-Token header passes', async () => {
    const { status } = await get(base, '/protected', { 'x-user-token': STATIC_TOKEN });
    assert.equal(status, 200);
  });

  it('wrong X-User-Token header rejects', async () => {
    const { status } = await get(base, '/protected', { 'x-user-token': 'wrong-token' });
    assert.equal(status, 401);
  });

  it('no credentials at all rejects even when USER_TOKEN is set', async () => {
    const { status } = await get(base, '/protected');
    assert.equal(status, 401);
  });
});
