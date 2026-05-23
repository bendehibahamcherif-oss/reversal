import express from 'express';
import cors from 'cors';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Server } from 'socket.io';

import {
  alertsDB,
  settingsDB,
  usersDB,
} from './db.js';

import { connectDatabase } from './database/db.js';

import { applyProductionIntegration }
  from './bootstrap/productionIntegration.js';

const app = express();

const PORT =
  process.env.PORT || 10000;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.USER_TOKEN ||
  'dev-secret-change-me';

const JWT_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN || '12h';

app.use(
  express.json({
    limit: '500kb',
  })
);

applyProductionIntegration(app);

const ALLOWED_ORIGINS_RAW =
  process.env.ALLOWED_ORIGINS || '*';

const allowedOrigins =
  ALLOWED_ORIGINS_RAW === '*'
    ? '*'
    : ALLOWED_ORIGINS_RAW
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    methods: [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
    ],
    allowedHeaders: [
      'Content-Type',
      'X-User-Token',
      'Authorization',
    ],
  })
);

const USER_TOKEN =
  process.env.USER_TOKEN || null;

function signUser(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
}

function getBearerToken(req) {
  const auth =
    req.headers.authorization || '';

  return auth.startsWith('Bearer ')
    ? auth.slice(7)
    : null;
}

function verifyJwt(token) {
  try {
    return jwt.verify(
      token,
      JWT_SECRET
    );
  } catch {
    return null;
  }
}

function requireAuth(
  req,
  res,
  next
) {
  const bearer =
    getBearerToken(req);

  if (bearer) {
    const payload =
      verifyJwt(bearer);

    if (payload) {
      req.user = payload;
      return next();
    }
  }

  if (!USER_TOKEN) {
    return next();
  }

  const provided =
    req.headers['x-user-token'] ||
    req.query.token;

  if (provided === USER_TOKEN) {
    return next();
  }

  return res.status(401).json({
    error:
      'Invalid or missing user token',
  });
}

function requireAdmin(
  req,
  res,
  next
) {
  if (req.user?.role === 'admin') {
    return next();
  }

  const provided =
    req.headers['x-user-token'] ||
    req.query.token;

  if (
    USER_TOKEN &&
    provided === USER_TOKEN
  ) {
    return next();
  }

  return res.status(403).json({
    error: 'Admin access required',
  });
}

function getSocketToken(socket) {
  const bearer =
    socket.handshake.auth?.jwt ||
    socket.handshake.auth?.token;

  const header =
    socket.handshake.headers
      .authorization || '';

  if (
    header.startsWith('Bearer ')
  ) {
    return header.slice(7);
  }

  return (
    bearer ||
    socket.handshake.headers[
      'x-user-token'
    ] ||
    socket.handshake.query?.token
  );
}

const server =
  http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'X-User-Token',
      'Authorization',
    ],
  },
});

io.use((socket, next) => {
  const token =
    getSocketToken(socket);

  if (!token && !USER_TOKEN) {
    return next();
  }

  if (
    token &&
    verifyJwt(token)
  ) {
    return next();
  }

  if (
    USER_TOKEN &&
    token === USER_TOKEN
  ) {
    return next();
  }

  return next(
    new Error(
      'Invalid or missing auth token'
    )
  );
});

const cache = new Map();

const CACHE_TTL = parseInt(
  process.env.CACHE_TTL_MS ||
    '30000',
  10
);

function getCached(key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (
    Date.now() -
      entry.timestamp >
    CACHE_TTL
  ) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCached(key, data) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
  });

  if (cache.size > 500) {
    [...cache.entries()]
      .sort(
        (a, b) =>
          a[1].timestamp -
          b[1].timestamp
      )
      .slice(0, 250)
      .forEach(([key]) =>
        cache.delete(key)
      );
  }
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 8000
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal:
        controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service:
      'reversal-proxy',
    version:
      '3.1-admin-users',
    authEnabled:
      !!USER_TOKEN,
    jwtEnabled: true,
    cors:
      ALLOWED_ORIGINS_RAW,
    cacheSize: cache.size,
    cacheTTLms: CACHE_TTL,
    uptimeSeconds:
      Math.floor(
        process.uptime()
      ),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
  });
});

app.post(
  '/auth/register',
  async (req, res) => {
    try {
      const {
        email,
        password,
      } = req.body;

      if (
        !email ||
        !password
      ) {
        return res
          .status(400)
          .json({
            error:
              'Missing email or password',
          });
      }

      const existing =
        usersDB
          .prepare(
            `
          SELECT * FROM users
          WHERE email = ?
        `
          )
          .get(email);

      if (existing) {
        return res
          .status(400)
          .json({
            error:
              'User already exists',
          });
      }

      const hashed =
        await bcrypt.hash(
          password,
          10
        );

      const result =
        usersDB
          .prepare(
            `
          INSERT INTO users
          (email, password, role)
          VALUES (?, ?, ?)
        `
          )
          .run(
            email,
            hashed,
            'user'
          );

      const user = {
        id: result.lastInsertRowid,
        email,
        role: 'user',
      };

      const token =
        signUser(user);

      res.json({
        token,
        user,
      });
    } catch (err) {
      res.status(500).json({
        error:
          'Registration failed',
      });
    }
  }
);

app.post(
  '/auth/login',
  async (req, res) => {
    try {
      const {
        email,
        password,
      } = req.body;

      const user =
        usersDB
          .prepare(
            `
          SELECT * FROM users
          WHERE email = ?
        `
          )
          .get(email);

      if (!user) {
        return res
          .status(401)
          .json({
            error:
              'Invalid credentials',
          });
      }

      const valid =
        await bcrypt.compare(
          password,
          user.password
        );

      if (!valid) {
        return res
          .status(401)
          .json({
            error:
              'Invalid credentials',
          });
      }

      const token =
        signUser(user);

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      res.status(500).json({
        error:
          'Login failed',
      });
    }
  }
);

app.get(
  '/auth/me',
  requireAuth,
  (req, res) => {
    res.json({
      user: req.user,
    });
  }
);

await connectDatabase();

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `🚀 Reversal API + WebSocket running on port ${PORT}`
    );

    console.log(
      `🔐 Auth: ${
        USER_TOKEN
          ? 'ENABLED'
          : 'DISABLED'
      } / JWT ENABLED`
    );

    console.log(
      `🌍 CORS: ${ALLOWED_ORIGINS_RAW}`
    );
  }
);