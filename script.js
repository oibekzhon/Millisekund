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
const logoutButton = document.querySelector('#logoutButton');
const nicknameOverlay = document.querySelector('#nicknameOverlay');
const nicknameForm = document.querySelector('#nicknameForm');
const nicknameInput = document.querySelector('#nicknameInput');
const passwordInput = document.querySelector('#passwordInput');
const nicknameError = document.querySelector('#nicknameError');

const API_BASE = window.location.hostname.endsWith('github.io')
  ? 'https://millisekund.vercel.app'
  : '';

function readStorageNumber(key, fallback = 0) {
  const rawValue = localStorage.getItem(key);
  const value = Number(rawValue || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function readStorageJson(key, fallback = []) {
  const rawValue = localStorage.getItem(key);
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    console.warn(`Kutilmagan JSON ${key} ma'lumotlari:`, error);
    return fallback;
  }
}

function toBigIntSafe(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.round(value)));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return fallback;
}

let sessionToken = localStorage.getItem('millisekund-session') || '';
let isGlobalMode = false;
let leaderboardOffset = 0;

const MAX_WAIT = 5000;
let state = 'idle';
let countdownTimer;
let responseTimer;
let greenAt = 0;
let attempts = readStorageNumber('reaction-attempts', 0);
let best = readStorageNumber('reaction-best', 0);
let nickname = localStorage.getItem('reaction-nickname') || '';
let leaderboard = readStorageJson('reaction-leaderboard', []);
let usedNicknames = readStorageJson('reaction-used-nicknames', []);
if (sessionToken) nickname = localStorage.getItem('reaction-nickname') || '';

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
  const raw = BigInt(value);
  return formatWithGrouping(raw.toString());
}

function formatUnits(nanoseconds) {
  const exactNanoseconds = toBigIntSafe(nanoseconds, 0n);
  const millisecondsText = formatWithGrouping((exactNanoseconds / 1_000_000n).toString());
  const microsecondsText = formatWithGrouping((exactNanoseconds / 1_000n).toString());
  const nanosecondsText = formatNanoseconds(exactNanoseconds);

  return `<strong>${millisecondsText} ms</strong><span>${microsecondsText} mikrosekund</span><span>${nanosecondsText} nanosekund</span>`;
}

function measureNanoseconds(startTime, eventTimeStamp) {
  const endTime = Number.isFinite(eventTimeStamp) && eventTimeStamp > startTime ? eventTimeStamp : performance.now();
  return BigInt(Math.max(1, Math.round((endTime - startTime) * 1_000_000)));
}

function getNanoseconds(entry) {
  if (!entry || typeof entry !== 'object') return 1n;
  if (entry.nanoseconds !== undefined) return toBigIntSafe(entry.nanoseconds, 1n);
  if (entry.score !== undefined) return toBigIntSafe(entry.score, 1n) * 1_000_000n;
  return 1n;
}

function formatLeaderboardTime(nanoseconds) {
  const exactNanoseconds = toBigIntSafe(nanoseconds, 0n);
  const millisecondsValue = Number(exactNanoseconds) / 1_000_000;
  const microsecondsValue = Number(exactNanoseconds) / 1_000;
  const millisecondsText = formatFixedDecimal(millisecondsValue, 3);
  const microsecondsText = formatFixedDecimal(microsecondsValue, 6);
  const nanosecondsText = formatNanoseconds(exactNanoseconds);

  return `<strong>${millisecondsText}<small> ms</small></strong><span>${microsecondsText} µs · ${nanosecondsText} ns</span>`;
}

function renderLeaderboard(rows, current = null, append = false) {
  const safeRows = Array.isArray(rows) ? rows : [...leaderboard].filter((entry) => entry && entry.nickname).sort((left, right) => Number(getNanoseconds(left) - getNanoseconds(right))).slice(0, 10);
  if (append) leaderboardList.querySelector('.personal-rank')?.remove();
  const html = safeRows.length ? safeRows.map((entry, index) => `
    <li class="leaderboard-row ${entry.nickname === nickname ? 'is-current' : ''}">
      <span class="rank">${String(entry.rank || index + 1).padStart(2, '0')}</span>
      <span class="leader-name">@${entry.nickname}</span>
      <span class="leader-time">${formatLeaderboardTime(getNanoseconds(entry))}</span>
    </li>`).join('') : '<li class="empty-row">Hali natija yo\'q. Birinchi bo\'lib o\'zingizni sinang.</li>';
  if (append) leaderboardList.insertAdjacentHTML('beforeend', html);
  else leaderboardList.innerHTML = html;
  if (current && Number(current.rank) > 10 && !safeRows.some((entry) => entry.nickname === current.nickname)) {
    leaderboardList.insertAdjacentHTML('beforeend', `<li class="leaderboard-row is-current personal-rank"><span class="rank">${Number(current.rank)}</span><span class="leader-name">@${current.nickname}</span><span class="leader-time">${formatLeaderboardTime(getNanoseconds(current))}</span></li>`);
  }
  currentNickname.textContent = nickname ? `@${nickname}` : '@nik';
}

