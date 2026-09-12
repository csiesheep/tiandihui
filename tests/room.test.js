// The room Durable Object, run over a fake context. Every socket records what
// it is sent, so these tests check what actually leaves the room, which is
// the one thing that has to be right for hidden information to stay hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../public/shared/engine.js";
import { Room } from "../src/room.js";

function fakeRoom(state) {
  const sent = [];
  const sockets = [...Array(state.n).keys()].map((i) => ({
    token: `t${i}`,
    send(msg) { sent.push({ to: i, msg: JSON.parse(msg) }); },
    deserializeAttachment() { return { token: `t${i}` }; },
    close() {},
  }));
  const ctx = {
    storage: { async get() { return null; }, async put() {}, async setAlarm() {}, async deleteAlarm() {}, async deleteAll() {} },
    getWebSockets(tag) { return tag ? sockets.filter((s) => s.token === tag) : sockets; },
  };
  const room = new Room(ctx, {});
  room.room = {
    code: "TEST", phase: "game",
    seats: sockets.map((s, i) => ({ idx: i, name: `P${i}`, token: s.token, ready: false, ai: false, lastSeen: Date.now() })),
    settings: { level: "normal", blindSpies: false, hours: true, lang: "en" },
    state, rngState: 1, gen: 1, deadline: 0, phaseKey: "", stage: null, log: [], alarmAt: 0, idle: false,
    lastActive: Date.now(), hourSeen: state.rounds.length,
  };
  return { room, sockets, sent };
}

const ready = (st) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "ready", seat: s }); return st; };
const voteAll = (st, d) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "vote", seat: s, approve: d(s) }); return st; };
const propose = (st, team) => E.apply(st, { type: "propose", seat: st.leader, team });
function openOn(n, card) {
  for (let seed = 0; seed < 5000; seed++) {
    const st = ready(E.createGame(seed, n, { hours: true }));
    if (st.hour === card) return st;
  }
  throw new Error(`no seed opens on ${card}`);
}
// Every per-seat vote array anywhere inside a message.
function voteArrays(x, out = []) {
  if (Array.isArray(x)) x.forEach((y) => voteArrays(y, out));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      if (k === "votes" && Array.isArray(v)) out.push(v);
      else voteArrays(v, out);
    }
  }
  return out;
}

test("room: under Lights Out no socket is sent anyone's vote, only the tally", async () => {
  const st = voteAll(propose(openOn(5, "dark"), [0, 1]), (s) => s < 2);
  const { room, sent } = fakeRoom(st);
  await room.afterChange();
  const views = sent.filter((m) => m.msg.type === "view");
  assert.equal(views.length, 5, "every seat got its view");
  for (const { msg } of sent) assert.deepEqual(voteArrays(msg), [], `a ${msg.type} message carried votes`);
  assert.equal(views[0].msg.stage.kind, "voteResult");
  assert.equal(views[0].msg.stage.event.yes, 2);
  assert.ok(sent.some((m) => m.msg.type === "say" && m.msg.text === "Lights out: 2–3, rejected."));
});

test("room: in an ordinary round the votes do go out, so the test above would catch a leak", async () => {
  const st = voteAll(propose(openOn(5, "quiet"), [0, 1]), (s) => s < 2);
  const { room, sent } = fakeRoom(st);
  await room.afterChange();
  assert.ok(sent.some(({ msg }) => voteArrays(msg).length > 0));
});

test("room: Hold Your Tongue refuses chat for the round; an ordinary round lets it through", async () => {
  for (const [card, delivered] of [["silence", false], ["quiet", true]]) {
    const { room, sockets, sent } = fakeRoom(openOn(5, card));
    await room.webSocketMessage(sockets[2], JSON.stringify({ type: "chat", text: "it was not me" }));
    assert.equal(sent.some((m) => m.msg.type === "say" && m.msg.text === "it was not me"), delivered, card);
  }
});
