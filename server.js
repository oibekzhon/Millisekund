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
// Redis serveriga ulanish uchun rasmiy Redis klientini import qilamiz.
import { createClient } from 'redis';
// Kiruvchi JSON ma'lumotlarini qat'iy tekshirish uchun Zod ishlatamiz.
import { z } from 'zod';
// Statik fayllar papkasi manzilini hisoblash uchun kerak.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM'da __dirname mavjud emas, shuning uchun o'zimiz hisoblaymiz.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// HTTP portini konfiguratsiyadan olamiz.
const PORT = Number(process.env.PORT || 3000);
// Redis ulanish URL'sini konfiguratsiyadan olamiz.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// Google OAuth client ID'si ID token audience'i bilan aynan bir xil bo'lishi kerak.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// Frontend originlarini wildcard emas, vergul bilan ajratilgan aniq ro'yxat sifatida qabul qilamiz.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
// Bir rekord uchun maksimal ruxsat etilgan vaqtni BigInt ko'rinishida saqlaymiz.
const MAX_RESULT_NS = BigInt(process.env.MAX_RESULT_NS || '60000000000');
// Redis ZSET member'ining lexicographic tartibi uchun 30 xonali fixed-width format yetarli.
const NANOSECOND_WIDTH = 30;
// Reyting ZSET kalitini bitta global nom bilan belgilaymiz.
const LEADERBOARD_KEY = 'leaderboard:global:v1';
// Foydalanuvchi rekordlari saqlanadigan Redis HASH kalitini belgilaymiz.
const USER_RECORDS_KEY = 'leaderboard:user-records:v1';
// Bitta Google subject'iga bitta nikni qat'iy bog'lash uchun Redis HASH kalitini belgilaymiz.
const USER_NICKNAMES_KEY = 'leaderboard:user-nicknames:v1';

// Express ilovasini yaratamiz.
const app = express();
// Google ID tokenlarini tekshiruvchi klientni yaratamiz.
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// Redis klientini konfiguratsiya qilamiz.
const redis = createClient({ url: REDIS_URL });

// Redis ulanish xatolarini log qilamiz.
redis.on('error', (error) => console.error('Redis xatosi:', error));
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

// Redis'ga faqat bitta marta ulanishni ta'minlaydigan promise (serverless funksiya qayta-qayta chaqirilishi mumkin).
let redisConnectPromise = null;
function ensureRedisConnected() {
  if (!redisConnectPromise) {
    redisConnectPromise = redis.connect().catch((error) => {
      redisConnectPromise = null;
      throw error;
    });
  }
  return redisConnectPromise;
}

