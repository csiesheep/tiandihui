// One Durable Object per room, named by its four-letter code. It is the
// authority on the game: it deals the roles, applies every action through
// the engine, runs the bot seats, keeps the phase clock, and — the one rule
// that keeps spies secret — sends each socket only `view(state, seat)`,
// never the state.
//
// Connections use the WebSocket Hibernation API, so an idle room costs
// nothing between messages. Everything needed to resume is in storage under
// "room"; all timers are the object's single alarm.
import * as E from "../public/shared/engine.js";
import * as B from "../public/shared/bots.js";
import { sayAction, sayResult } from "../public/shared/talk.js";
import en from "../public/i18n/en.js";
import zh from "../public/i18n/zh-Hant.js";

const LANGS = { en, "zh-Hant": zh };
const PHASE_MS = { reveal: 30_000, propose: 90_000, vote: 30_000, mission: 30_000 };
const STAGE_MS = { voted: 4_500, mission: 7_000 };
const BOT_MS = 1_100;        // pause between bot actions so people can follow
const GRACE_MS = 15_000;     // a disconnected human's decisions go to the bot after this
const IDLE_MS = 30 * 60_000; // a room nobody is connected to is deleted after this
const MIN_SEATS = E.MIN_PLAYERS, MAX_SEATS = E.MAX_PLAYERS;
const LOG_KEEP = 120, CHAT_MAX = 200;

