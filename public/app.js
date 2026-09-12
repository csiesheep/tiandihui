// The client. Four views on one page — landing, solo setup, room lobby, the
// table — picked by query string so the build works at any prefix.
//
// Two ways to run a game. Solo: the engine and the bots run right here, and
// the bots act on timers so the table reads as people doing things one after
// another. Room: a WebSocket to the room's Durable Object, which holds the
// state and sends this seat only what it may see; the same renderers draw
// that view.
import * as E from "./shared/engine.js";
import * as B from "./shared/bots.js";
import { sayAction, sayResult } from "./shared/talk.js";
import en from "./i18n/en.js";
import zh from "./i18n/zh-Hant.js";

const LANGS = { en, "zh-Hant": zh };
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
// Per-tab: the reconnect token, so two tabs in one browser are two players.
const sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- language ----------
let lang = "en", S = en;
function t(key, p = {}) {
  const v = key.split(".").reduce((o, k) => (o ? o[k] : undefined), S);
  return String(v ?? key).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? `{${k}}`));
}
function setLang(l) {
  lang = LANGS[l] ? l : "en";
  S = LANGS[lang];
  store.set("tr.lang", lang);
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  const [a, b, c] = S.titleParts;
  $("hero").innerHTML = `${esc(a)}<br>${esc(b)}<span class="red">${esc(c)}</span>`;
  $("landName").placeholder = t("setup.defaultName");
  $("lbChat").placeholder = t("table.say"); $("chatIn").placeholder = t("table.say");
  $("tableLeave").textContent = t("lobby.leave");
  renderSetup();
  if (game.lobby) renderLobby();
  if (curView()) render();
}
$("langBtn").addEventListener("click", () => setLang(lang === "en" ? "zh-Hant" : "en"));

// ---------- solo setup ----------
const setup = {
  n: Number(store.get("tr.n", 7)),
  level: store.get("tr.level", "normal"),
  name: store.get("tr.name", ""),
  blind: store.get("tr.blind", "0") === "1",
  hours: store.get("tr.hours", "0") === "1",
};
function renderSetup() {
  const n = setup.n;
  $("pCount").textContent = n;
  $("pMinus").disabled = n <= E.MIN_PLAYERS;
  $("pPlus").disabled = n >= E.MAX_PLAYERS;
  $("setupSub").textContent = t("setup.sub", { bots: n - 1 });
  $("pSummary").textContent = t("setup.summary", { spies: E.SPIES[n], ops: n - E.SPIES[n], twoFail: n >= 7 ? t("setup.twoFail") : "" });
  document.querySelectorAll("#levelSeg button").forEach((b) => b.classList.toggle("on", b.dataset.level === setup.level));
  $("nameInput").value = setup.name; $("landName").value = setup.name;
  $("nameInput").placeholder = t("setup.defaultName");
  $("blindChk").checked = setup.blind;
  $("hoursChk").checked = setup.hours;
}
const setName = (v) => { setup.name = v.trim().slice(0, 16); store.set("tr.name", setup.name); };
$("pMinus").addEventListener("click", () => { setup.n = Math.max(E.MIN_PLAYERS, setup.n - 1); store.set("tr.n", setup.n); renderSetup(); });
$("pPlus").addEventListener("click", () => { setup.n = Math.min(E.MAX_PLAYERS, setup.n + 1); store.set("tr.n", setup.n); renderSetup(); });
document.querySelectorAll("#levelSeg button").forEach((b) => b.addEventListener("click", () => { setup.level = b.dataset.level; store.set("tr.level", setup.level); renderSetup(); }));
$("nameInput").addEventListener("input", (e) => setName(e.target.value));
$("landName").addEventListener("input", (e) => setName(e.target.value));
$("blindChk").addEventListener("change", (e) => { setup.blind = e.target.checked; store.set("tr.blind", setup.blind ? "1" : "0"); });
$("hoursChk").addEventListener("change", (e) => { setup.hours = e.target.checked; store.set("tr.hours", setup.hours ? "1" : "0"); });
$("btnStart").addEventListener("click", () => startGame());
$("btnPlay").addEventListener("click", () => go("?play"));

// ---------- game state shared by both modes ----------
const game = {
  mode: "solo",       // "solo" | "net"
  st: null,           // solo: the full engine state
  view: null,         // net: this seat's view from the room
  me: 0, names: [], level: "normal", rng: null, gen: 0,
  stage: null,        // null | "voteResult" | "missionResult" — the table pauses to show something
  stageTimer: null, botTimer: null, peeked: false, seen: false,
  picks: new Set(), log: [], lastVote: null, lastCards: null, hourSeen: 0,
  deadline: 0, ws: null, code: null, lobby: null, closed: false, clock: null,
};
const DELAY = { reveal: 200, propose: 1500, vote: 650, mission: 800 };
const curView = () => (game.mode === "solo" ? (game.st ? E.view(game.st, game.me) : null) : game.view);
const nameOf = (seat) => game.names[seat] ?? game.lobby?.seats?.[seat]?.name ?? "?";
const talkCtx = () => ({ rng: game.rng, names: game.names, T: S.talk, sep: lang === "en" ? ", " : "、", and: lang === "en" ? " and " : "和" });
const nameList = (seats) => seats.map(nameOf).join(lang === "en" ? ", " : "、");

