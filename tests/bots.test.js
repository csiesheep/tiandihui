import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../public/shared/engine.js";
import * as B from "../public/shared/bots.js";
import { playGame, simulate } from "./sim.js";
import { sayAction } from "../public/shared/talk.js";
import en from "../public/i18n/en.js";

const { RESISTANCE, SPY } = E;
const ready = (st) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "ready", seat: s }); return st; };
const voteAll = (st, d) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "vote", seat: s, approve: d(s) }); return st; };
const playAll = (st, d) => { for (const s of st.proposal) st = E.apply(st, { type: "play", seat: s, success: d(s) }); return st; };
const propose = (st, team) => E.apply(st, { type: "propose", seat: st.leader, team });
const sum = (a) => a.reduce((x, y) => x + y, 0);

test("combos enumerates C(n,k) distinct sorted subsets", () => {
  assert.equal(B.combos([0, 1, 2, 3, 4], 2).length, 10);
  assert.equal(B.combos([...Array(10).keys()], 4).length, 210);
  assert.deepEqual(B.combos([0, 1, 2], 2), [[0, 1], [0, 2], [1, 2]]);
});

test("the prior is uniform, sums to one, and excludes the bot itself", () => {
  const st = ready(E.createGame(1, 7));
  const op = st.roles.indexOf(RESISTANCE);
  const sets = B.posterior(E.view(st, op), { knownClean: op });
  assert.equal(sets.length, 20); // C(6,3)
  assert.ok(Math.abs(sum(sets.map((h) => h.p)) - 1) < 1e-9);
  const m = B.marginals(sets, 7);
  assert.equal(m[op], 0);
  for (let s = 0; s < 7; s++) if (s !== op) assert.ok(Math.abs(m[s] - 0.5) < 1e-9);
  assert.ok(Math.abs(sum(m) - 3) < 1e-9, "marginals sum to the spy count");
});

test("a failed mission raises suspicion on its team and only its team", () => {
  let st = ready(E.createGame(3, 7));
  const spies = E.spiesOf(st);
  const op = st.roles.indexOf(RESISTANCE);
  const team = [spies[0], [...Array(7).keys()].find((s) => s !== op && !spies.includes(s))];
  st = playAll(voteAll(propose(st, team), () => true), (s) => s !== spies[0]);
  const m = B.suspicion(E.view(st, op), "hard");
  for (const s of team) for (let o = 0; o < 7; o++) if (!team.includes(o) && o !== op) assert.ok(m[s] > m[o], `seat ${s} should be more suspect than ${o}`);
  // Both team members are now certainly-possible spies: with one fail on a
  // two-seat team, no set can exclude both.
  const sets = B.posterior(E.view(st, op), { knownClean: op });
  for (const h of sets) if (h.p > 0) assert.ok(team.some((s) => h.set.includes(s)));
});

test("a mission with two fails makes both spies certain when the team has two seats... and rules out sets with fewer", () => {
  let st = ready(E.createGame(5, 8)); // 8 players, 3 spies, first team is 3 seats
  const spies = E.spiesOf(st);
  const op = st.roles.indexOf(RESISTANCE);
  const team = [spies[0], spies[1], [...Array(8).keys()].find((s) => s !== op && !spies.includes(s))];
  st = playAll(voteAll(propose(st, team), () => true), (s) => !spies.includes(s));
  const sets = B.posterior(E.view(st, op), { knownClean: op });
  for (const h of sets) if (h.p > 0) assert.ok(team.filter((s) => h.set.includes(s)).length >= 2);
});

test("pFail is 0 for a team the posterior knows is clean and 1 for a known-spy team", () => {
  const n = 5;
  const sets = [{ set: [1, 2], mask: B.maskOf([1, 2]), p: 1 }];
  assert.equal(B.pFail(sets, [0, 3], 1), 0);
  assert.equal(B.pFail(sets, [1, 3], 1), 1);
  assert.equal(B.pFail(sets, [1, 3], 2), 0);
  assert.equal(B.pFail(sets, [1, 2, 3], 2), 1);
  assert.equal(n, 5);
});

test("bots return null when it is not their turn, ready during reveal, and always a legal action", () => {
  for (let seed = 0; seed < 60; seed++) {
    const n = 5 + (seed % 6);
    const rng = E.makeRng(seed);
    let st = E.createGame(seed, n);
    let steps = 0;
    while (st.phase !== "over") {
      assert.ok(++steps < 2000);
      for (let s = 0; s < n; s++) {
        const a = B.decide(E.view(st, s), B.LEVELS[seed % 3], rng);
        if (!E.mustAct(st).includes(s)) { assert.equal(a, null); continue; }
        assert.ok(a, `seat ${s} must act in ${st.phase}`);
        assert.equal(a.seat, s);
        if (st.phase === "reveal") assert.equal(a.type, "ready");
        st = E.apply(st, a); // throws if illegal
        break;
      }
    }
  }
});

