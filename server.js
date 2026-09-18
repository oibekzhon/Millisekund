import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { z } from 'zod';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const MAX_RESULT_NS = BigInt(process.env.MAX_RESULT_NS || '60000000000');

const app = express();
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
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
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    CREATE TABLE IF NOT EXISTS scores (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      best_ns NUMERIC(30, 0) NOT NULL CHECK (best_ns > 0 AND best_ns <= 60000000000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
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

async function requireUser(request, response, next) {
  const authorization = request.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return response.status(401).json({ error: 'Session token talab qilinadi.' });
  const result = await pool.query('SELECT u.id, u.nickname FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()', [hashToken(token)]);
  if (!result.rows[0]) return response.status(401).json({ error: 'Session muddati tugagan. Qayta kiring.' });
  request.user = result.rows[0];
  return next();
}

const submitSchema = z.object({
  elapsedNs: z.string().regex(/^\d+$/),
});

function parseNanoseconds(value) {
  const elapsedNs = BigInt(value);
  if (elapsedNs < 1n || elapsedNs > MAX_RESULT_NS) throw new Error('Nanosekund qiymati ruxsat etilgan oraliqdan tashqarida.');
  return elapsedNs;
}

function normalizeNanoseconds(elapsedNs) {
  let prefix = elapsedNs - (elapsedNs % 100_000n);
  const prefixSeed = Number((prefix / 100_000n) % 9n);
  const source = (elapsedNs % 100_000n).toString().padStart(5, '0');
  const suffix = [...source].map((digit, index) => digit === '0' ? String((prefixSeed + index) % 9 + 1) : digit).join('');
  const normalized = prefix + BigInt(suffix);
  if (normalized <= MAX_RESULT_NS) return normalized;
  prefix = prefix >= 100_000n ? prefix - 100_000n : 0n;
  return prefix + BigInt(suffix);
}

function formatWithGrouping(numberText) {
  return numberText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatFixedDecimal(value, digits) {
  const formatted = Number(value).toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  const [whole, fraction] = formatted.split('.');
  const groupedWhole = formatWithGrouping(whole);
  return fraction ? `${groupedWhole}.${fraction}` : groupedWhole;
}

function formatNanoseconds(value) {
  return formatWithGrouping(BigInt(value).toString());
}

function formatUnits(elapsedNs) {
  return {
    nanoseconds: formatNanoseconds(elapsedNs),
    microseconds: formatWithGrouping((elapsedNs / 1_000n).toString()),
    milliseconds: formatWithGrouping((elapsedNs / 1_000_000n).toString()),
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = storedHash.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const authSchema = z.object({ nickname: z.string().trim().min(3).max(18).regex(/^[A-Za-z0-9_]+$/), password: z.string().min(6).max(128) });

app.post('/api/auth/session', rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), async (request, response, next) => {
  try {
    const parsed = authSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Nik 3-18 belgi, parol esa kamida 6 belgi bo\'lsin.' });
    const { nickname, password } = parsed.data;
    let user = (await pool.query('SELECT id, nickname, password_hash FROM users WHERE LOWER(nickname) = LOWER($1)', [nickname])).rows[0];
    if (user) {
      if (!user.password_hash || !verifyPassword(password, user.password_hash)) return response.status(401).json({ error: 'Nik yoki parol noto\'g\'ri.' });
    } else {
      const id = randomBytes(16).toString('hex');
      try {
        user = (await pool.query('INSERT INTO users (id, nickname, password_hash) VALUES ($1, $2, $3) RETURNING id, nickname', [id, nickname, hashPassword(password)])).rows[0];
      } catch (error) {
        if (error.code !== '23505') throw error;
        return response.status(409).json({ error: 'Bu nik allaqachon ishlatilgan. Parolingiz bilan kiring.' });
      }
    }
    const token = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')', [hashToken(token), user.id]);
    return response.json({ token, nickname: user.nickname });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/auth/session', async (request, response, next) => {
  try {
    const authorization = request.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (token) await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [hashToken(token)]);
    return response.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

async function optionalUser(request, response, next) {
  if (!request.get('authorization')) return next();
  return requireUser(request, response, next);
}

app.get('/api/leaderboard', optionalUser, async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit || '10', 10) || 10, 1), 1000);
    const offset = Math.max(Number.parseInt(request.query.offset || '0', 10) || 0, 0);
    const user = request.user || null;
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

app.get('/api/leaderboard/me', requireUser, async (request, response, next) => {
  try {
    return response.json({ nickname: request.user.nickname });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/leaderboard/submit', requireUser, rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.SUBMIT_RATE_LIMIT || 30), standardHeaders: 'draft-8', legacyHeaders: false }), async (request, response, next) => {
  try {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'elapsedNs formati noto\'g\'ri.' });
    const elapsedNs = normalizeNanoseconds(parseNanoseconds(parsed.data.elapsedNs));
    const result = await pool.query(`INSERT INTO scores (user_id, best_ns) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET best_ns = EXCLUDED.best_ns, updated_at = NOW() WHERE EXCLUDED.best_ns < scores.best_ns RETURNING best_ns`, [request.user.id, elapsedNs.toString()]);
    return response.status(result.rowCount ? 201 : 200).json({ improved: Boolean(result.rowCount), elapsedNs: elapsedNs.toString(), ...formatUnits(elapsedNs) });
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