// The Hour deck.
const hourName = (c) => t("hour.names." + c);
const hourDesc = (c, v) => t("hour.desc." + c, { name: v && v.wounded != null ? nameOf(v.wounded) : "" });
// The Hour that applies to what is on screen. While a mission's cards are
// being turned over, the state has already moved to the next round, so the
// reveal carries its own.
const shownHour = (v) => (game.stage === "missionResult" && v.event && v.event.type === "mission" ? (v.event.hour || null) : v.hour);
const silencedNow = (v) => !!v && v.phase !== "over" && shownHour(v) === "silence";
function signedLine(ev) {
  const failed = ev.cards.filter((c) => !c.success).map((c) => c.seat);
  return failed.length ? t("hour.signedResult", { who: nameList(failed) }) : t("hour.signedClean");
}

// ---------- solo ----------
function startGame() {
  leaveRoom(true);
  const n = setup.n;
  game.mode = "solo";
  game.rng = E.makeRng(E.randomSeed());
  game.st = E.createGame(E.randomSeed(), n, { blindSpies: setup.blind, hours: setup.hours });
  game.view = null; game.me = 0; game.level = setup.level;
  const pool = E.shuffle(game.rng, S.names.filter((x) => x !== setup.name));
  game.names = [setup.name || t("setup.defaultName"), ...pool.slice(0, n - 1)];
  game.stage = null; game.peeked = false; game.seen = false; game.picks = new Set(); game.log = []; game.lastVote = null; game.deadline = 0; game.hourSeen = 0;
  clearTimeout(game.stageTimer); clearTimeout(game.botTimer);
  addSys(t("sys.dealt", { name: nameOf(game.st.leader) }));
  show("table");
  render();
  tick();
}

// A new round's Hour card goes in the log once, when the round actually starts.
function announceHour() {
  const st = game.st;
  if (!st || !st.hour || st.rounds.length === game.hourSeen) return;
  game.hourSeen = st.rounds.length;
  addHour(t("hour.announce", { name: hourName(st.hour), desc: hourDesc(st.hour, E.view(st, game.me)) }));
}

// Bots act one at a time, on a timer, whenever the phase is waiting on them.
function tick() {
  clearTimeout(game.botTimer);
  if (game.mode !== "solo" || !game.st || game.stage || game.st.phase === "over") { render(); return; }
  announceHour();
  const bots = E.mustAct(game.st).filter((s) => s !== game.me);
  render();
  if (!bots.length) return;
  const seat = bots[game.rng.int(bots.length)];
  const wait = DELAY[game.st.phase] * (0.6 + 0.8 * game.rng.next());
  game.botTimer = setTimeout(() => botAct(seat), wait);
}
function botAct(seat) {
  if (game.mode !== "solo" || !game.st || game.stage) return;
  const view = E.view(game.st, seat);
  const action = B.decide(view, game.level, game.rng);
  if (!action) return tick();
  const line = view.hour === "silence" ? null : sayAction(action, view, talkCtx());
  game.st = E.apply(game.st, action);
  if (action.type === "propose") addSys(t("sys.proposed", { name: nameOf(seat), team: nameList(action.team) }));
  if (line) addSay(seat, line);
  afterStep();
}
function humanAct(action) {
  if (game.stage) return;
  if (game.mode === "net") { send({ type: "act", action }); return; }
  if (!game.st) return;
  try { game.st = E.apply(game.st, action); } catch (err) { console.warn(err.message); return; }
  if (action.type === "propose") addSys(t("sys.proposed", { name: nameOf(game.me), team: nameList(action.team) }));
  afterStep();
}

// After any solo action: pause on the events people need to see, else keep going.
function afterStep() {
  const ev = game.st.event;
  if (ev && ev.type === "voted") {
    game.stage = "voteResult";
    game.lastVote = ev;
    const outcome = ev.approved ? t("sys.approvedWord") : t("sys.rejectedWord");
    if (ev.dark) addSys(t("hour.darkResult", { yes: ev.yes, no: game.st.n - ev.yes, outcome }));
    else {
      const rejecters = ev.votes.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      addSys(rejecters.length
        ? t("sys.voteResult", { yes: ev.yes, no: game.st.n - ev.yes, outcome, rejecters: nameList(rejecters) })
        : t("sys.voteResultNone", { yes: ev.yes, no: game.st.n - ev.yes, outcome }));
    }
    if (ev.over) addSys(t("sys.spiesWinRejects"), true);
    render();
    game.stageTimer = setTimeout(continueStage, ev.over ? 2500 : 4000);
    return;
  }
  if (ev && ev.type === "mission") {
    game.stage = "missionResult";
    // A signed round turns the cards over in seat order with names on them.
    // Otherwise the order is shuffled once and fixed for the stage, so it
    // carries no information.
    game.lastCards = ev.cards
      ? ev.cards.map((c) => ({ fail: !c.success, seat: c.seat }))
      : E.shuffle(game.rng, ev.team.map((_, i) => ({ fail: i < ev.fails })));
    const outcome = ev.success ? t("table.missionSuccess").toLowerCase() : t("table.missionFailed").toLowerCase();
    addSys(t("sys.missionResult", { n: ev.mission + 1, outcome, fails: failsText(ev.fails, ev.team.length) }), !ev.success);
    if (ev.cards) addSys(signedLine(ev), ev.fails > 0);
    if (ev.hour === "orders" && ev.success) addSys(t("hour.ordersClean", { team: nameList(ev.team) }));
    render();
    const speakers = ev.hour === "silence" ? []
      : E.shuffle(game.rng, [...Array(game.st.n).keys()].filter((s) => s !== game.me)).slice(0, ev.success ? 2 : 3);
    speakers.forEach((s, i) => setTimeout(() => {
      if (game.stage !== "missionResult" || game.mode !== "solo") return;
      const line = sayResult(E.view(game.st, s), s, talkCtx());
      if (line) addSay(s, line);
    }, 1400 + i * 900));
    game.stageTimer = setTimeout(continueStage, ev.over ? 5000 : 6500);
    return;
  }
  if (game.st.phase === "propose" && game.st.rejects === E.MAX_REJECTS - 1) addSys(t("sys.fifthWarning"), true);
  tick();
}
function continueStage() {
  clearTimeout(game.stageTimer);
  game.stage = null;
  game.picks = new Set();
  if (game.st.phase === "over") {
    addSys(t("sys.over", { side: game.st.winner === E.SPY ? t("roles.spySide") : t("roles.resistanceSide") }));
    render();
    return;
  }
  tick();
}
const failsText = (fails, n) => (fails === 0 ? t("table.noFails") : t(fails === 1 ? "table.failsAmong" : "table.failsAmongPlural", { fails, n }));

