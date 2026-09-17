// 遊戲路口 (try-our-games.vercel.app) round reporting: the platform's reference
// implementation, copied unchanged. Without ?gp_token in the URL it does nothing.

const PORTAL = 'https://try-our-games.vercel.app';

// token 來自網址；存進 sessionStorage 只是為了讓同一個分頁重新整理後還能繼續記錄
// （關掉分頁就沒了）。不可存 localStorage 或 cookie。讀不到就是訪客模式。
const gpToken = (() => {
  const fromUrl = new URLSearchParams(location.search).get('gp_token');
  try {
    if (fromUrl) sessionStorage.setItem('gp_token', fromUrl);
    return fromUrl ?? sessionStorage.getItem('gp_token');
  } catch {
    return fromUrl; // 瀏覽器不給用 sessionStorage 時照樣能玩
  }
})();

let sessionId = null; // 目前這一局；null＝訪客模式、已回報、或 start 還沒回來
let round = 0;        // 局序號：回應晚到時判斷是否已過時
let startedAt = 0;    // 這一局的開始時間，用來算 duration_ms（遊戲不用自己傳）

// 這一局玩了多久（毫秒）；平台用它算總時長與平均時長
function elapsed() {
  if (!startedAt) return null;
  return Math.min(Math.max(Math.round(Date.now() - startedAt), 0), 2147483647);
}

// 遊戲載入後第一局。不要 await。
export async function portalStart() {
  sessionId = null;
  const myRound = ++round;
  if (!gpToken) return null;
  try {
    const res = await fetch(`${PORTAL}/v1/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gpToken }),
    });
    if (!res.ok) { console.warn('[portal] start rejected', res.status); return null; }
    const data = await res.json();
    if (myRound !== round) return null;
    sessionId = data.session_id;
    startedAt = Date.now();
    return data.player;
  } catch (e) {
    console.warn('[portal] start failed', e);
    return null;
  }
}

// 一局在遊戲內結束（結算畫面）。
export function portalResult(outcome, score) {
  round++;
  if (!sessionId) return;
  const body = { session_id: sessionId, outcome };
  if (Number.isInteger(score)) body.score = score;
  const ms = elapsed();
  if (ms !== null) body.duration_ms = ms;
  sessionId = null;
  startedAt = 0;
  fetch(`${PORTAL}/v1/session/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => console.warn('[portal] result failed', e));
}

// 再來一局／重新開始：上一局結果與開新局用同一個請求送。不要 await。
export async function portalRestart(outcome, score) {
  const prev = sessionId;
  const prevMs = elapsed();
  sessionId = null;
  startedAt = 0;
  const myRound = ++round;
  if (!gpToken) return null;
  const body = { token: gpToken };
  if (prev) {
    body.session_id = prev;
    body.outcome = outcome;
    if (Number.isInteger(score)) body.score = score;
    if (prevMs !== null) body.duration_ms = prevMs;
  }
  try {
    const res = await fetch(`${PORTAL}/v1/session/end_and_restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn('[portal] restart rejected', res.status); return null; }
    const data = await res.json();
    if (data.previous && !data.previous.recorded) console.warn('[portal] previous result rejected', data.previous.code);
    if (myRound !== round) return null;
    sessionId = data.session_id;
    startedAt = Date.now();
    return data.player;
  } catch (e) {
    console.warn('[portal] restart failed', e);
    return null;
  }
}

// 關頁：傳字串（text/plain），不要包成 application/json 的 Blob，否則瀏覽器不送
export function portalBeaconOnLeave(getOutcomeAndScore) {
  window.addEventListener('pagehide', () => {
    if (!sessionId) return;
    const { outcome, score } = getOutcomeAndScore(); // 已勝利 → win，否則 abandon；score 為當下分數
    const body = { session_id: sessionId, outcome };
    if (Number.isInteger(score)) body.score = score;
    const ms = elapsed();
    if (ms !== null) body.duration_ms = ms;
    navigator.sendBeacon(`${PORTAL}/v1/session/result`, JSON.stringify(body));
    sessionId = null;
    startedAt = 0;
  });
}