test("a resistance bot always approves the fifth proposal and a spy always rejects it", () => {
  let hits = 0;
  for (let seed = 0; seed < 40 && hits < 5; seed++) {
    let st = ready(E.createGame(seed, 6));
    for (let i = 0; i < 4; i++) st = voteAll(propose(st, [0, 1]), () => false);
    st = propose(st, [0, 1]);
    assert.equal(st.rejects, 4);
    for (let s = 0; s < 6; s++) {
      const a = B.decide(E.view(st, s), "normal", E.makeRng(seed));
      assert.equal(a.type, "vote");
      assert.equal(a.approve, st.roles[s] === RESISTANCE, `seat ${s} (${st.roles[s]})`);
      assert.equal(a.why.forced ?? true, true);
    }
    hits++;
  }
});

test("a resistance bot proposes a team that includes itself and never plays Fail", () => {
  for (let seed = 0; seed < 30; seed++) {
    const st = ready(E.createGame(seed, 7));
    if (st.roles[st.leader] !== RESISTANCE) continue;
    const a = B.decide(E.view(st, st.leader), "normal", E.makeRng(seed));
    assert.equal(a.type, "propose");
    assert.ok(a.team.includes(st.leader));
    assert.equal(a.team.length, 2);
  }
  const st = playGame(7, 7, "hard", "hard");
  assert.ok(st.phase === "over");
});

test("spies coordinate: exactly as many fails as needed when enough spies are on the team", () => {
  // 8 players, mission 4 needs two fails; put all three spies on a 5-seat team.
  let st = ready(E.createGame(2, 8));
  const spies = E.spiesOf(st);
  // Reach mission 4 with a 1-1 or 2-1 score: two successes then one fail.
  const ops = [...Array(8).keys()].filter((s) => !spies.includes(s));
  const clean = (k) => ops.slice(0, k);
  st = playAll(voteAll(propose(st, clean(3)), () => true), () => true);
  st = playAll(voteAll(propose(st, clean(4)), () => true), () => true);
  st = playAll(voteAll(propose(st, [spies[0], ...ops.slice(0, 3)]), () => true), (s) => s !== spies[0]);
  assert.equal(st.mission, 3);
  st = voteAll(propose(st, [...spies, ...ops.slice(0, 2)]), () => true);
  assert.equal(st.phase, "mission");
  let fails = 0;
  for (const s of st.proposal) {
    const a = B.decide(E.view(st, s), "hard", E.makeRng(1));
    if (!a.success) fails++;
    st = E.apply(st, a);
  }
  assert.equal(fails, 2);
  assert.equal(st.rounds[3].result.success, false);
});

test("a lone spy on a two-fail mission plays Success rather than burn its cover", () => {
  let st = ready(E.createGame(2, 8));
  const spies = E.spiesOf(st);
  const ops = [...Array(8).keys()].filter((s) => !spies.includes(s));
  st = playAll(voteAll(propose(st, ops.slice(0, 3)), () => true), () => true);
  st = playAll(voteAll(propose(st, ops.slice(0, 4)), () => true), () => true);
  st = playAll(voteAll(propose(st, [spies[0], ...ops.slice(0, 3)]), () => true), (s) => s !== spies[0]);
  st = voteAll(propose(st, [spies[0], ...ops.slice(0, 4)]), () => true);
  const a = B.decide(E.view(st, spies[0]), "hard", E.makeRng(1));
  assert.equal(a.type, "play");
  assert.equal(a.success, true);
});

test("a spy on the decisive mission always fails when it can", () => {
  for (let seed = 0; seed < 20; seed++) {
    let st = ready(E.createGame(seed, 5));
    const spies = E.spiesOf(st);
    const ops = [0, 1, 2, 3, 4].filter((s) => !spies.includes(s));
    // Two spy wins first, then a team with one spy on mission 3.
    st = playAll(voteAll(propose(st, [spies[0], ops[0]]), () => true), (s) => s !== spies[0]);
    st = playAll(voteAll(propose(st, [spies[0], ops[0], ops[1]]), () => true), (s) => s !== spies[0]);
    st = voteAll(propose(st, [spies[1], ops[2]]), () => true);
    assert.equal(st.phase, "mission");
    const a = B.decide(E.view(st, spies[1]), "normal", E.makeRng(seed));
    assert.equal(a.success, false);
  }
});