// ---------- rooms ----------
const wsBase = () => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname.replace(/[^/]*$/, "") + "ws";
function connect(params) {
  const same = game.mode === "net" && game.code === params.code; // a reconnect keeps picks and the peeked flag
  leaveRoom(true);
  game.mode = "net"; game.st = null; game.view = null; game.lobby = null; game.closed = false;
  game.log = []; game.stage = null; game.names = []; game.me = null;
  if (!same) { game.gen = -1; game.picks = new Set(); }
  const q = new URLSearchParams({ name: setup.name || t("setup.defaultName"), lang });
  if (params.create) q.set("create", "1");
  else { q.set("room", params.code); const tok = sess.get("tr.token." + params.code); if (tok) q.set("token", tok); }
  const ws = game.ws = new WebSocket(wsBase() + "?" + q.toString());
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMsg(m); };
  ws.onclose = () => {
    if (game.ws !== ws) return;
    game.ws = null;
    if (game.closed) return;
    // Dropped: come back with the token so the seat is ours again.
    if (game.code) { setStatus(t("lobby.err.closed")); setTimeout(() => { if (!game.ws && !game.closed) connect({ code: game.code }); }, 2500); }
  };
}
function send(m) { if (game.ws && game.ws.readyState === 1) game.ws.send(JSON.stringify(m)); }
function leaveRoom(silent = false) {
  if (game.mode !== "net") return;
  game.closed = true;
  if (game.ws) { if (!silent) send({ type: "leave" }); try { game.ws.close(); } catch {} }
  game.ws = null; game.lobby = null; game.view = null; game.code = null;
  clearInterval(game.clock);
}
const logEntry = (e) => ({ seat: e.sys ? null : e.seat, text: e.text, hot: e.hot, sys: e.sys, kind: e.kind });
function onMsg(m) {
  switch (m.type) {
    case "joined":
      game.code = m.code; game.me = m.seat >= 0 ? m.seat : null;
      if (m.token) sess.set("tr.token." + m.code, m.token);
      if (!location.search.includes("room=" + m.code)) history.replaceState(null, "", location.pathname + "?room=" + m.code);
      break;
    case "lobby":
      game.lobby = m;
      if (m.phase === "lobby") { game.view = null; show("lobby"); renderLobby(); }
      else if (!game.view) { show("lobby"); renderLobby(); }
      else renderLobby();
      break;
    case "log":
      game.log = m.entries.map(logEntry);
      renderLog(); break;
    case "say":
      game.log.push(logEntry(m));
      renderLog(); break;
    case "view":
      if (!m.view) { game.view = null; if (game.lobby) { show("lobby"); renderLobby(); } break; }
      if (m.gen !== game.gen) { game.gen = m.gen; game.seen = false; game.peeked = false; game.picks = new Set(); }
      game.view = m.view; game.names = m.names; game.me = m.me; game.deadline = m.deadline || 0;
      game.stage = m.stage ? m.stage.kind : null;
      if (m.stage && m.stage.kind === "voteResult") game.lastVote = m.stage.event;
      if (m.stage && m.stage.cards) game.lastCards = m.stage.cards;
      if (m.view.phase !== "propose") game.picks = new Set();
      show("table"); render(); startClock();
      break;
    case "error":
      if (m.fatal) { leaveRoom(true); game.mode = "solo"; show("landing"); $("landStatus").textContent = m.key ? t("lobby.err." + m.key) : m.message; $("landStatus").className = "foot note err"; }
      else setStatus(m.key ? t("lobby.err." + m.key) : m.message, true);
      break;
  }
}
function setStatus(text, err = false) {
  const el = $("view-lobby").hidden ? $("landStatus") : $("lbStatus");
  el.textContent = text; el.classList.toggle("err", err);
}
function startClock() {
  clearInterval(game.clock);
  game.clock = setInterval(() => { const v = curView(); if (game.mode === "net" && v) renderBar(v); }, 1000);
}

