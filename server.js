import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import pg from 'pg';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const MAX_RESULT_NS = BigInt(process.env.MAX_RESULT_NS || '60000000000');

const app = express();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://accounts.google.com', "'unsafe-inline'"],
      frameSrc: ['https://accounts.google.com'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://accounts.google.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
    },
  },
}));
app.use(cors({
  origin: (requestOrigin, callback) => {
    if (!requestOrigin || CORS_ORIGINS.includes(requestOrigin)) return callback(null, true);
    return callback(new Error('Origin CORS ro\'yxatida yo\'q.'));
  },
}));
app.use(express.json({ limit: '8kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(express.static(__dirname));

let databaseInitPromise = null;
async function ensureDatabase() {
  if (!pool) throw new Error('DATABASE_URL serverda sozlanmagan.');
  if (!databaseInitPromise) databaseInitPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scores (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      best_ns NUMERIC(30, 0) NOT NULL CHECK (best_ns > 0 AND best_ns <= 60000000000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS scores_best_ns_idx ON scores(best_ns);
  `).catch((error) => {
    databaseInitPromise = null;
    throw error;
  });
  await databaseInitPromise;
}

app.use('/api', async (request, response, next) => {
  try {
    await ensureDatabase();
    return next();
  } catch (error) {
    console.error('Database ulanish xatosi:', error.message);
    return response.status(503).json({ error: 'Database hozircha ishlamayapti.' });
  }
});

async function requireGoogleUser(request, response, next) {
  if (!googleClient) return response.status(503).json({ error: 'GOOGLE_CLIENT_ID serverda sozlanmagan.' });
  const authorization = request.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return response.status(401).json({ error: 'Bearer Google ID token talab qilinadi.' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || payload.email_verified !== true) return response.status(401).json({ error: 'Google akkaunti tasdiqlanmagan.' });
    request.user = { id: payload.sub, email: payload.email || '', name: payload.name || 'Google user' };
    return next();
  } catch (error) {
    return response.status(401).json({ error: 'Google ID token yaroqsiz yoki muddati tugagan.' });
  }
}

const submitSchema = z.object({
  elapsedNs: z.string().regex(/^\d+$/),
});

function parseNanoseconds(value) {
  const elapsedNs = BigInt(value);
  if (elapsedNs < 1n || elapsedNs > MAX_RESULT_NS) throw new Error('Nanosekund qiymati ruxsat etilgan oraliqdan tashqarida.');
  return elapsedNs;
}

function formatUnits(elapsedNs) {
  const milliseconds = elapsedNs / 1_000_000n;
  const microseconds = elapsedNs / 1_000n;
  return { nanoseconds: elapsedNs.toString(), microseconds: microseconds.toString(), milliseconds: milliseconds.toString() };
}

function makeNickname(name, email) {
  const base = (name || email.split('@')[0] || 'player').normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 14) || 'player';
  return base.length >= 3 ? base : `${base}_01`;
}

async function getOrCreateUser(user) {
  const existing = await pool.query('SELECT id, email, nickname FROM users WHERE id = $1', [user.id]);
  if (existing.rows[0]) return existing.rows[0];
  const base = makeNickname(user.name, user.email);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const nickname = suffix === 0 ? base : `${base.slice(0, 18 - String(suffix).length - 1)}_${suffix}`;
    try {
      const created = await pool.query('INSERT INTO users (id, email, nickname) VALUES ($1, $2, $3) RETURNING id, email, nickname', [user.id, user.email, nickname]);
      return created.rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
      const concurrentUser = await pool.query('SELECT id, email, nickname FROM users WHERE id = $1', [user.id]);
      if (concurrentUser.rows[0]) return concurrentUser.rows[0];
    }
  }
  throw new Error('Avtomatik nickname yaratib bo\'lmadi.');
}

async function optionalGoogleUser(request, response, next) {
  if (!request.get('authorization')) return next();
  return requireGoogleUser(request, response, next);
}

app.get('/api/leaderboard', optionalGoogleUser, async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit || '10', 10) || 10, 1), 1000);
    const offset = Math.max(Number.parseInt(request.query.offset || '0', 10) || 0, 0);
    const user = request.user ? await getOrCreateUser(request.user) : null;
    const result = await pool.query(`SELECT ROW_NUMBER() OVER (ORDER BY s.best_ns ASC, u.nickname ASC) AS rank, u.id, u.nickname, s.best_ns FROM scores s JOIN users u ON u.id = s.user_id ORDER BY s.best_ns ASC, u.nickname ASC LIMIT $1 OFFSET $2`, [limit, offset]);
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM scores');
    let current = null;
    if (user) {
      const currentResult = await pool.query(`SELECT u.nickname, s.best_ns, (SELECT COUNT(*) + 1 FROM scores better WHERE better.best_ns < s.best_ns) AS rank FROM scores s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`, [user.id]);
      if (currentResult.rows[0]) current = { rank: Number(currentResult.rows[0].rank), nickname: currentResult.rows[0].nickname, ...formatUnits(BigInt(currentResult.rows[0].best_ns)) };
    }
    return response.json({ data: result.rows.map((row) => ({ rank: Number(row.rank), nickname: row.nickname, ...formatUnits(BigInt(row.best_ns)) })), current, total: total.rows[0].count, hasMore: offset + result.rows.length < total.rows[0].count });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/leaderboard/me', requireGoogleUser, async (request, response, next) => {
  try {
    const user = await getOrCreateUser(request.user);
    return response.json({ nickname: user.nickname });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/leaderboard/submit', requireGoogleUser, rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.SUBMIT_RATE_LIMIT || 30), standardHeaders: 'draft-8', legacyHeaders: false }), async (request, response, next) => {
  try {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'elapsedNs formati noto\'g\'ri.' });
    const elapsedNs = parseNanoseconds(parsed.data.elapsedNs);
    const user = await getOrCreateUser(request.user);
    const result = await pool.query(`INSERT INTO scores (user_id, best_ns) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET best_ns = EXCLUDED.best_ns, updated_at = NOW() WHERE EXCLUDED.best_ns < scores.best_ns RETURNING best_ns`, [user.id, elapsedNs.toString()]);
    return response.status(result.rowCount ? 201 : 200).json({ improved: Boolean(result.rowCount), ...formatUnits(elapsedNs) });
  } catch (error) {
    if (error.message.includes('Nanosekund')) return response.status(400).json({ error: error.message });
    return next(error);
  }
});

app.get('/health', async (request, response) => {
  try {
    await ensureDatabase();
    return response.status(200).json({ status: 'up', database: 'postgresql' });
  } catch (error) {
    console.error('Health check xatosi:', error);
    return response.status(503).json({ status: 'down', database: 'postgresql' });
  }
});

app.use((error, request, response, next) => {
  console.error('Kutilmagan API xatosi:', error);
  return response.status(500).json({ error: 'Ichki server xatosi.' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Leaderboard API ${PORT}-portda ishga tushdi.`));
}

export default app;