const testStage = document.querySelector('#testStage');
const stageKicker = document.querySelector('#stageKicker');
const stageValue = document.querySelector('#stageValue');
const stageMessage = document.querySelector('#stageMessage');
const lastResult = document.querySelector('#lastResult');
const bestResult = document.querySelector('#bestResult');
const attemptsLabel = document.querySelector('#attempts');
const resetButton = document.querySelector('#resetButton');
const conversionResult = document.querySelector('#conversionResult');
const leaderboardList = document.querySelector('#leaderboardList');
const currentNickname = document.querySelector('#currentNickname');
const showMoreButton = document.querySelector('#showMoreButton');
const nicknameOverlay = document.querySelector('#nicknameOverlay');
const nicknameForm = document.querySelector('#nicknameForm');
const nicknameInput = document.querySelector('#nicknameInput');
const nicknameError = document.querySelector('#nicknameError');
const googleSignInDiv = document.querySelector('#googleSignInDiv');
const authNote = document.querySelector('#authNote');

// GitHub Pages frontend'i API uchun Vercel deploy'iga, Vercel frontend'i esa same-origin API'ga murojaat qiladi.
const API_BASE = window.location.hostname.endsWith('github.io')
  ? 'https://millisekund.vercel.app'
  : '';
console.info('[Millisekund] Google OAuth origin:', window.location.origin, 'client:', window.GOOGLE_CLIENT_ID || 'not loaded');
// Google ID tokenini shu seans davomida saqlaymiz (sahifa yopilsa yo'qoladi).
let googleIdToken = sessionStorage.getItem('google-id-token') || '';
// Global rejim faol bo'lsa, reyting backend'dan olinadi.
let isGlobalMode = false;
let leaderboardOffset = 0;

const MAX_WAIT = 5000;
let state = 'idle';
let countdownTimer;
let responseTimer;
let greenAt = 0;
let attempts = Number(localStorage.getItem('reaction-attempts') || 0);
let best = Number(localStorage.getItem('reaction-best') || 0);
let nickname = localStorage.getItem('reaction-nickname') || '';
let leaderboard = JSON.parse(localStorage.getItem('reaction-leaderboard') || '[]');
let usedNicknames = JSON.parse(localStorage.getItem('reaction-used-nicknames') || '[]');
// Token mavjud bo'lsa, eski brauzer nickname'iga emas, serverdagi profilga ishonamiz.
if (googleIdToken) nickname = '';

function formatUnits(nanoseconds) {
  const exactNanoseconds = BigInt(nanoseconds);
  const milliseconds = exactNanoseconds / 1_000_000n;
  const microseconds = exactNanoseconds / 1_000n;
  return `<strong>${milliseconds.toLocaleString('uz-UZ')} ms</strong><span>${microseconds.toLocaleString('uz-UZ')} mikrosekund</span><span>${exactNanoseconds.toLocaleString('uz-UZ')} nanosekund</span>`;
}

function getNanoseconds(entry) {
  if (entry.nanoseconds !== undefined) return BigInt(entry.nanoseconds);
  return BigInt(Math.max(1, Math.round(entry.score * 1_000_000)));
}

function formatLeaderboardTime(nanoseconds) {
  const exactNanoseconds = BigInt(nanoseconds);
  const milliseconds = exactNanoseconds / 1_000_000n;
  const microseconds = exactNanoseconds / 1_000n;
  return `<strong>${milliseconds.toLocaleString('uz-UZ')}<small> ms</small></strong><span>${microseconds.toLocaleString('uz-UZ')} µs · ${exactNanoseconds.toLocaleString('uz-UZ')} ns</span>`;
}

function renderLeaderboard(rows, current = null, append = false) {
  const sorted = rows || [...leaderboard].sort((left, right) => Number(getNanoseconds(left) - getNanoseconds(right))).slice(0, 10);
  if (append) leaderboardList.querySelector('.personal-rank')?.remove();
  const html = sorted.length ? sorted.map((entry, index) => `
    <li class="leaderboard-row ${entry.nickname === nickname ? 'is-current' : ''}">
      <span class="rank">${String(entry.rank || index + 1).padStart(2, '0')}</span>
      <span class="leader-name">@${entry.nickname}</span>
      <span class="leader-time">${formatLeaderboardTime(getNanoseconds(entry))}</span>
    </li>`).join('') : '<li class="empty-row">Hali natija yo\'q. Birinchi bo\'lib o\'zingizni sinang.</li>';
  if (append) leaderboardList.insertAdjacentHTML('beforeend', html);
  else leaderboardList.innerHTML = html;
  if (current && current.rank > 10 && !sorted.some((entry) => entry.nickname === current.nickname)) {
    leaderboardList.insertAdjacentHTML('beforeend', `<li class="leaderboard-row is-current personal-rank"><span class="rank">${current.rank}</span><span class="leader-name">@${current.nickname}</span><span class="leader-time">${formatLeaderboardTime(getNanoseconds(current))}</span></li>`);
  }
  currentNickname.textContent = nickname ? `@${nickname}` : '@nik';
}