// ---------- lobby view ----------
function renderLobby() {
  const L = game.lobby; if (!L) return;
  const host = game.me === 0;
  $("lbCode").textContent = L.code;
  $("lbSeatsLab").textContent = t("lobby.seats", { n: L.seats.length, max: E.MAX_PLAYERS }) + (L.seats.length < E.MIN_PLAYERS ? " · " + t("lobby.need", { min: E.MIN_PLAYERS }) : "");
  $("lbSeats").innerHTML = L.seats.map((s) => {
    const tags = [];
    if (s.idx === 0) tags.push(`<span class="tag host">${esc(t("lobby.host"))}</span>`);
    if (s.ai) tags.push(`<span class="tag">${esc(t("lobby.bot"))}</span>`);
    else if (!s.connected) tags.push(`<span class="tag off">${esc(t("lobby.away"))}</span>`);
    else if (s.idx !== 0) tags.push(`<span class="tag ${s.ready ? "ok" : ""}">${esc(s.ready ? t("lobby.ready") : t("lobby.notReady"))}</span>`);
    if (host && s.ai && L.phase === "lobby") tags.push(`<button type="button" class="tag x" data-remove="${s.idx}">${esc(t("lobby.remove"))}</button>`);
    return `<div class="li"><span class="av ${s.ai ? "bot" : ""}">${esc([...s.name][0] || "?")}</span><span class="nm">${esc(s.name)}${s.idx === game.me ? ` <small class="muted">· ${esc(t("lobby.you"))}</small>` : ""}</span>${tags.join("")}</div>`;
  }).join("") + (host && L.phase === "lobby" && L.seats.length < E.MAX_PLAYERS ? `<button type="button" class="li empty" id="lbAdd">${esc(t("lobby.addBot"))}</button>` : "");
  $("lbSeats").querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => send({ type: "removeBot", idx: Number(b.dataset.remove) })));
  const add = $("lbAdd"); if (add) add.addEventListener("click", () => send({ type: "addBot" }));
  $("lbHost").hidden = !host || L.phase !== "lobby";
  document.querySelectorAll("#lbLevel button").forEach((b) => b.classList.toggle("on", b.dataset.level === L.settings.level));
  $("lbBlind").checked = !!L.settings.blindSpies;
  $("lbHours").checked = !!L.settings.hours;
  const me = L.seats.find((s) => s.idx === game.me);
  $("lbReady").hidden = host || !me || L.phase !== "lobby";
  $("lbReady").textContent = me && me.ready ? t("lobby.notReady") : t("lobby.ready");
  $("lbReady").classList.toggle("p", !(me && me.ready));
  $("lbStart").hidden = !host || L.phase !== "lobby";
  $("lbStart").textContent = t("lobby.start", { n: L.seats.length });
  const waiting = L.seats.filter((s) => !s.ai && s.idx !== 0 && !s.ready).length;
  $("lbStatus").classList.remove("err");
  $("lbStatus").textContent = !me ? t("lobby.spectating")
    : L.phase !== "lobby" ? t("lobby.rematchWait")
    : waiting ? t("lobby.waiting", { n: waiting })
    : host ? t("lobby.canStart") : t("lobby.hostStarts");
  renderLog();
}
$("lbLeave").addEventListener("click", () => { leaveRoom(); go(""); });
$("lbCopy").addEventListener("click", async () => {
  const url = location.origin + location.pathname + "?room=" + game.code;
  try { await navigator.clipboard.writeText(url); $("lbCopy").textContent = t("lobby.copied"); setTimeout(() => { $("lbCopy").textContent = t("lobby.copy"); }, 1500); } catch {}
});
$("lbShare").addEventListener("click", async () => {
  const url = location.origin + location.pathname + "?room=" + game.code;
  if (navigator.share) { try { await navigator.share({ title: t("title"), text: game.code, url }); } catch {} }
  else $("lbCopy").click();
});
$("lbReady").addEventListener("click", () => { const me = game.lobby?.seats.find((s) => s.idx === game.me); send({ type: "ready", ready: !(me && me.ready) }); });
$("lbStart").addEventListener("click", () => send({ type: "start" }));
document.querySelectorAll("#lbLevel button").forEach((b) => b.addEventListener("click", () => send({ type: "settings", level: b.dataset.level })));
$("lbBlind").addEventListener("change", (e) => send({ type: "settings", blindSpies: e.target.checked }));
$("lbHours").addEventListener("change", (e) => send({ type: "settings", hours: e.target.checked }));
const chatSend = (inp) => { const text = inp.value.trim(); if (!text) return; send({ type: "chat", text }); inp.value = ""; };
$("lbSend").addEventListener("click", () => chatSend($("lbChat")));
$("lbChat").addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend($("lbChat")); });
$("chatSend").addEventListener("click", () => chatSend($("chatIn")));
$("chatIn").addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend($("chatIn")); });
$("tableLeave").addEventListener("click", () => { leaveRoom(); go(""); });

// ---------- log ----------
function addSay(seat, text) { game.log.push({ seat, text }); renderLog(); }
function addSys(text, hot = false) { game.log.push({ sys: true, seat: null, text, hot }); renderLog(); }
function addHour(text) { game.log.push({ sys: true, seat: null, text, kind: "hour" }); renderLog(); }
function renderLog() {
  const html = game.log.slice(-80).map((l) => l.sys
    ? `<div class="sys${l.kind === "hour" ? " hourline" : l.hot ? " hot" : ""}">${esc(l.text)}</div>`
    : `<div class="${l.seat === game.me ? "me" : ""}"><b>${esc(nameOf(l.seat))}</b> ${esc(l.text)}</div>`).join("");
  for (const id of ["log", "lbLog"]) { const el = $(id); el.innerHTML = html; el.scrollTop = el.scrollHeight; }
}