// /api bilan boshlanuvchi har bir so'rovdan oldin Redis ulanganiga ishonch hosil qilamiz.
app.use('/api', async (request, response, next) => {
  try {
    await ensureRedisConnected();
    return next();
  } catch (error) {
    return response.status(503).json({ error: 'Redis hozircha ishlamayapti.' });
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
  // Nik global bo'lishi uchun uzunligi va belgilarini cheklaymiz.
  nickname: z.string().trim().min(3).max(18).regex(/^[A-Za-z0-9_]+$/),
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

// Nanosekundni Redis lexicographic tartibiga mos fixed-width qiymatga aylantiramiz.
function encodeNanoseconds(elapsedNs) {
  // Har bir member bir xil uzunlikda bo'lsa, Redis byte tartibi raqam tartibiga teng bo'ladi.
  return elapsedNs.toString().padStart(NANOSECOND_WIDTH, '0');
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

// Rekordni faqat undan yaxshi bo'lsa almashtiradigan atomik Redis Lua skripti.
const saveRecordScript = `
local old = redis.call('HGET', KEYS[2], ARGV[1])
local newMember = ARGV[2] .. ':' .. ARGV[1]
if old and old <= ARGV[2] then
  return 0
end
if old then
  redis.call('ZREM', KEYS[1], old .. ':' .. ARGV[1])
end
redis.call('ZADD', KEYS[1], 0, newMember)
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return 1
`;

// Yagona tartibdagi global top-100 reytingni qaytaruvchi endpoint.
app.get('/api/leaderboard', async (request, response, next) => {
  // Route ichidagi Redis xatolarini umumiy error handlerga yuboramiz.
  try {
    // Barcha ZSET memberlarini score emas, lexicographic tartibda olamiz.
    const members = await redis.sendCommand(['ZRANGE', LEADERBOARD_KEY, '-', '+', 'BYLEX', 'LIMIT', '0', '100']);
    // Har bir member'dan foydalanuvchi ID va fixed-width nanosekundni ajratamiz.
    const rows = await Promise.all(members.map(async (member, index) => {
      // Member formatining oxirgi ':' belgisini ajratamiz.
      const separator = member.lastIndexOf(':');
      // Exact nanosekundni boshidagi nollardan tozalab BigInt'ga aylantiramiz.
      const elapsedNs = BigInt(member.slice(0, separator));
      // Google subjectini member'dan olamiz.
      const userId = member.slice(separator + 1);
      // Saqlangan foydalanuvchi rekordini HASH'dan olamiz.
      const stored = await redis.hGet(USER_RECORDS_KEY, userId);
      // Ma'lumot bo'lmasa ham reytingni buzmaslik uchun minimal fallback ishlatamiz.
      const user = stored ? JSON.parse(stored) : { nickname: 'unknown' };
      // Public API'ga faqat kerakli va xavfsiz maydonlarni chiqaramiz.
      return { rank: index + 1, nickname: user.nickname, ...formatUnits(elapsedNs) };
    }));
    // Global top-100 ro'yxatni mijozga qaytaramiz.
    return response.json({ data: rows });
  } catch (error) {
    // Express error middleware'iga o'tamiz.
    return next(error);
  }
});

// Google akkauntiga avval biriktirilgan nikni qaytaruvchi endpoint.
app.get('/api/leaderboard/me', requireGoogleUser, async (request, response, next) => {
  try {
    const nickname = await redis.hGet(USER_NICKNAMES_KEY, request.user.id);
    return response.json({ nickname: nickname || null });
  } catch (error) {
    return next(error);
  }
});

// Faqat Google bilan kirgan foydalanuvchining yangi rekordini saqlovchi endpoint.
app.post('/api/leaderboard/submit', requireGoogleUser, rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.SUBMIT_RATE_LIMIT || 30), standardHeaders: 'draft-8', legacyHeaders: false }), async (request, response, next) => {
  // Validatsiya va Redis amallarini bitta try blokida boshqaramiz.
  try {
    // Body tuzilishini tekshiramiz.
    const parsed = submitSchema.safeParse(request.body);
    // Noto'g'ri body'ni Redis'ga yubormaymiz.
    if (!parsed.success) return response.status(400).json({ error: "nickname va elapsedNs formati noto'g'ri." });
    // Nanosekundni BigInt bilan tekshiramiz.
    const elapsedNs = parseNanoseconds(parsed.data.elapsedNs);
    // Google akkaunti oldin nik tanlagan bo'lsa, uni almashtirishga yo'l qo'ymaymiz.
    const previousNickname = await redis.hGet(USER_NICKNAMES_KEY, request.user.id);
    // Bir akkauntdan bir nechta nik bilan reytingga kirishni rad qilamiz.
    if (previousNickname && previousNickname !== parsed.data.nickname) return response.status(409).json({ error: 'Bu Google akkauntiga boshqa nik allaqachon biriktirilgan.' });
    // Nikni birinchi marta shu Google subject bilan atomik band qilamiz.
    const nicknameKey = `leaderboard:nickname:${parsed.data.nickname.toLowerCase()}`;
    // Nikni Redis SET orqali boshqa akkauntdan atomik himoya qilamiz.
    const nicknameOwner = await redis.set(nicknameKey, request.user.id, { NX: true, EX: 60 * 60 * 24 * 365 * 10 });
    // Nik boshqa Google akkauntiga tegishli bo'lsa, rekordni rad qilamiz.
    if (nicknameOwner === null) {
      const owner = await redis.get(nicknameKey);
      if (owner !== request.user.id) return response.status(409).json({ error: 'Bu nik allaqachon ishlatilgan.' });
    }
    // Nik tanlovini rekord yozilishidan oldin saqlab, akkaunt-nik invariantini mustahkamlaymiz.
    await redis.hSet(USER_NICKNAMES_KEY, request.user.id, parsed.data.nickname);
    // Redis Lua skripti uchun exact fixed-width qiymatni tayyorlaymiz.
    const encodedNs = encodeNanoseconds(elapsedNs);
    // Lua script ZSET va HASH yangilanishini atomik bajaradi.
    const saved = await redis.eval(saveRecordScript, { keys: [LEADERBOARD_KEY, USER_RECORDS_KEY], arguments: [request.user.id, encodedNs] });
    // Public response uchun foydalanuvchi nomini HASH'ga saqlaymiz.
    await redis.hSet(USER_RECORDS_KEY, request.user.id, JSON.stringify({ nickname: parsed.data.nickname, email: request.user.email }));
    // Rekord yaxshilangan yoki oldingi rekord saqlanib qolganini qaytaramiz.
    return response.status(saved === 1 ? 201 : 200).json({ improved: saved === 1, ...formatUnits(elapsedNs) });
  } catch (error) {
    // BigInt parsing xatosini client error sifatida qaytaramiz.
    if (error instanceof SyntaxError || error.message.includes('Nanosekund')) return response.status(400).json({ error: error.message });
    // Qolgan xatolarni umumiy handlerga yuboramiz.
    return next(error);
  }
});

// API health-check endpointini taqdim qilamiz.
app.get('/health', async (request, response) => {
  try {
    // Health check ni haqiqiy Redis ulanishi bilan tekshiramiz.
    await ensureRedisConnected();
    return response.status(redis.isReady ? 200 : 503).json({ status: redis.isReady ? 'up' : 'down' });
  } catch (error) {
    console.error('Health check xatosi:', error);
    return response.status(503).json({ status: 'down' });
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