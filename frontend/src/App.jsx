import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const MAX_WAIT = 5000;
const initialStage = { mode: '', kicker: 'TAYYORMISIZ?', value: 'SPACE', message: 'Boshlash uchun bosing' };

function readNumber(key, fallback = 0) {
  const value = Number(localStorage.getItem(key) || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function readJson(key, fallback = []) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.round(value)));
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '');
    if (/^\d+$/.test(normalized)) return BigInt(normalized);
  }
  return fallback;
}

function grouped(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatUnits(value) {
  const nanoseconds = toBigInt(value);
  return {
    milliseconds: grouped(nanoseconds / 1_000_000n),
    microseconds: grouped(nanoseconds / 1_000n),
    nanoseconds: grouped(nanoseconds),
  };
}

function entryNanoseconds(entry) {
  if (entry?.nanoseconds !== undefined) return toBigInt(entry.nanoseconds, 1n);
  if (entry?.score !== undefined) return toBigInt(entry.score, 1n) * 1_000_000n;
  return 1n;
}

function endpoint(path) {
  return `${API_BASE}${path}`;
}

function Conversion({ value }) {
  if (!value) return <>Natija chiqqach, birliklar shu yerda ko'rinadi.</>;
  const units = formatUnits(value);
  return <><strong>{units.milliseconds} ms</strong><span>{units.microseconds} mikrosekund</span><span>{units.nanoseconds} nanosekund</span></>;
}

function LeaderboardRow({ entry, index, nickname }) {
  const units = formatUnits(entryNanoseconds(entry));
  return <li className={`leaderboard-row ${entry.nickname === nickname ? 'is-current' : ''}`}>
    <span className="rank">{String(entry.rank || index + 1).padStart(2, '0')}</span>
    <span className="leader-name">@{entry.nickname}</span>
    <span className="leader-time"><strong>{units.milliseconds}<small> ms</small></strong><span>{units.microseconds} µs · {units.nanoseconds} ns</span></span>
  </li>;
}

export default function App() {
  const [stage, setStage] = useState(initialStage);
  const [state, setState] = useState('idle');
  const [attempts, setAttempts] = useState(() => readNumber('reaction-attempts'));
  const [best, setBest] = useState(() => readNumber('reaction-best'));
  const [lastNanoseconds, setLastNanoseconds] = useState(null);
  const [leaderboard, setLeaderboard] = useState(() => readJson('reaction-leaderboard'));
  const [globalMode, setGlobalMode] = useState(false);
  const [nickname, setNickname] = useState(() => localStorage.getItem('reaction-nickname') || '');
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('millisekund-session') || '');
  const [showLogin, setShowLogin] = useState(() => !localStorage.getItem('millisekund-session') || !localStorage.getItem('reaction-nickname'));
  const [currentRank, setCurrentRank] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const greenAt = useRef(0);
  const countdownTimer = useRef(null);
  const responseTimer = useRef(null);
  const stateRef = useRef(state);
  const sessionRef = useRef(sessionToken);
  const nicknameRef = useRef(nickname);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { sessionRef.current = sessionToken; }, [sessionToken]);
  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);

  const authHeaders = useCallback(() => sessionRef.current ? { Authorization: `Bearer ${sessionRef.current}` } : {}, []);

  const renderLocal = useCallback(() => {
    setLeaderboard([...readJson('reaction-leaderboard')].filter((entry) => entry?.nickname).sort((a, b) => Number(entryNanoseconds(a) - entryNanoseconds(b))).slice(0, 10));
  }, []);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const response = await fetch(endpoint('/api/leaderboard?limit=10&offset=0'), { headers: authHeaders() });
      if (!response.ok) throw new Error('leaderboard fetch failed');
      const payload = await response.json();
      setLeaderboard(Array.isArray(payload.data) ? payload.data : []);
      setCurrentRank(payload.current || null);
      setHasMore(Boolean(payload.hasMore));
      setOffset(0);
      setGlobalMode(true);
    } catch {
      setGlobalMode(false);
      setHasMore(false);
      renderLocal();
    }
  }, [authHeaders, renderLocal]);

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

  useEffect(() => () => {
    clearInterval(countdownTimer.current);
    clearTimeout(responseTimer.current);
  }, []);

  const showIdle = useCallback(() => {
    clearInterval(countdownTimer.current);
    clearTimeout(responseTimer.current);
    setState('idle');
    setStage(initialStage);
  }, []);

  const submitScore = useCallback(async (elapsedNs) => {
    if (!sessionRef.current || !nicknameRef.current) return;
    try {
      const response = await fetch(endpoint('/api/leaderboard/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ nickname: nicknameRef.current, elapsedNs: elapsedNs.toString() }),
      });
      const payload = await response.json();
      if (response.status === 401) {
        setSessionToken('');
        setNickname('');
        localStorage.removeItem('millisekund-session');
        localStorage.removeItem('reaction-nickname');
        setShowLogin(true);
        return;
      }
      if (!response.ok) { setError(payload.error || 'Natijani yuborishda xatolik.'); return; }
      setLastNanoseconds(toBigInt(payload.elapsedNs || elapsedNs));
      await fetchLeaderboard();
    } catch (requestError) {
      console.error('Global reytingga yuborishda xato:', requestError);
    }
  }, [authHeaders, fetchLeaderboard]);

  const finishResponse = useCallback((eventTimeStamp) => {
    const end = Number.isFinite(eventTimeStamp) && eventTimeStamp > greenAt.current ? eventTimeStamp : performance.now();
    const preciseNs = BigInt(Math.max(1, Math.round((end - greenAt.current) * 1_000_000)));
    const result = Number(preciseNs / 1_000_000n);
    clearTimeout(responseTimer.current);
    setState('result');
    setAttempts((value) => {
      const next = value + 1;
      localStorage.setItem('reaction-attempts', next);
      return next;
    });
    setBest((value) => {
      const next = value === 0 ? result : Math.min(value, result);
      localStorage.setItem('reaction-best', next);
      return next;
    });
    setLastNanoseconds(preciseNs);
    setStage({ mode: 'result', kicker: 'NATIJA', value: `${result} ms`, message: 'Qayta sinash uchun Space bosing' });
    if (nicknameRef.current) {
      const local = readJson('reaction-leaderboard');
      const existing = local.find((entry) => entry?.nickname === nicknameRef.current);
      if (existing) existing.nanoseconds = entryNanoseconds(existing) > preciseNs ? preciseNs.toString() : entryNanoseconds(existing).toString();
      else local.push({ nickname: nicknameRef.current, nanoseconds: preciseNs.toString() });
      localStorage.setItem('reaction-leaderboard', JSON.stringify(local));
    }
    if (sessionRef.current) submitScore(preciseNs);
    else if (globalMode) fetchLeaderboard();
  }, [fetchLeaderboard, globalMode, submitScore]);

  const startCountdown = useCallback(() => {
    setState('countdown');
    let number = 3;
    setStage({ mode: 'counting', kicker: 'TAYYORLANING', value: number, message: 'Hozir boshlanadi...' });
    countdownTimer.current = setInterval(() => {
      number -= 1;
      if (number > 0) setStage({ mode: 'counting', kicker: 'TAYYORLANING', value: number, message: 'Hozir boshlanadi...' });
      else {
        clearInterval(countdownTimer.current);
        greenAt.current = performance.now();
        setState('ready');
        setStage({ mode: 'counting', kicker: 'HOZIR!', value: 'SPACE', message: 'Darhol bosing!' });
        responseTimer.current = setTimeout(() => {
          setState('timeout');
          setStage({ mode: 'timeout', kicker: 'VAQT TUGADI', value: 'JUDA SEKIN', message: 'Qaytadan boshlash uchun Space bosing' });
          responseTimer.current = setTimeout(showIdle, 2200);
        }, MAX_WAIT);
      }
    }, 1000);
  }, [showIdle]);

  const handleSpace = useCallback((timeStamp) => {
    if (stateRef.current === 'idle' || stateRef.current === 'result' || stateRef.current === 'timeout') startCountdown();
    else if (stateRef.current === 'ready') finishResponse(timeStamp);
  }, [finishResponse, startCountdown]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code !== 'Space' || showLogin) return;
      event.preventDefault();
      handleSpace(event.timeStamp);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleSpace, showLogin]);

  async function handleLogin(event) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(endpoint('/api/auth/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: form.get('nickname').trim(), password: form.get('password') }) });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error || 'Kirishda xatolik.'); return; }
      localStorage.setItem('millisekund-session', payload.token);
      localStorage.setItem('reaction-nickname', payload.nickname);
      setSessionToken(payload.token);
      setNickname(payload.nickname);
      setShowLogin(false);
      await fetchLeaderboard();
    } catch { setError('Server bilan bog\'lanib bo\'lmadi.'); }
  }

  async function logout() {
    if (sessionRef.current) await fetch(endpoint('/api/auth/session'), { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    localStorage.removeItem('millisekund-session');
    localStorage.removeItem('reaction-nickname');
    setSessionToken('');
    setNickname('');
    setShowLogin(true);
    showIdle();
    renderLocal();
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const nextOffset = offset + 10;
      const response = await fetch(endpoint(`/api/leaderboard?limit=10&offset=${nextOffset}`), { headers: authHeaders() });
      if (!response.ok) throw new Error('pagination failed');
      const payload = await response.json();
      setLeaderboard((rows) => [...rows, ...(payload.data || [])]);
      setOffset(nextOffset);
      setHasMore(Boolean(payload.hasMore));
    } finally { setLoadingMore(false); }
  }

  const units = lastNanoseconds ? formatUnits(lastNanoseconds) : null;
  const visibleRows = globalMode ? leaderboard : leaderboard;

  return <>
    <main className="app-shell">
      <header className="topbar"><a className="brand" href="/" aria-label="Millisekund bosh sahifa"><span className="brand-mark" aria-hidden="true">+</span><span>Millisekund</span></a><div className="live-indicator"><span /> jonli test</div></header>
      <section className="intro" aria-labelledby="page-title"><p className="eyebrow">Reaksiya laboratoriyasi / 001</p><h1 id="page-title">Qanchalik tez<br /><em>javob berasiz?</em></h1><p className="intro-copy">3, 2, 1 sanog'i tugashi bilan darhol Space tugmasini bosing. Natijangiz millisekund, mikrosekund va nanosekundda ko'rsatiladi.</p></section>
      <section className="test-layout" aria-label="Reaksiya testi">
        <div className={`test-stage ${stage.mode}`} tabIndex="0" role="button" aria-label="Reaksiya testini boshlash uchun Space tugmasini bosing" onClick={(event) => { event.currentTarget.focus(); handleSpace(event.timeStamp); }}><div className="stage-noise" aria-hidden="true" /><div className="stage-content"><p className="stage-kicker">{stage.kicker}</p><div className="stage-value">{stage.value}</div><p className="stage-message">{stage.message}</p></div><div className="stage-corner stage-corner-top">01 / 05</div><div className="stage-corner stage-corner-bottom">SPACE = START</div></div>
        <aside className="stats-panel" aria-label="Natijalar"><div className="stats-heading"><span>Natijalar</span><span className="stats-rule" /></div><div className="stat-block"><span className="stat-label">Oxirgi natija</span><strong>{units?.milliseconds || '--'}<small> ms</small></strong></div><div className="stat-block"><span className="stat-label">Eng yaxshi</span><strong>{best || '--'}<small> ms</small></strong></div><div className="stat-block"><span className="stat-label">Testlar soni</span><strong>{attempts}</strong></div><div className="conversion-block" aria-live="polite"><span className="stat-label">Aniq o'lchov</span><p><Conversion value={lastNanoseconds} /></p></div><button className="reset-button" type="button" onClick={() => { setAttempts(0); setBest(0); setLastNanoseconds(null); localStorage.removeItem('reaction-attempts'); localStorage.removeItem('reaction-best'); showIdle(); }}><span aria-hidden="true">↺</span> Natijalarni tozalash</button></aside>
      </section>
      <section className="leaderboard" aria-labelledby="leaderboard-title"><div className="section-heading"><div><p className="eyebrow">Tezlik arxivi</p><h2 id="leaderboard-title">Reyting doskasi</h2></div><div className="session-actions"><span className="nickname-badge">{nickname ? `@${nickname}` : '@nik'}</span><button className="logout-button" type="button" hidden={!sessionToken} onClick={logout}>Chiqish</button></div></div><ol className="leaderboard-list">{visibleRows.length ? visibleRows.map((entry, index) => <LeaderboardRow key={`${entry.nickname}-${entry.rank || index}`} entry={entry} index={index} nickname={nickname} />) : <li className="empty-row">Hali natija yo'q. Birinchi bo'lib o'zingizni sinang.</li>}{currentRank && Number(currentRank.rank) > 10 && !visibleRows.some((entry) => entry.nickname === currentRank.nickname) && <LeaderboardRow entry={currentRank} index={Number(currentRank.rank) - 1} nickname={nickname} />}</ol>{hasMore && <button className="show-more-button" type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Yuklanmoqda...' : "Ko'proq"}</button>}</section>
      <footer className="footer-note"><span>Space tugmasi</span><span className="footer-dash" /><span>5 soniya ichida javob bering</span></footer>
    </main>
    {showLogin && <div className="nickname-overlay" role="dialog" aria-modal="true" aria-labelledby="nicknameTitle"><form className="nickname-card" onSubmit={handleLogin}><p className="eyebrow">Millisekund / Kirish</p><h2 id="nicknameTitle">Yaxshi nik bilan kiring</h2><p>Nickname va parol bilan kiring. Yangi nik avtomatik ro'yxatdan o'tkaziladi.</p><label htmlFor="nicknameInput">Nik</label><input id="nicknameInput" name="nickname" type="text" minLength="3" maxLength="18" pattern="[A-Za-z0-9_]+" autoComplete="username" placeholder="masalan, tezkor_01" required /><label htmlFor="passwordInput">Parol</label><input id="passwordInput" name="password" type="password" minLength="6" maxLength="128" autoComplete="current-password" placeholder="kamida 6 belgi" required /><p className="form-error" role="alert">{error}</p><button className="primary-button" type="submit">Kirish / Ro'yxatdan o'tish <span aria-hidden="true">→</span></button><small className="auth-note">Mavjud nik bo'lsa kirasiz, yangi nik bo'lsa akkaunt yaratiladi.</small></form></div>}
  </>;
}