// ---------- rendering the table ----------
function render() {
  const v = curView();
  if (!v) return;
  renderBar(v); renderTrack(v); renderVoteTrack(v); renderHour(v); renderRing(v); renderPanel(v); renderLog();
  renderOverlay(v);
  $("chatRow").hidden = game.mode !== "net";
  $("tableFoot").hidden = game.mode !== "net";
  const hush = silencedNow(v);
  $("chatIn").disabled = hush; $("chatSend").disabled = hush;
  $("chatIn").placeholder = hush ? t("hour.silenced") : t("table.say");
}
function fmtClock(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function renderBar(v) {
  const left = v.phase === "over" ? t("over.title") : `${t("table.round", { n: Math.max(1, v.rounds.length) })} · ${t("table.mission", { n: Math.min(v.mission + 1, E.MISSIONS) })}`;
  $("barLeft").textContent = left;
  const lead = v.leader === game.me ? t("table.youLead") : t("table.leads", { name: nameOf(v.leader) });
  const clock = game.mode === "net" && game.deadline && !game.stage && v.phase !== "over" ? ` <span class="t ${game.deadline - Date.now() < 10_000 ? "red" : ""}">${fmtClock(game.deadline - Date.now())}</span>` : "";
  $("barRight").innerHTML = v.phase === "over" ? "" : `<span class="t">${esc(lead)}</span>${clock}`;
}
function renderTrack(v) {
  const results = v.rounds.map((r) => r.result).filter(Boolean);
  const live = v.phase !== "over" && game.stage !== "missionResult";
  $("track").innerHTML = v.sizes.map((size, i) => {
    const r = results[i];
    const cls = r ? (r.success ? "ok" : "no") : (i === v.mission && v.phase !== "over" ? "cur" : "");
    const two = E.failsNeeded(v.n, i) === 2 ? " ✕✕" : "";
    // Travel Light shows on the current mission's size.
    const shown = live && i === v.mission && v.teamSize != null ? v.teamSize : size;
    return `<div class="m ${cls}${shown !== size ? " light" : ""}">${i + 1}<i>${shown}${two}</i></div>`;
  }).join("");
}
function renderVoteTrack(v) {
  const pips = [...Array(E.MAX_REJECTS).keys()].map((i) => `<span class="${i < v.rejects ? "x" : ""}"></span>`).join("");
  const label = v.phase === "over" ? "" : (v.rejects ? t("table.rejected", { n: v.rejects }) : "");
  $("vtrack").innerHTML = pips + (label ? `<em>${esc(label)}</em>` : "");
}
function renderHour(v) {
  const el = $("hourBar");
  // Hidden while a mission's cards turn over: by then the next card is already
  // drawn, and the log carries both.
  if (!v.options.hours || !v.hour || v.phase === "reveal" || v.phase === "over" || game.stage === "missionResult") { el.hidden = true; return; }
  el.hidden = false;
  el.className = `hour h-${v.hour}`;
  el.innerHTML = `<span class="k">${esc(t("hour.label"))}</span><b>${esc(hourName(v.hour))}</b><span class="left">${esc(t("hour.left", { n: v.hourDeck.length }))}</span><span class="d">${esc(hourDesc(v.hour, v))}</span>`;
}
function renderRing(v) {
  const n = v.n, me = game.me;
  const ring = $("ring");
  ring.style.setProperty("--r", `${Math.round(ring.clientWidth * 0.41)}px`);
  const team = v.proposal || [];
  // Lights Out: the tally shows in the centre, but no seat shows its vote.
  const votes = game.stage === "voteResult" && game.lastVote && !game.lastVote.dark ? game.lastVote.votes : null;
  const recusedSeat = v.hour === "recused" && v.phase === "propose" && !game.stage ? v.leader : null;
  const mySpies = v.spies || [];
  const proposing = v.phase === "propose" && v.leader === me && !game.stage;
  const anchor = me === null ? 0 : me;
  const html = [];
  for (let i = 0; i < n; i++) {
    const a = (((i - anchor) / n) + 0.5) % 1; // me at the bottom
    const hurt = v.wounded != null && i === v.wounded && v.phase !== "over" && game.stage !== "missionResult";
    const recused = i === recusedSeat;
    const cls = ["seat"];
    if (i === me) cls.push("you");
    if (i === v.leader && v.phase !== "over") cls.push("lead");
    if (team.includes(i)) cls.push("team");
    if (proposing && game.picks.has(i)) cls.push("pick");
    // A spy sees every spy in red, themself included; operatives see nothing.
    if ((mySpies.includes(i) || (v.role === E.SPY && i === me)) && v.phase !== "over") cls.push("spy");
    if ((v.phase === "vote" || v.phase === "mission") && team.length && !team.includes(i) && !game.stage) cls.push("dim");
    if (hurt) cls.push("hurt");
    if (recused) cls.push("recused");
    if (proposing && !hurt && !recused) cls.push("tappable");
    let badge = "";
    if (votes) badge = `<span class="v ${votes[i] ? "y" : "n"}">${votes[i] ? "✓" : "✕"}</span>`;
    else if (v.phase === "vote" && v.voted && !game.stage) badge = `<span class="done ${v.voted[i] ? "on" : ""}"></span>`;
    else if (v.phase === "mission" && v.played && team.includes(i) && !game.stage) badge = `<span class="done ${v.played[team.indexOf(i)] ? "on" : ""}"></span>`;
    const isBot = game.mode === "solo" ? i !== me : !!game.lobby?.seats?.[i]?.ai;
    const ai = isBot ? `<span class="ai">${esc(t("table.ai"))}</span>` : "";
    const initial = esc([...nameOf(i)][0] || "?");
    const hurtTag = hurt ? `<span class="hurt-tag">${esc(t("hour.hurt"))}</span>` : recused ? `<span class="hurt-tag">${esc(t("hour.recusedTag"))}</span>` : "";
    html.push(`<button type="button" class="${cls.join(" ")}" style="--a:${a}" data-seat="${i}" ${proposing && !hurt && !recused ? "" : "tabindex=-1"}><span class="av">${initial}${ai}${badge}</span><span class="nm">${esc(i === me ? t("table.you") : nameOf(i))}</span>${hurtTag}</button>`);
  }
  html.push(`<div class="center">${centerHtml(v)}</div>`);
  ring.innerHTML = html.join("");
  if (proposing) ring.querySelectorAll(".seat.tappable").forEach((el) => el.addEventListener("click", () => togglePick(Number(el.dataset.seat))));
}
function centerHtml(v) {
  const me = game.me;
  if (game.stage === "voteResult" && game.lastVote) {
    const ev = game.lastVote;
    return `<span class="k">${esc(ev.approved ? t("table.approved") : t("table.rejectedTeam"))}</span><div class="big ${ev.approved ? "blue" : "red"}">${ev.yes}–${v.n - ev.yes}</div><span class="sub">${esc((ev.dark ? t("hour.darkShown") + " · " : "") + (ev.approved ? t("table.teamGoes") : (v.phase === "over" ? "" : t("table.nextLeader", { name: nameOf(v.leader) }))))}</span>`;
  }
  if (game.stage === "missionResult" && v.event && v.event.type === "mission") {
    const ev = v.event;
    const head = ev.cards ? t("hour.signedShown") : t("table.shuffled");
    const sub = ev.hour === "orders" && ev.success ? t("hour.ordersCleanShort")
      : failsText(ev.fails, ev.team.length) + (ev.need === 2 && ev.fails === 1 ? " · " + t("table.twoNeeded") : "");
    return `<span class="k">${esc(head)}</span><div class="big ${ev.success ? "blue" : "red"}">${esc(ev.success ? t("table.missionSuccess") : t("table.missionFailed"))}</div><span class="sub">${esc(sub)}</span>`;
  }
  if (v.phase === "reveal") return "";
  if (v.phase === "propose") {
    if (v.leader === me) return `<span class="k">${esc(t("table.pick"))}</span><div class="big">${game.picks.size}<span class="dimmed">/${v.teamSize}</span></div><span class="sub">${esc(t("table.tapSeats"))}</span>`;
    return `<span class="k">${esc(t("table.mission", { n: v.mission + 1 }))}</span><div class="big dimmed">${v.teamSize}</div><span class="sub">${esc(t("table.choosing", { name: nameOf(v.leader) }))}</span>`;
  }
  if (v.phase === "vote") {
    const done = v.voted.filter(Boolean).length;
    return `<span class="k">${esc(t("table.proposes", { name: nameOf(v.leader) }))}</span><div class="big mid">${esc(nameList(v.proposal).replace(/, |、/g, " · "))}</div><span class="sub">${esc(t("table.voted", { done, n: v.n }))}</span>`;
  }
  if (v.phase === "mission") {
    const done = v.played.filter(Boolean).length;
    return `<span class="k">${esc(t("table.mission", { n: v.mission + 1 }))}</span><div class="big mid">${esc(nameList(v.proposal).replace(/, |、/g, " · "))}</div><span class="sub">${esc(t("table.agentsChoosing", { n: v.proposal.length - done }))}</span>`;
  }
  if (v.phase === "over") {
    const spyWin = v.winner === E.SPY;
    return `<span class="k">${esc(t("over.title"))}</span><div class="big ${spyWin ? "red" : "blue"} mid">${esc(spyWin ? t("over.spyWin") : t("over.resWin"))}</div>`;
  }
  return "";
}
function togglePick(seat) {
  const v = curView();
  if ((v.wounded != null && seat === v.wounded) || (v.hour === "recused" && seat === v.leader)) return;
  if (game.picks.has(seat)) game.picks.delete(seat);
  else if (game.picks.size < v.teamSize) game.picks.add(seat);
  renderRing(v); renderPanel(v);
}

function renderPanel(v) {
  const me = game.me, p = $("panel");
  const btn = (id, cls, label, disabled = false) => `<button type="button" id="${id}" class="btn ${cls}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`;
  const cont = game.mode === "solo" ? btn("btnCont", "gh", t("table.continue")) : "";
  const wire = () => { const b = $("btnCont"); if (b) b.addEventListener("click", continueStage); };
  if (game.stage === "voteResult") { p.innerHTML = cont; wire(); return; }
  if (game.stage === "missionResult" && v.event && v.event.type === "mission") {
    const cards = game.lastCards || v.event.team.map((_, i) => ({ fail: i < v.event.fails }));
    p.innerHTML = `<div class="flip">${cards.map((c, i) => `<div class="card" style="transition-delay:${i * 250}ms"><div class="face back"></div><div class="face ${c.fail ? "f" : "s"}">${esc(c.fail ? t("table.fail") : t("table.success"))}${c.seat != null ? `<small class="who">${esc(c.seat === me ? t("table.you") : nameOf(c.seat))}</small>` : ""}</div></div>`).join("")}</div>`
      + (v.phase !== "over" ? `<div class="field small"><span>${esc(t("table.nextLeader", { name: v.leader === me ? t("table.you") : nameOf(v.leader) }))}</span></div>` : "")
      + cont;
    requestAnimationFrame(() => requestAnimationFrame(() => p.querySelectorAll(".card").forEach((c) => c.classList.add("shown"))));
    wire();
    return;
  }
  if (me === null && v.phase !== "over") { p.innerHTML = `<p class="note">${esc(t("lobby.spectating"))}</p>`; return; }
  switch (v.phase) {
    case "propose":
      if (v.leader === me) {
        p.innerHTML = btn("btnPropose", "p", t("table.propose"), game.picks.size !== v.teamSize);
        $("btnPropose").addEventListener("click", () => humanAct({ type: "propose", seat: me, team: [...game.picks] }));
      } else p.innerHTML = "";
      return;
    case "vote":
      if (v.voted[me]) {
        p.innerHTML = `<p class="note">${esc(t("table.youVoted", { vote: v.myVote ? t("table.approve") : t("table.reject") }))}</p>`;
      } else {
        p.innerHTML = `<div class="row">${btn("btnYes", "p", t("table.approve"))}${btn("btnNo", "r", t("table.reject"))}</div>`;
        $("btnYes").addEventListener("click", () => humanAct({ type: "vote", seat: me, approve: true }));
        $("btnNo").addEventListener("click", () => humanAct({ type: "vote", seat: me, approve: false }));
      }
      return;
    case "mission":
      if (v.proposal.includes(me) && v.myCard === null) {
        const spy = v.role === E.SPY;
        const underOrders = spy && v.hour === "orders";
        const sub = v.hour === "signed" ? t("hour.signedNote") : t("table.playSub");
        p.innerHTML = `<p class="ph"><span>${esc(t("table.playCard"))}</span><small>${esc(sub)}</small></p>
          <div class="cards">
            <button type="button" id="cardS" class="mc s" ${underOrders ? "disabled" : ""}>${esc(t("table.success"))}<small>${esc(underOrders ? t("hour.mustFail") : t("table.tapToPlay"))}</small></button>
            <button type="button" id="cardF" class="mc f" ${spy ? "" : "disabled"}>${esc(t("table.fail"))}<small>${esc(spy ? t("table.tapToPlay") : t("table.notForYou"))}</small></button>
          </div>`;
        $("cardS").addEventListener("click", () => humanAct({ type: "play", seat: me, success: true }));
        $("cardF").addEventListener("click", () => humanAct({ type: "play", seat: me, success: false }));
      } else p.innerHTML = `<p class="note">${esc(t("table.waitingTeam"))}</p>`;
      return;
    case "over":
      p.innerHTML = overHtml(v);
      { const b = $("btnAgain"); if (b) b.addEventListener("click", () => (game.mode === "solo" ? startGame() : send({ type: "rematch" }))); }
      return;
    default:
      p.innerHTML = "";
  }
}
function overHtml(v) {
  const me = game.me, spyWin = v.winner === E.SPY;
  const mine = me !== null && v.roles[me] === E.SPY;
  const won = me !== null && mine === spyWin;
  const why = v.reason === "rejects" ? t("over.byRejects") : t("over.byMissions", { what: spyWin ? t("over.failed") : t("over.succeeded") });
  const chips = [...Array(v.n).keys()].sort((a, b) => (v.roles[a] === E.SPY ? 0 : 1) - (v.roles[b] === E.SPY ? 0 : 1))
    .map((s) => `<span class="${v.roles[s] === E.SPY ? "s" : "r"}">${esc(s === me ? t("table.you") : nameOf(s))}</span>`).join("");
  const rows = v.rounds.map((r) => {
    const p = r.proposals[r.proposals.length - 1];
    const teamStr = r.result ? nameList(r.result.team) : (p ? nameList(p.team) : "");
    const voteStr = p ? `${p.votes.filter(Boolean).length}–${p.votes.length - p.votes.filter(Boolean).length}${r.proposals.length > 1 ? ` (×${r.proposals.length})` : ""}` : "";
    const res = r.result ? `<span class="dot ${r.result.success ? "ok" : "no"}"></span>${esc(t(r.result.fails === 1 ? "over.fails" : "over.failsPlural", { n: r.result.fails }))}` : "";
    const hourTag = r.hour ? `<br><small class="hour-tag">${esc(hourName(r.hour))}</small>` : "";
    return `<tr><td>${r.mission + 1}${hourTag}</td><td>${esc(teamStr)}</td><td>${voteStr}</td><td>${res}</td></tr>`;
  }).join("");
  const you = me === null ? "" : `${esc(t("over.youWere", { role: mine ? t("roles.spy") : t("roles.resistance") }))} ${esc(won ? t("over.youWon") : t("over.youLost"))}`;
  const again = game.mode === "solo" || game.me === 0
    ? `<button type="button" id="btnAgain" class="btn p">${esc(t("over.again"))}</button>`
    : `<span class="btn gh" style="opacity:.6">${esc(t("lobby.rematchWait"))}</span>`;
  return `<div class="result-head"><span class="k">${esc(why)}</span><span class="sub">${you}</span></div>
    <span class="lab">${esc(t("over.spies"))}</span><div class="who">${chips}</div>
    <table class="h"><tr><th>${esc(t("over.hM"))}</th><th>${esc(t("over.hTeam"))}</th><th>${esc(t("over.hVote"))}</th><th>${esc(t("over.hResult"))}</th></tr>${rows}</table>
    <div class="row"><a class="btn" href="rules">${esc(t("over.rules"))}</a>${again}</div>`;
}

// ---------- reveal overlay ----------
function renderOverlay(v) {
  const ov = $("overlay");
  if (v.phase !== "reveal" || game.me === null || v.ready[game.me]) { ov.hidden = true; return; }
  const spy = v.role === E.SPY;
  const mates = spy ? (v.spies ? v.spies.filter((s) => s !== game.me) : null) : null;
  ov.hidden = false;
  ov.innerHTML = `<div class="sheet">
    <div id="roleCard" class="card-role ${game.peeked ? (spy ? "spy" : "res") : "hidden-role"}">
      ${game.peeked ? `<span class="k">${esc(t("reveal.yourCard"))}</span><span class="role">${esc(spy ? t("reveal.spy") : t("reveal.res"))}</span><p>${esc(spy ? t("reveal.spyText") : t("reveal.resText"))}</p>`
        + (spy ? (mates ? `<span class="k" style="margin-top:8px">${esc(t("reveal.others"))}</span><div class="mates">${mates.map((s) => `<div><span class="av">${esc([...nameOf(s)][0])}</span>${esc(nameOf(s))}</div>`).join("")}</div>` : `<p class="muted">${esc(t("reveal.blind"))}</p>`) : "")
        : `<span class="k">${esc(t("reveal.yourCard"))}</span><span class="role" style="color:var(--mute)">?</span>`}
    </div>
    <button type="button" id="btnPeek" class="btn">${esc(game.peeked ? t("reveal.release") : t("reveal.hold"))}</button>
    <button type="button" id="btnReady" class="btn p" ${game.seen ? "" : "disabled"}>${esc(t("reveal.ready"))}</button>
  </div>`;
  const peek = (on) => { game.peeked = on; if (on) game.seen = true; renderOverlay(v); };
  const pb = $("btnPeek");
  pb.addEventListener("pointerdown", (e) => { e.preventDefault(); peek(true); });
  pb.addEventListener("pointerup", () => peek(false));
  pb.addEventListener("pointerleave", () => { if (game.peeked) peek(false); });
  pb.addEventListener("pointercancel", () => peek(false));
  pb.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); peek(!game.peeked); } });
  $("btnReady").addEventListener("click", () => { game.peeked = false; humanAct({ type: "ready", seat: game.me }); });
}