// Global reytingni backend'dan olib, mavjud formatga moslab chizamiz.
async function fetchLeaderboard() {
  try {
    leaderboardOffset = 0;
    const response = await fetch(`${API_BASE}/api/leaderboard?limit=10&offset=0`, { headers: googleIdToken ? { Authorization: `Bearer ${googleIdToken}` } : {} });
    if (!response.ok) throw new Error('leaderboard fetch failed');
    const { data, current, hasMore } = await response.json();
    isGlobalMode = true;
    renderLeaderboard(data, current);
    showMoreButton.hidden = !hasMore;
  } catch (error) {
    // Backend mavjud bo'lmasa (masalan lokal statik rejim), lokal reytingga qaytamiz.
    isGlobalMode = false;
    showMoreButton.hidden = true;
    renderLeaderboard();
  }
}

async function loadMoreLeaderboard() {
  showMoreButton.disabled = true;
  try {
    leaderboardOffset += 10;
    const response = await fetch(`${API_BASE}/api/leaderboard?limit=10&offset=${leaderboardOffset}`, { headers: googleIdToken ? { Authorization: `Bearer ${googleIdToken}` } : {} });
    if (!response.ok) throw new Error('leaderboard pagination failed');
    const { data, current, hasMore } = await response.json();
    renderLeaderboard(data, current, true);
    showMoreButton.hidden = !hasMore;
  } catch (error) {
    leaderboardOffset -= 10;
    console.error('Reytingni ko\'proq yuklashda xato:', error);
  } finally {
    showMoreButton.disabled = false;
  }
}

// Reaksiya natijasini Google akkaunt bilan bog'langan global reytingga yuboramiz.
async function submitToGlobalLeaderboard(elapsedNs) {
  if (!googleIdToken || !nickname) return;
  try {
    const response = await fetch(`${API_BASE}/api/leaderboard/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${googleIdToken}` },
      body: JSON.stringify({ nickname, elapsedNs: elapsedNs.toString() }),
    });
    const payload = await response.json();
    if (!response.ok) {
      nicknameError.textContent = payload.error || 'Natijani yuborishda xatolik.';
      return;
    }
    await fetchLeaderboard();
  } catch (error) {
    console.error('Global reytingga yuborishda xato:', error);
  }
}

// Base64url JWT payload'ini xavfsiz tarzda (faqat ko'rsatish uchun) dekodlaymiz.
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(base64))));
  } catch (error) {
    return {};
  }
}

// Google Identity Services muvaffaqiyatli login qaytargan callback.
async function restoreGoogleNickname() {
  if (!googleIdToken) return;
  try {
    const response = await fetch(`${API_BASE}/api/leaderboard/me`, {
      headers: { Authorization: `Bearer ${googleIdToken}` },
    });
    if (!response.ok) return;
    const { nickname: savedNickname } = await response.json();
    if (!savedNickname) return;
    nickname = savedNickname;
    localStorage.setItem('reaction-nickname', nickname);
    if (!usedNicknames.some((usedNickname) => usedNickname.toLowerCase() === nickname.toLowerCase())) {
      usedNicknames.push(nickname);
      localStorage.setItem('reaction-used-nicknames', JSON.stringify(usedNicknames));
    }
    showNicknameGate();
  } catch (error) {
    console.error('Google nikini tiklashda xato:', error);
  }
}

async function handleCredentialResponse(response) {
  googleIdToken = response.credential;
  sessionStorage.setItem('google-id-token', googleIdToken);
  const payload = decodeJwtPayload(googleIdToken);
  googleSignInDiv.style.display = 'none';
  authNote.textContent = `Google: ${payload.name || payload.email || 'akkaunt'} ulandi. Natijalar global reytingga yuboriladi.`;
  await restoreGoogleNickname();
  fetchLeaderboard();
}

// Google Identity Services skripti yuklanishini kutib, tugmani chizamiz.
function initGoogleSignIn() {
  if (!window.google || !window.GOOGLE_CLIENT_ID) {
    setTimeout(initGoogleSignIn, 300);
    return;
  }
  google.accounts.id.initialize({ client_id: window.GOOGLE_CLIENT_ID, callback: handleCredentialResponse, auto_select: false });
  google.accounts.id.renderButton(googleSignInDiv, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 320 });
  // Sahifa qayta ochilganda avvalgi tokenni ko'rsatish uchun.
  if (googleIdToken) {
    const payload = decodeJwtPayload(googleIdToken);
    googleSignInDiv.style.display = 'none';
    authNote.textContent = `Google: ${payload.name || payload.email || 'akkaunt'} ulandi. Natijalar global reytingga yuboriladi.`;
    restoreGoogleNickname();
  }
}

