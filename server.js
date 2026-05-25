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
import { applyRuntimeIntegration }
  from './server/bootstrap/runtimeIntegration.js';

const app = express();

const PORT = process.env.PORT || 10000;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.USER_TOKEN ||
  'dev-secret-change-me';

const JWT_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN || '12h';

const ALLOWED_ORIGINS_RAW =
  process.env.ALLOWED_ORIGINS || '*';

const allowedOrigins =
  ALLOWED_ORIGINS_RAW === '*'
    ? '*'
    : ALLOWED_ORIGINS_RAW
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-User-Token',
  ],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '500kb' }));

applyProductionIntegration(app);
applyRuntimeIntegration(app);

const USER_TOKEN = process.env.USER_TOKEN || null;

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
  const auth = req.headers.authorization || '';

  return auth.startsWith('Bearer ')
    ? auth.slice(7)
    : null;
}

function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const bearer = getBearerToken(req);

  if (bearer) {
    const payload = verifyJwt(bearer);

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
    error: 'Invalid or missing user token',
  });
}

const server = http.createServer(app);

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

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'reversal-proxy',
    version: '3.2-auth-fixed',
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Missing email or password',
      });
    }

    const existing = usersDB.getByEmail(email);

    if (existing) {
      return res.status(400).json({
        error: 'User already exists',
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = usersDB.create({
      email,
      passwordHash,
      role: 'user',
    });

    const token = signUser(user);

    res.json({
      token,
      user,
    });
  } catch (err) {
    console.error('REGISTER ERROR:', err);

    res.status(500).json({
      error: err.message,
    });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = usersDB.getByEmail(email);

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: 'Invalid credentials',
      });
    }

    const token = signUser(user);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);

    res.status(500).json({
      error: err.message,
    });
  }
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
  });
});

await connectDatabase();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Reversal API + WebSocket running on port ${PORT}`);

  console.log(
    `🔐 Auth: ${
      USER_TOKEN ? 'ENABLED' : 'DISABLED'
    } / JWT ENABLED`
  );

  console.log(`🌍 CORS: ${ALLOWED_ORIGINS_RAW}`);
});