test("decisions are deterministic given view and rng state", () => {
  const st = ready(E.createGame(9, 9));
  const a = B.decide(E.view(st, st.leader), "normal", E.makeRng(5));
  const b = B.decide(E.view(st, st.leader), "normal", E.makeRng(5));
  assert.deepEqual(a, b);
});

test("bots at every level finish games without ever losing on the vote track more than a third of the time", () => {
  for (const n of [5, 7, 10]) {
    for (const lvl of B.LEVELS) {
      const o = simulate({ games: 60, n, resLevel: lvl, spyLevel: lvl, seed: 3 });
      assert.ok(o.byRejects / o.games < 0.34, `${lvl} at ${n} players lost ${o.byRejects} of ${o.games} on rejects`);
      assert.ok(o.resRate > 0.03 && o.resRate < 0.99, `${lvl} at ${n}: resistance won ${o.resRate}`);
    }
  }
});

// ---------- the Hour deck (天時) ----------
function openOn(n, card) {
  for (let seed = 0; seed < 5000; seed++) {
    const st = ready(E.createGame(seed, n, { hours: true }));
    if (st.hour === card) return st;
  }
  throw new Error(`no seed opens on ${card}`);
}

test("bots play whole legal games with the Hour deck at every level and player count", () => {
  for (let n = 5; n <= 10; n++) {
    for (const lvl of B.LEVELS) {
      for (let g = 0; g < 8; g++) assert.equal(playGame(n * 131 + g, n, lvl, lvl, { hours: true }).phase, "over");
    }
  }
});

test("under orders a spy bot plays Fail; on a signed round it plays Success unless that fail wins", () => {
  let st = openOn(7, "orders");
  let spy = E.spiesOf(st)[0], op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  for (const lvl of B.LEVELS) assert.equal(B.decide(E.view(st, spy), lvl, E.makeRng(1)).success, false);

  st = openOn(7, "signed");
  spy = E.spiesOf(st)[0]; op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  for (const lvl of B.LEVELS) assert.equal(B.decide(E.view(st, spy), lvl, E.makeRng(2)).success, true);
});

test("no bot proposes the seat that is laid up, and every proposal has the round's size", () => {
  let checked = 0;
  for (let seed = 0; seed < 3000 && checked < 40; seed++) {
    const st = ready(E.createGame(seed, 7, { hours: true }));
    if (st.hour !== "wounded") continue;
    for (const lvl of B.LEVELS) {
      const a = B.decide(E.view(st, st.leader), lvl, E.makeRng(seed));
      assert.equal(a.team.includes(st.wounded), false);
      assert.equal(a.team.length, E.roundTeamSize(st));
    }
    checked++;
  }
  assert.ok(checked > 10);
});

test("a recused leader bot keeps itself off, and every proposal has the round's size", () => {
  let checked = 0;
  for (let seed = 0; seed < 4000 && checked < 30; seed++) {
    const st = ready(E.createGame(seed, 8, { hours: true }));
    if (st.hour !== "recused") continue;
    for (const lvl of B.LEVELS) {
      const a = B.decide(E.view(st, st.leader), lvl, E.makeRng(seed));
      assert.equal(a.team.includes(st.leader), false);
      assert.equal(a.team.length, E.roundTeamSize(st));
    }
    checked++;
  }
  assert.ok(checked > 10);
});

test("in the dark a spy bot votes its real interest, and no bot says how it voted", () => {
  const st = openOn(7, "dark");
  const spies = E.spiesOf(st);
  const spy = spies.find((s) => s !== st.leader);
  const ops = [0, 1, 2, 3, 4, 5, 6].filter((s) => !spies.includes(s));
  const withSpy = propose(st, [spy, ops[0]]);
  const clean = propose(st, [ops[0], ops[1]]);
  assert.equal(B.decide(E.view(withSpy, spy), "hard", E.makeRng(1)).approve, true);
  assert.equal(B.decide(E.view(clean, spy), "hard", E.makeRng(1)).approve, false);
  const ctx = { rng: E.makeRng(3), names: en.names.slice(0, 7), T: en.talk, sep: ", ", and: " and " };
  for (let seat = 0; seat < 7; seat++) {
    const view = E.view(withSpy, seat);
    const a = B.decide(view, "normal", E.makeRng(seat));
    assert.equal(a.type, "vote");
    assert.equal(sayAction(a, view, ctx), null);
  }
});