function showNicknameGate() {
  if (nickname && googleIdToken) {
    nicknameOverlay.hidden = true;
    renderLeaderboard();
    return;
  }
  nicknameOverlay.hidden = false;
  nicknameInput.focus();
}

function updateStats() {
  attemptsLabel.textContent = attempts;
  bestResult.innerHTML = best ? `${best}<small> ms</small>` : '--<small> ms</small>';
  if (!isGlobalMode) renderLeaderboard();
}

function setStage({ mode = '', kicker, value, message }) {
  testStage.className = `test-stage ${mode}`;
  stageKicker.textContent = kicker;
  stageValue.textContent = value;
  stageMessage.textContent = message;
}

function showIdle() {
  state = 'idle';
  clearTimeout(countdownTimer);
  clearTimeout(responseTimer);
  setStage({ kicker: 'TAYYORMISIZ?', value: 'SPACE', message: 'Boshlash uchun bosing' });
}

function startCountdown() {
  state = 'countdown';
  let number = 3;
  setStage({ mode: 'counting', kicker: 'TAYYORLANING', value: number, message: 'Hozir boshlanadi...' });

  countdownTimer = setInterval(() => {
    number -= 1;
    if (number > 0) {
      setStage({ mode: 'counting', kicker: 'TAYYORLANING', value: number, message: 'Hozir boshlanadi...' });
      return;
    }

    clearInterval(countdownTimer);
    state = 'ready';
    greenAt = performance.now();
    setStage({ mode: 'ready', kicker: 'HOZIR!', value: 'SPACE', message: 'Darhol bosing!' });
    responseTimer = setTimeout(handleTimeout, MAX_WAIT);
  }, 1000);
}

function handleResponse() {
  const rawMs = performance.now() - greenAt;
  const result = Math.round(rawMs);
  // Aniq breakdown va backend'ga yuborish uchun bitta haqiqiy nanosekund qiymatini hisoblaymiz (yaxlitlangan ms'dan emas).
  const preciseNs = Math.max(1, Math.round(rawMs * 1_000_000));
  state = 'result';
  clearTimeout(responseTimer);
  attempts += 1;
  best = best === 0 ? result : Math.min(best, result);
  localStorage.setItem('reaction-attempts', attempts);
  localStorage.setItem('reaction-best', best);
  // Lokal (bu qurilmadagi) reytingni har doim yangilab boramiz, global rejim mavjud bo'lmasa ham ishlashi uchun.
  const existingEntry = leaderboard.find((entry) => entry.nickname === nickname);
  if (existingEntry) {
    existingEntry.nanoseconds = getNanoseconds(existingEntry) > preciseNs ? preciseNs.toString() : getNanoseconds(existingEntry).toString();
  } else leaderboard.push({ nickname, nanoseconds: preciseNs.toString() });
  localStorage.setItem('reaction-leaderboard', JSON.stringify(leaderboard));
  lastResult.innerHTML = `${result}<small> ms</small>`;
  conversionResult.innerHTML = formatUnits(preciseNs);
  setStage({ mode: 'result', kicker: 'NATIJA', value: `${result} ms`, message: 'Qayta sinash uchun Space bosing' });
  updateStats();
  // Google bilan ulangan bo'lsa, xuddi shu aniq nanosekund qiymatini global reytingga yuboramiz.
  if (googleIdToken) {
    submitToGlobalLeaderboard(BigInt(preciseNs));
  } else if (isGlobalMode) {
    fetchLeaderboard();
  }
}

function handleTimeout() {
  state = 'timeout';
  setStage({ mode: 'timeout', kicker: 'VAQT TUGADI', value: 'JUDA SEKIN', message: 'Qaytadan boshlash uchun Space bosing' });
  responseTimer = setTimeout(showIdle, 2200);
}

function handleSpace() {
  if (state === 'idle' || state === 'result' || state === 'timeout') {
    startCountdown();
  } else if (state === 'ready') {
    handleResponse();
  }
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  handleSpace();
});

testStage.addEventListener('click', () => {
  testStage.focus();
  handleSpace();
});

resetButton.addEventListener('click', () => {
  attempts = 0;
  best = 0;
  lastResult.innerHTML = '--<small> ms</small>';
  conversionResult.textContent = "Natija chiqqach, birliklar shu yerda ko'rinadi.";
  localStorage.removeItem('reaction-attempts');
  localStorage.removeItem('reaction-best');
  updateStats();
  showIdle();
});

nicknameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  nicknameError.textContent = 'Google akkaunt orqali kiring.';
});

showMoreButton.addEventListener('click', loadMoreLeaderboard);

updateStats();
showNicknameGate();
fetchLeaderboard();
initGoogleSignIn();