// Muhit o'zgaruvchilarini process.env ichiga yuklaymiz.
import 'dotenv/config';
// HTTP API yaratish uchun Express frameworkini import qilamiz.
import express from 'express';
// Xavfsiz HTTP headerlarini qo'shamiz.
import helmet from 'helmet';
// Frontend originlarini boshqarish uchun CORS middleware'ini import qilamiz.
import cors from 'cors';
// Har bir endpointga ortiqcha so'rov yuborishni cheklaymiz.
import rateLimit from 'express-rate-limit';
// Google ID tokenlarini imzo va audience bo'yicha tekshiramiz.
import { OAuth2Client } from 'google-auth-library';
// Railway PostgreSQL serveriga ulanish uchun rasmiy klientni import qilamiz.
import pg from 'pg';
// Kiruvchi JSON ma'lumotlarini qat'iy tekshirish uchun Zod ishlatamiz.
import { z } from 'zod';
// Statik fayllar papkasi manzilini hisoblash uchun kerak.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM'da __dirname mavjud emas, shuning uchun o'zimiz hisoblaymiz.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// HTTP portini konfiguratsiyadan olamiz.
const PORT = Number(process.env.PORT || 3000);
// Railway PostgreSQL ulanish URL'sini konfiguratsiyadan olamiz.
const DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
// Google OAuth client ID'si ID token audience'i bilan aynan bir xil bo'lishi kerak.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// Frontend originlarini wildcard emas, vergul bilan ajratilgan aniq ro'yxat sifatida qabul qilamiz.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
// Bir rekord uchun maksimal ruxsat etilgan vaqtni BigInt ko'rinishida saqlaymiz.
const MAX_RESULT_NS = BigInt(process.env.MAX_RESULT_NS || '60000000000');

// Express ilovasini yaratamiz.
const app = express();
// Google ID tokenlarini tekshiruvchi klientni yaratamiz.
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// Railway PostgreSQL klientini konfiguratsiya qilamiz.
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;
// Xavfsiz default headerlarini yoqamiz, lekin Google Identity Services va Google Fonts uchun ruxsat qo'shamiz.
app.use(helmet({
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
// Har bir so'rov uchun faqat bitta mos originni qaytaramiz; brauzer bir nechta
// Access-Control-Allow-Origin qiymatini qabul qilmaydi.
app.use(cors({
  origin: (requestOrigin, callback) => {
    if (!requestOrigin || CORS_ORIGINS.includes(requestOrigin)) return callback(null, true);
    return callback(new Error('Origin CORS ro\'yxatida yo\'q.'));
  },
}));
// JSON body hajmini kichik qilib, keraksiz katta payloadlarni rad qilamiz.
app.use(express.json({ limit: '8kb' }));
// Barcha API'lar uchun umumiy so'rov tezligini cheklaymiz.
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
// Frontend statik fayllarini (index.html, script.js, style.css) shu server orqali xizmat qilamiz.
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

// Google ID tokenidan ishonchli foydalanuvchi ma'lumotini oluvchi middleware.
async function requireGoogleUser(request, response, next) {
  // Konfiguratsiya xatosi butun frontendni yiqitmasin; faqat autentifikatsiya endpointi ishlamasin.
  if (!googleClient) return response.status(503).json({ error: 'GOOGLE_CLIENT_ID serverda sozlanmagan.' });
  // Authorization headerini olamiz.
  const authorization = request.get('authorization') || '';
  // Faqat Bearer sxemasidagi tokenni qabul qilamiz.
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  // Token bo'lmasa, so'rovni autentifikatsiyasiz davom ettirmaymiz.
  if (!token) return response.status(401).json({ error: 'Bearer Google ID token talab qilinadi.' });
  // Tokenni Google public keys, issuer va audience bilan tekshiramiz.
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    // Tekshirilgan payloadni keyingi handlerga uzatamiz.
    const payload = ticket.getPayload();
    // Google subject identifikatori bo'lmasa, foydalanuvchi identifikatsiyasi ishonchsiz hisoblanadi.
    if (!payload?.sub || payload.email_verified !== true) return response.status(401).json({ error: 'Google akkaunti tasdiqlanmagan.' });
    // Faqat verification'dan o'tgan qiymatlarni request obyektiga biriktiramiz.
    request.user = { id: payload.sub, email: payload.email || '', name: payload.name || 'Google user' };
    // Keyingi middleware yoki route handlerga o'tamiz.
    return next();
  } catch (error) {
    // Token xatosining ichki tafsilotlarini mijozga chiqarmaymiz.
    return response.status(401).json({ error: 'Google ID token yaroqsiz yoki muddati tugagan.' });
  }
}

// POST body uchun faqat decimal nanosekund stringini qabul qilamiz.
const submitSchema = z.object({
  // BigInt JSON orqali yuborilmagani uchun nanosekund string sifatida qabul qilinadi.
  elapsedNs: z.string().regex(/^\d+$/),
});

// Decimal stringni xavfsiz BigInt'ga aylantiruvchi funksiya.
function parseNanoseconds(value) {
  // Oddiy Number ishlatmaymiz, chunki u 2^53 dan keyin nanosekundlarni yaxlitlaydi.
  const elapsedNs = BigInt(value);
  // Nol va juda katta qiymatlarni rad qilamiz.
  if (elapsedNs < 1n || elapsedNs > MAX_RESULT_NS) throw new Error('Nanosekund qiymati ruxsat etilgan oraliqdan tashqarida.');
  // Keyingi hisoblar uchun aniq BigInt qiymatni qaytaramiz.
  return elapsedNs;
}

// Nanosekundni foydalanuvchiga kerakli uch birlikka ajratamiz.
function formatUnits(elapsedNs) {
  // Millisekundning butun qismi va qolgan nanosekundni ajratamiz.
  const milliseconds = elapsedNs / 1_000_000n;
  // Mikrosekundning butun qismi va qolgan nanosekundni ajratamiz.
  const microseconds = elapsedNs / 1_000n;
  // BigInt qiymatlarni JSON serializatsiyasiga mos decimal string sifatida qaytaramiz.
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

// API health-check endpointini taqdim qilamiz.
app.get('/health', async (request, response) => {
  try {
    await ensureDatabase();
    return response.status(200).json({ status: 'up', database: 'postgresql' });
  } catch (error) {
    console.error('Health check xatosi:', error);
    return response.status(503).json({ status: 'down', database: 'postgresql' });
  }
});

// Kutilmagan xatolar uchun oxirgi Express error handleri.
app.use((error, request, response, next) => {
  // Server logida to'liq xatoni saqlaymiz.
  console.error('Kutilmagan API xatosi:', error);
  // Mijozga ichki stack trace chiqarmaymiz.
  return response.status(500).json({ error: 'Ichki server xatosi.' });
});

// Faqat lokal/Docker rejimida (Vercel'da emas) an'anaviy HTTP serverni tinglaymiz.
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Leaderboard API ${PORT}-portda ishga tushdi.`));
}

// Vercel serverless funksiyasi sifatida ishlatish uchun Express ilovasini eksport qilamiz.
export default app;