// ---------- routing ----------
const views = ["landing", "setup", "lobby", "table"];
function show(name) { for (const v of views) $("view-" + v).hidden = v !== name; if (name !== "table") $("overlay").hidden = true; }
function go(q) { history.pushState(null, "", location.pathname + q); route(); }
function route() {
  const q = new URLSearchParams(location.search);
  if (q.has("lang")) setLang(q.get("lang"));
  const code = (q.get("room") || "").toUpperCase();
  $("landStatus").textContent = ""; $("landStatus").className = "foot muted";
  if (q.has("play")) {
    leaveRoom(true); game.mode = "solo";
    if (game.st && game.st.phase !== "over") { show("table"); render(); } else { show("setup"); renderSetup(); }
  } else if (/^[A-Z0-9]{4}$/.test(code)) {
    if (game.mode === "net" && game.code === code && game.ws) { show(game.view ? "table" : "lobby"); return; }
    if (!setup.name) { show("landing"); $("joinCode").value = code; $("landStatus").textContent = t("landing.soon"); $("landName").focus(); return; }
    connect({ code });
    show("lobby"); $("lbCode").textContent = code; $("lbSeats").innerHTML = ""; $("lbStatus").textContent = t("lobby.connecting");
  } else {
    leaveRoom(true);
    game.mode = "solo"; game.view = null;
    show("landing");
  }
}
$("btnCreate").addEventListener("click", () => {
  if (!setup.name) { $("landStatus").textContent = t("landing.soon"); $("landName").focus(); return; }
  connect({ create: true });
  show("lobby"); $("lbCode").textContent = "····"; $("lbSeats").innerHTML = ""; $("lbStatus").textContent = t("lobby.connecting");
});
$("btnJoin").addEventListener("click", () => {
  const code = $("joinCode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { $("landStatus").textContent = t("landing.badCode"); return; }
  go("?room=" + code);
});
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoin").click(); });
document.querySelectorAll("[data-link]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); leaveRoom(); go(""); }));
window.addEventListener("popstate", route);
window.addEventListener("resize", () => { const v = curView(); if (v && !$("view-table").hidden) renderRing(v); });

const q0 = new URLSearchParams(location.search);
setLang(q0.get("lang") || store.get("tr.lang", (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh-Hant" : "en"));
route();
