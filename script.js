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
const nicknameOverlay = document.querySelector('#nicknameOverlay');
const nicknameForm = document.querySelector('#nicknameForm');
const nicknameInput = document.querySelector('#nicknameInput');
const nicknameError = document.querySelector('#nicknameError');
const googleButton = document.querySelector('#googleButton');

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

function formatUnits(result) {
  return `<strong>${result.toLocaleString('uz-UZ')} ms</strong><span>${(result * 1000).toLocaleString('uz-UZ')} mikrosekund</span><span>${(result * 1000000).toLocaleString('uz-UZ')} nanosekund</span>`;
}

function renderLeaderboard() {
  const sorted = [...leaderboard].sort((left, right) => left.score - right.score).slice(0, 10);
  leaderboardList.innerHTML = sorted.length ? sorted.map((entry, index) => `
    <li class="leaderboard-row ${entry.nickname === nickname ? 'is-current' : ''}">
      <span class="rank">${String(index + 1).padStart(2, '0')}</span>
      <span class="leader-name">@${entry.nickname}</span>
      <strong>${entry.score}<small> ms</small></strong>
    </li>`).join('') : '<li class="empty-row">Hali natija yo\'q. Birinchi bo\'lib o\'zingizni sinang.</li>';
  currentNickname.textContent = nickname ? `@${nickname}` : '@nik';
}

function showNicknameGate() {
  if (nickname) {
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
  renderLeaderboard();
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
  const result = Math.round(performance.now() - greenAt);
  state = 'result';
  clearTimeout(responseTimer);
  attempts += 1;
  best = best === 0 ? result : Math.min(best, result);
  localStorage.setItem('reaction-attempts', attempts);
  localStorage.setItem('reaction-best', best);
  const existingEntry = leaderboard.find((entry) => entry.nickname === nickname);
  if (existingEntry) existingEntry.score = Math.min(existingEntry.score, result);
  else leaderboard.push({ nickname, score: result });
  localStorage.setItem('reaction-leaderboard', JSON.stringify(leaderboard));
  lastResult.innerHTML = `${result}<small> ms</small>`;
  conversionResult.innerHTML = formatUnits(result);
  updateStats();
  setStage({ mode: 'result', kicker: 'NATIJA', value: `${result} ms`, message: 'Qayta sinash uchun Space bosing' });
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
  const nextNickname = nicknameInput.value.trim();
  const nicknameTaken = usedNicknames.some((usedNickname) => usedNickname.toLowerCase() === nextNickname.toLowerCase());
  if (nicknameTaken) {
    nicknameError.textContent = 'Bu nik allaqachon ishlatilgan. Boshqa nik tanlang.';
    return;
  }
  nickname = nextNickname;
  localStorage.setItem('reaction-nickname', nickname);
  usedNicknames.push(nickname);
  localStorage.setItem('reaction-used-nicknames', JSON.stringify(usedNicknames));
  nicknameError.textContent = '';
  showNicknameGate();
});

googleButton.addEventListener('click', () => {
  nicknameError.textContent = 'Google bog\'lash uchun serverdagi OAuth Client ID kerak.';
});

updateStats();
showNicknameGate();