const clean = (s) => String(s ?? "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 16);
const newToken = () => crypto.randomUUID().replace(/-/g, "");

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = undefined; // undefined = not loaded yet, null = no room here
  }

  // ---------- persistence ----------
  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get("room")) || null;
    return this.room;
  }
  async save() { if (this.room) await this.ctx.storage.put("room", this.room); }
  withRng(fn) {
    const rng = E.makeRng(0);
    rng.setState(this.room.rngState);
    const out = fn(rng);
    this.room.rngState = rng.getState();
    return out;
  }
  get S() { return LANGS[this.room.settings.lang] || en; }
  t(key, p = {}) {
    const v = key.split(".").reduce((o, k) => (o ? o[k] : undefined), this.S);
    return String(v ?? key).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ""));
  }
  names() { return this.room.seats.map((s) => s.name); }
  nameList(seats) { return seats.map((s) => this.room.seats[s].name).join(this.room.settings.lang === "en" ? ", " : "、"); }
  talkCtx(rng) {
    const l = this.room.settings.lang;
    return { rng, names: this.names(), T: this.S.talk, sep: l === "en" ? ", " : "、", and: l === "en" ? " and " : "和" };
  }

  // ---------- sockets ----------
  sockets(tag) { return this.ctx.getWebSockets(tag); }
  connected(seat) { return !seat.ai && this.sockets(seat.token).length > 0; }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const ws of this.sockets()) { try { ws.send(json); } catch {} }
  }
  seatOf(ws) {
    const att = ws.deserializeAttachment();
    return att?.token ? this.room.seats.find((s) => s.token === att.token) || null : null;
  }
  lobbyMsg() {
    const r = this.room;
    return {
      type: "lobby", code: r.code, phase: r.phase, settings: r.settings,
      seats: r.seats.map((s) => ({ idx: s.idx, name: s.name, ready: s.ready, connected: s.ai || this.connected(s), ai: s.ai })),
    };
  }
  pushLobby() { this.broadcast(this.lobbyMsg()); }
  viewMsg(seat) {
    const r = this.room;
    return {
      type: "view", view: E.view(r.state, seat ? seat.idx : null), me: seat ? seat.idx : null,
      names: this.names(), deadline: r.stage ? 0 : r.deadline, stage: r.stage, gen: r.gen,
    };
  }
  pushViews() {
    this.room.lastActive = Date.now();
    for (const ws of this.sockets()) this.send(ws, this.viewMsg(this.seatOf(ws)));
  }
  say(seat, text, hot = false, kind = undefined) {
    const entry = { seat, text, hot, sys: seat === null };
    if (kind) entry.kind = kind;
    this.room.log.push(entry);
    if (this.room.log.length > LOG_KEEP) this.room.log.splice(0, this.room.log.length - LOG_KEEP);
    this.broadcast({ type: "say", ...entry });
  }

  // Whether the round on the table is under Hold Your Tongue. While a
  // mission's cards turn over, the state has already drawn the next round's
  // card, so the reveal's own card decides.
  silenced() {
    const r = this.room;
    if (r.phase !== "game" || !r.state) return false;
    if (r.stage && r.stage.kind === "missionResult") return r.stage.event.hour === "silence";
    return r.state.hour === "silence";
  }

  // ---------- the one alarm ----------
  async scheduleAt(at) { this.room.alarmAt = at; await this.ctx.storage.setAlarm(at); }
  async clearAlarm() { this.room.alarmAt = 0; await this.ctx.storage.deleteAlarm(); }
  async maybeIdle() {
    const r = this.room;
    if (this.sockets().length === 0 && (r.phase !== "game" || !r.state || r.state.phase === "over")) {
      r.idle = true;
      await this.scheduleAt(Date.now() + IDLE_MS);
    }
  }
  async alarm() {
    const room = await this.load();
    if (!room) return;
    if (room.idle) {
      if (this.sockets().length === 0) { await this.ctx.storage.deleteAll(); this.room = null; return; }
      room.idle = false;
    }
    await this.pump();
    await this.save();
  }

  // ---------- HTTP entry: status probe or WebSocket upgrade ----------
  async fetch(request) {
    const url = new URL(request.url);
    const room = await this.load();
    if (url.pathname.endsWith("/status")) return Response.json({ exists: !!room });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });

    const code = url.searchParams.get("room");
    const name = clean(url.searchParams.get("name"));
    const tok = url.searchParams.get("token");
    const create = url.searchParams.get("create") === "1";
    const lang = LANGS[url.searchParams.get("lang")] ? url.searchParams.get("lang") : "en";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const reject = (key) => {
      server.accept();
      this.send(server, { type: "error", key, fatal: true });
      server.close(1008, "rejected");
      return new Response(null, { status: 101, webSocket: client });
    };

    let seat = null;
    if (!room) {
      if (!create) return reject("noRoom");
      this.room = {
        code, phase: "lobby", seats: [], settings: { level: "normal", blindSpies: false, hours: false, lang },
        state: null, rngState: E.randomSeed(), gen: 0, deadline: 0, phaseKey: "", stage: null,
        log: [], alarmAt: 0, idle: false, lastActive: Date.now(), hourSeen: 0,
      };
      seat = this.addSeat(name || this.t("setup.defaultName"));
    } else if (tok && (seat = room.seats.find((s) => s.token === tok && !s.ai))) {
      for (const old of this.sockets(tok)) { try { old.close(1000, "replaced"); } catch {} }
    } else if (room.phase !== "lobby") {
      seat = null; // spectator
    } else if (room.seats.length >= MAX_SEATS) {
      return reject("full");
    } else {
      seat = this.addSeat(name || this.t("setup.defaultName"));
      this.say(null, this.t("sys.joined", { name: seat.name }));
    }

    this.ctx.acceptWebSocket(server, [seat ? seat.token : "spectator"]);
    server.serializeAttachment({ token: seat ? seat.token : null });
    if (this.room.idle) { this.room.idle = false; await this.clearAlarm(); }

    this.send(server, { type: "joined", code: this.room.code, seat: seat ? seat.idx : -1, token: seat ? seat.token : null });
    this.pushLobby();
    this.send(server, { type: "log", entries: this.room.log });
    if (this.room.state) this.send(server, this.viewMsg(seat));
    await this.save();
    return new Response(null, { status: 101, webSocket: client });
  }

  addSeat(name) {
    const r = this.room;
    const taken = new Set(r.seats.map((s) => s.name));
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name} ${i}`;
    const seat = { idx: r.seats.length, name: n, token: newToken(), ready: false, ai: false, lastSeen: Date.now() };
    r.seats.push(seat);
    return seat;
  }
  addBot() {
    const r = this.room;
    const taken = new Set(r.seats.map((s) => s.name));
    const pool = this.withRng((rng) => E.shuffle(rng, this.S.names)).filter((n) => !taken.has(n));
    const name = pool[0] || `Bot ${r.seats.length + 1}`;
    r.seats.push({ idx: r.seats.length, name, token: `ai-${newToken()}`, ready: true, ai: true, lastSeen: 0 });
  }
  reindex() { this.room.seats.forEach((s, i) => { s.idx = i; }); }

  // ---------- messages ----------
  async webSocketMessage(ws, raw) {
    const room = await this.load();
    if (!room) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const seat = this.seatOf(ws);
    const isHost = seat && seat.idx === 0;
    room.lastActive = Date.now();
    if (seat) seat.lastSeen = Date.now();
    switch (m.type) {
      case "ready":
        if (!seat || room.phase !== "lobby") return;
        seat.ready = !!m.ready; this.pushLobby(); break;
      case "settings":
        if (!isHost || room.phase !== "lobby") return;
        if (B.LEVELS.includes(m.level)) room.settings.level = m.level;
        if (typeof m.blindSpies === "boolean") room.settings.blindSpies = m.blindSpies;
        if (typeof m.hours === "boolean") room.settings.hours = m.hours;
        this.pushLobby(); break;
      case "addBot":
        if (!isHost || room.phase !== "lobby" || room.seats.length >= MAX_SEATS) return;
        this.addBot(); this.pushLobby(); break;
      case "removeBot": {
        if (!isHost || room.phase !== "lobby") return;
        const i = room.seats.findIndex((s) => s.ai && s.idx === (m.idx | 0));
        if (i < 0) return;
        room.seats.splice(i, 1); this.reindex(); this.pushLobby(); break;
      }
      case "start": {
        if (!isHost || room.phase !== "lobby") return;
        if (room.seats.length < MIN_SEATS) return this.send(ws, { type: "error", key: "needMore" });
        if (room.seats.slice(1).some((s) => !s.ai && !s.ready)) return this.send(ws, { type: "error", key: "notReady" });
        await this.startGame(); break;
      }
      case "act": {
        if (!seat || room.phase !== "game" || room.stage || !m.action) return;
        const action = { ...m.action, seat: seat.idx };
        if (!E.mustAct(room.state).includes(seat.idx)) return;
        try { this.applyAction(action, false); } catch (err) { return this.send(ws, { type: "error", message: err.message }); }
        await this.afterChange(); break;
      }
      case "chat": {
        if (!seat || this.silenced()) return;
        const text = String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX);
        if (!text) return;
        this.say(seat.idx, text); break;
      }
      case "rematch":
        if (!isHost || room.phase !== "over") return;
        await this.clearAlarm();
        room.phase = "lobby"; room.state = null; room.stage = null; room.deadline = 0; room.phaseKey = "";
        for (const s of room.seats) s.ready = s.ai;
        this.pushLobby(); this.broadcast({ type: "view", view: null }); break;
      case "leave":
        await this.leave(seat);
        try { ws.close(1000, "left"); } catch {}
        break;
    }
    await this.save();
  }

  async leave(seat) {
    const room = this.room;
    if (!seat) return;
    if (room.phase === "lobby" || room.phase === "over") {
      room.seats = room.seats.filter((s) => s !== seat);
      this.reindex();
      if (room.phase === "over") { room.state = null; room.phase = "lobby"; room.stage = null; for (const s of room.seats) s.ready = s.ai; }
      if (!room.seats.some((s) => !s.ai)) { await this.clearAlarm(); await this.ctx.storage.deleteAll(); this.room = null; return; }
      this.say(null, this.t("sys.left", { name: seat.name }));
      this.pushLobby();
    } else {
      // Mid-game the seat becomes a bot so the table keeps moving.
      seat.ai = true;
      this.say(null, this.t("sys.leftGame", { name: seat.name }));
      this.pushLobby();
      await this.afterChange();
    }
  }

  async webSocketClose(ws) {
    const room = await this.load();
    if (!room) return;
    const seat = this.seatOf(ws);
    const others = this.sockets().filter((s) => s !== ws);
    if (seat && !others.some((s) => s.deserializeAttachment()?.token === seat.token)) {
      seat.lastSeen = Date.now();
      this.pushLobby(); // shows the seat as away
      if (room.phase === "game") await this.afterChange();
    }
    if (others.length === 0) await this.maybeIdle();
    await this.save();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  // ---------- game flow ----------
  async startGame() {
    const room = this.room;
    room.state = E.createGame(E.randomSeed(), room.seats.length, { blindSpies: room.settings.blindSpies, hours: !!room.settings.hours });
    room.phase = "game"; room.gen++; room.stage = null; room.phaseKey = ""; room.log = []; room.hourSeen = 0;
    for (const s of room.seats) s.ready = false;
    this.pushLobby();
    this.broadcast({ type: "log", entries: [] });
    this.say(null, this.t("sys.dealt", { name: room.seats[room.state.leader].name }));
    await this.afterChange();
  }

  // Apply one action to the state. Bot actions also produce their table talk.
  applyAction(action, isBot) {
    const room = this.room;
    const before = room.state;
    const view = isBot ? E.view(before, action.seat) : null;
    room.state = E.apply(before, action);
    if (action.type === "propose") this.say(null, this.t("sys.proposed", { name: room.seats[action.seat].name, team: this.nameList(action.team) }));
    if (isBot && before.hour !== "silence") {
      const line = this.withRng((rng) => sayAction(action, view, this.talkCtx(rng)));
      if (line) this.say(action.seat, line);
    }
  }

  // Which seats the bot policy decides for right now: bots, and humans who
  // have been away longer than the grace period.
  botSeats(need) {
    const now = Date.now();
    return need.filter((i) => { const s = this.room.seats[i]; return s.ai || (!this.connected(s) && now - s.lastSeen > GRACE_MS); });
  }
  decideFor(seatIdx) {
    const room = this.room;
    return this.withRng((rng) => B.decide(E.view(room.state, seatIdx), room.settings.level, rng));
  }

  // After any change: pause on the events people need to see, keep the phase
  // clock, push views, and schedule whatever comes next.
  async afterChange() {
    const room = this.room, st = room.state;
    if (!st) return;
    const now = Date.now();
    const ev = st.event;
    if (ev && (ev.type === "voted" || ev.type === "mission") && !room.stage) {
      const until = now + STAGE_MS[ev.type];
      if (ev.type === "voted") {
        const outcome = ev.approved ? this.t("sys.approvedWord") : this.t("sys.rejectedWord");
        if (ev.dark) {
          this.say(null, this.t("hour.darkResult", { yes: ev.yes, no: st.n - ev.yes, outcome }));
        } else {
          const rejecters = ev.votes.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
          this.say(null, rejecters.length
            ? this.t("sys.voteResult", { yes: ev.yes, no: st.n - ev.yes, outcome, rejecters: this.nameList(rejecters) })
            : this.t("sys.voteResultNone", { yes: ev.yes, no: st.n - ev.yes, outcome }));
        }
        if (ev.over) this.say(null, this.t("sys.spiesWinRejects"), true);
        // The stage is sent to every socket as-is, so a Lights Out vote travels
        // without its per-seat votes until the game is over.
        room.stage = { kind: "voteResult", until, event: ev.dark && !ev.over ? { ...ev, votes: null } : ev };
      } else {
        const cards = ev.cards
          ? ev.cards.map((c) => ({ fail: !c.success, seat: c.seat }))
          : this.withRng((rng) => E.shuffle(rng, ev.team.map((_, i) => ({ fail: i < ev.fails }))));
        const fails = ev.fails === 0 ? this.t("table.noFails") : this.t(ev.fails === 1 ? "table.failsAmong" : "table.failsAmongPlural", { fails: ev.fails, n: ev.team.length });
        const outcome = ev.success ? this.t("table.missionSuccess").toLowerCase() : this.t("table.missionFailed").toLowerCase();
        this.say(null, this.t("sys.missionResult", { n: ev.mission + 1, outcome, fails }), !ev.success);
        if (ev.cards) {
          const failed = ev.cards.filter((c) => !c.success).map((c) => c.seat);
          this.say(null, failed.length ? this.t("hour.signedResult", { who: this.nameList(failed) }) : this.t("hour.signedClean"), failed.length > 0);
        }
        if (ev.hour === "orders" && ev.success) this.say(null, this.t("hour.ordersClean", { team: this.nameList(ev.team) }));
        room.stage = { kind: "missionResult", until, event: ev, cards };
        // A few bots react to the result, unless the round was silenced.
        const bots = ev.hour === "silence" ? [] : room.seats.filter((s) => s.ai).map((s) => s.idx);
        const speakers = this.withRng((rng) => E.shuffle(rng, bots)).slice(0, ev.success ? 2 : 3);
        for (const s of speakers) {
          const line = this.withRng((rng) => sayResult(E.view(st, s), s, this.talkCtx(rng)));
          if (line) this.say(s, line);
        }
      }
      room.deadline = 0;
      this.pushViews();
      await this.scheduleAt(until);
      return;
    }
    if (st.phase === "over") { await this.finish(); return; }

    if (st.hour && st.rounds.length !== room.hourSeen) {
      room.hourSeen = st.rounds.length;
      const wounded = st.wounded != null ? room.seats[st.wounded].name : "";
      this.say(null, this.t("hour.announce", { name: this.t("hour.names." + st.hour), desc: this.t("hour.desc." + st.hour, { name: wounded }) }), false, "hour");
    }

    // The phase clock restarts whenever the phase (or the proposal) changes.
    const key = `${st.phase}:${st.mission}:${st.rejects}:${st.proposal ? 1 : 0}`;
    if (key !== room.phaseKey) {
      room.phaseKey = key;
      room.deadline = now + PHASE_MS[st.phase];
      if (st.phase === "propose" && st.rejects === E.MAX_REJECTS - 1) this.say(null, this.t("sys.fifthWarning"), true);
    }
    this.pushViews();
    const need = E.mustAct(st);
    const bots = this.botSeats(need);
    await this.scheduleAt(bots.length ? Math.min(now + BOT_MS, room.deadline) : room.deadline);
  }

  // The alarm handler: end a stage, let a bot act, or enforce the clock.
  async pump() {
    const room = this.room, st = room.state;
    if (room.phase !== "game" || !st) return;
    const now = Date.now();
    if (room.stage) {
      if (now < room.stage.until - 50) { await this.scheduleAt(room.stage.until); return; }
      room.stage = null;
      st.event = null;   // consumed: otherwise afterChange would stage it again
      if (st.phase === "over") { await this.finish(); return; }
      room.phaseKey = ""; // the next phase's clock starts now, not when the stage began
      await this.afterChange();
      return;
    }
    const need = E.mustAct(st);
    if (!need.length) return;
    if (room.deadline && now >= room.deadline - 50) {
      // Time is up: the table decides for whoever has not acted.
      for (const i of need) {
        if (!E.mustAct(room.state).includes(i)) continue;
        const s = room.seats[i];
        if (!s.ai) this.say(null, this.t("sys.timeout", { name: s.name }));
        this.applyAction(this.decideFor(i), s.ai);
        if (room.state.event && room.state.event.type !== "proposed") break;
      }
      await this.afterChange();
      return;
    }
    const bots = this.botSeats(need);
    if (bots.length) {
      const i = this.withRng((rng) => bots[rng.int(bots.length)]);
      this.applyAction(this.decideFor(i), true);
      await this.afterChange();
      return;
    }
    await this.scheduleAt(room.deadline);
  }

  async finish() {
    const room = this.room;
    await this.clearAlarm();
    room.phase = "over"; room.deadline = 0; room.stage = null;
    this.say(null, this.t("sys.over", { side: room.state.winner === E.SPY ? this.t("roles.spySide") : this.t("roles.resistanceSide") }));
    this.pushLobby();
    this.pushViews();
    await this.maybeIdle();
  }
}