async function fetchLeaderboard() {
  try {
    leaderboardOffset = 0;
    const response = await fetch(`${API_BASE}/api/leaderboard?limit=10&offset=0`, { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {} });
    if (!response.ok) throw new Error('leaderboard fetch failed');
    const { data, current, hasMore } = await response.json();
    isGlobalMode = true;
    renderLeaderboard(data, current);
    showMoreButton.hidden = !hasMore;
  } catch (error) {
    isGlobalMode = false;
    showMoreButton.hidden = true;
    renderLeaderboard();
  }
}

async function loadMoreLeaderboard() {
  showMoreButton.disabled = true;
  try {
    leaderboardOffset += 10;
    const response = await fetch(`${API_BASE}/api/leaderboard?limit=10&offset=${leaderboardOffset}`, { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {} });
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

async function submitToGlobalLeaderboard(elapsedNs) {
  if (!sessionToken || !nickname) return;
  try {
    const response = await fetch(`${API_BASE}/api/leaderboard/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ nickname, elapsedNs: elapsedNs.toString() }),
    });
    const payload = await response.json();
    if (response.status === 401) return logout();
    if (!response.ok) {
      nicknameError.textContent = payload.error || 'Natijani yuborishda xatolik.';
      return;
    }
    if (payload.elapsedNs) conversionResult.innerHTML = formatUnits(payload.elapsedNs);
    await fetchLeaderboard();
  } catch (error) {
    console.error('Global reytingga yuborishda xato:', error);
  }
}

function showNicknameGate() {
  logoutButton.hidden = !(nickname && sessionToken);
  if (nickname && sessionToken) {
    nicknameOverlay.hidden = true;
    renderLeaderboard();
    return;
  }
  nicknameOverlay.hidden = false;
  nicknameInput.focus();
}

async function logout() {
  if (sessionToken) {
    try {
      await fetch(`${API_BASE}/api/auth/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
    } catch (error) {
      console.error('Sessiyani yopishda xato:', error);
    }
  }
  sessionToken = '';
  nickname = '';
  localStorage.removeItem('millisekund-session');
  localStorage.removeItem('reaction-nickname');
  nicknameForm.reset();
  nicknameError.textContent = '';
  showIdle();
  showNicknameGate();
  await fetchLeaderboard();
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
    setStage({ mode: 'counting', kicker: 'HOZIR!', value: 'SPACE', message: 'Darhol bosing!' });
    responseTimer = setTimeout(handleTimeout, MAX_WAIT);
  }, 1000);
}

function handleResponse(eventTimeStamp) {
  const preciseNs = measureNanoseconds(greenAt, eventTimeStamp);
  const result = Number(preciseNs / 1_000_000n);
  state = 'result';
  clearTimeout(responseTimer);
  attempts += 1;
  best = best === 0 ? result : Math.min(best, result);
  localStorage.setItem('reaction-attempts', attempts);
  localStorage.setItem('reaction-best', best);

  if (nickname) {
    const existingEntry = leaderboard.find((entry) => entry && entry.nickname === nickname);
    if (existingEntry) {
      const currentBestNs = getNanoseconds(existingEntry);
      existingEntry.nanoseconds = currentBestNs > preciseNs ? preciseNs.toString() : currentBestNs.toString();
    } else {
      leaderboard.push({ nickname, nanoseconds: preciseNs.toString() });
    }
    localStorage.setItem('reaction-leaderboard', JSON.stringify(leaderboard));
  }

  lastResult.innerHTML = `${result}<small> ms</small>`;
  conversionResult.innerHTML = formatUnits(preciseNs);
  setStage({ mode: 'result', kicker: 'NATIJA', value: `${result} ms`, message: 'Qayta sinash uchun Space bosing' });
  updateStats();
  if (sessionToken) {
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

function handleSpace(eventTimeStamp) {
  if (state === 'idle' || state === 'result' || state === 'timeout') {
    startCountdown();
  } else if (state === 'ready') {
    handleResponse(eventTimeStamp);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || !nicknameOverlay.hidden) return;
  event.preventDefault();
  handleSpace(event.timeStamp);
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
  authenticate();
});

showMoreButton.addEventListener('click', loadMoreLeaderboard);
logoutButton.addEventListener('click', logout);

updateStats();
showNicknameGate();
async function authenticate() {
  nicknameError.textContent = '';
  try {
    const response = await fetch(`${API_BASE}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nicknameInput.value.trim(), password: passwordInput.value }),
    });
    const payload = await response.json();
    if (!response.ok) {
      nicknameError.textContent = payload.error || 'Kirish amalga oshmadi.';
      return;
    }
    sessionToken = payload.token;
    nickname = payload.nickname;
    localStorage.setItem('millisekund-session', sessionToken);
    localStorage.setItem('reaction-nickname', nickname);
    nicknameError.textContent = '';
    showNicknameGate();
    await fetchLeaderboard();
  } catch (error) {
    nicknameError.textContent = 'Server bilan bog\'lanib bo\'lmadi.';
  }
}

fetchLeaderboard();