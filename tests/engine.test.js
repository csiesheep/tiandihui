import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../public/shared/engine.js";

const { RESISTANCE, SPY } = E;

// ---------- helpers ----------
const ready = (st) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "ready", seat: s }); return st; };
const voteAll = (st, decide) => { for (let s = 0; s < st.n; s++) st = E.apply(st, { type: "vote", seat: s, approve: decide(s) }); return st; };
const playAll = (st, decide) => { for (const s of st.proposal) st = E.apply(st, { type: "play", seat: s, success: decide(s) }); return st; };
const firstSeats = (st, k) => [...Array(st.n).keys()].slice(0, k);
const propose = (st, team) => E.apply(st, { type: "propose", seat: st.leader, team });
// A game where the leader always proposes the first k seats and everyone approves.
const start = (n, seed = 1, opts) => ready(E.createGame(seed, n, opts));
const runMission = (st, decide) => {
  st = propose(st, firstSeats(st, E.teamSize(st.n, st.mission)));
  st = voteAll(st, () => true);
  return playAll(st, decide);
};

// ---------- tables ----------
test("tables cover 5-10 players with five missions each", () => {
  for (let n = 5; n <= 10; n++) {
    assert.equal(E.TEAM[n].length, 5);
    assert.ok(E.SPIES[n] >= 2 && E.SPIES[n] <= 4);
    for (const size of E.TEAM[n]) assert.ok(size >= 2 && size <= 5 && size < n);
  }
  assert.deepEqual(E.TEAM[5], [2, 3, 2, 3, 3]);
  assert.deepEqual(E.TEAM[7], [2, 3, 3, 4, 4]);
  assert.deepEqual(E.TEAM[10], [3, 4, 4, 5, 5]);
});

test("the 4th mission needs two fails only at 7 or more players", () => {
  for (let n = 5; n <= 10; n++) {
    for (let m = 0; m < 5; m++) {
      assert.equal(E.failsNeeded(n, m), n >= 7 && m === 3 ? 2 : 1, `n=${n} m=${m}`);
    }
  }
});

// ---------- setup ----------
test("deals the right number of spies for every player count", () => {
  for (let n = 5; n <= 10; n++) {
    for (let seed = 0; seed < 20; seed++) {
      const st = E.createGame(seed, n);
      assert.equal(st.roles.length, n);
      assert.equal(E.spiesOf(st).length, E.SPIES[n]);
      assert.ok(st.leader >= 0 && st.leader < n);
      assert.equal(st.phase, "reveal");
    }
  }
});

test("rejects player counts outside 5-10", () => {
  assert.throws(() => E.createGame(1, 4));
  assert.throws(() => E.createGame(1, 11));
  assert.throws(() => E.createGame(1, 7.5));
});

test("same seed deals the same game; different seeds differ", () => {
  const a = E.createGame(42, 8), b = E.createGame(42, 8), c = E.createGame(43, 8);
  assert.deepEqual(a.roles, b.roles);
  assert.equal(a.leader, b.leader);
  const same = a.roles.every((r, i) => r === c.roles[i]) && a.leader === c.leader;
  assert.equal(same, false);
});

test("over 200 seeds every seat is a spy roughly SPIES/n of the time", () => {
  const n = 7, counts = new Array(n).fill(0), N = 400;
  for (let seed = 0; seed < N; seed++) for (const s of E.spiesOf(E.createGame(seed, n))) counts[s]++;
  for (const c of counts) assert.ok(Math.abs(c / N - 3 / 7) < 0.1, `seat spy rate ${c / N}`);
});

// ---------- reveal ----------
test("reveal ends when every seat is ready and opens the first round", () => {
  let st = E.createGame(1, 5);
  for (let s = 0; s < 4; s++) { st = E.apply(st, { type: "ready", seat: s }); assert.equal(st.phase, "reveal"); }
  st = E.apply(st, { type: "ready", seat: 4 });
  assert.equal(st.phase, "propose");
  assert.equal(st.rounds.length, 1);
  assert.equal(st.mission, 0);
  assert.equal(st.rejects, 0);
});

test("nothing but ready is legal during reveal", () => {
  const st = E.createGame(1, 5);
  assert.throws(() => propose(st, [0, 1]), /cannot propose during reveal/);
  assert.throws(() => E.apply(st, { type: "vote", seat: 0, approve: true }), /cannot vote/);
});

// ---------- propose ----------
test("only the leader proposes, with exactly the table's team size, no duplicates", () => {
  const st = start(7);
  const other = (st.leader + 1) % 7;
  assert.throws(() => E.apply(st, { type: "propose", seat: other, team: [0, 1] }), /not the leader/);
  assert.throws(() => propose(st, [0]), /team must have 2/);
  assert.throws(() => propose(st, [0, 1, 2]), /team must have 2/);
  assert.throws(() => propose(st, [1, 1]), /duplicate/);
  assert.throws(() => propose(st, [0, 9]), /bad seat/);
  const ok = propose(st, [3, 0]);
  assert.equal(ok.phase, "vote");
  assert.deepEqual(ok.proposal, [0, 3]);
  assert.deepEqual(ok.event, { type: "proposed", leader: st.leader, team: [0, 3] });
});

test("apply never mutates its input", () => {
  const st = start(5);
  const frozen = JSON.stringify(st);
  propose(st, [0, 1]);
  assert.equal(JSON.stringify(st), frozen);
});

// ---------- vote ----------
test("a majority approves; a tie rejects and passes the leader clockwise", () => {
  let st = propose(start(6), [0, 1]);
  const leader = st.leader;
  st = voteAll(st, (s) => s < 3); // 3-3
  assert.equal(st.phase, "propose");
  assert.equal(st.rejects, 1);
  assert.equal(st.leader, (leader + 1) % 6);
  assert.equal(st.proposal, null);
  const p = st.rounds[0].proposals[0];
  assert.equal(p.approved, false);
  assert.deepEqual(p.votes, [true, true, true, false, false, false]);
  assert.equal(p.leader, leader);

  st = propose(st, [2, 3]);
  st = voteAll(st, (s) => s < 4); // 4-2
  assert.equal(st.phase, "mission");
  assert.deepEqual(st.proposal, [2, 3]);
  assert.equal(st.rounds[0].proposals.length, 2);
  assert.equal(st.event.type, "voted");
  assert.equal(st.event.approved, true);
  assert.equal(st.event.yes, 4);
});

test("each seat votes once, with a boolean", () => {
  let st = propose(start(5), [0, 1]);
  st = E.apply(st, { type: "vote", seat: 2, approve: true });
  assert.throws(() => E.apply(st, { type: "vote", seat: 2, approve: false }), /already voted/);
  assert.throws(() => E.apply(st, { type: "vote", seat: 3, approve: "yes" }), /true or false/);
  assert.equal(st.phase, "vote");
});

test("five rejected teams in one round hands the game to the spies", () => {
  let st = start(5);
  for (let i = 0; i < 4; i++) {
    st = voteAll(propose(st, [0, 1]), () => false);
    assert.equal(st.phase, "propose");
    assert.equal(st.rejects, i + 1);
  }
  st = voteAll(propose(st, [0, 1]), () => false);
  assert.equal(st.phase, "over");
  assert.equal(st.winner, SPY);
  assert.equal(st.reason, "rejects");
  assert.equal(st.rounds[0].proposals.length, 5);
  assert.equal(st.event.over, true);
});

test("the vote track resets after a mission", () => {
  let st = start(5);
  st = voteAll(propose(st, [0, 1]), () => false);
  assert.equal(st.rejects, 1);
  st = runMission(st, () => true);
  assert.equal(st.rejects, 0);
  assert.equal(st.mission, 1);
});

// ---------- mission ----------
test("only team members play, once, and operatives cannot play Fail", () => {
  let st = start(5, 3);
  const spy = E.spiesOf(st)[0];
  const op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  const outsider = [0, 1, 2, 3, 4].find((s) => s !== spy && s !== op);
  assert.throws(() => E.apply(st, { type: "play", seat: outsider, success: true }), /not on the mission/);
  assert.throws(() => E.apply(st, { type: "play", seat: op, success: false }), /operatives must play Success/);
  st = E.apply(st, { type: "play", seat: op, success: true });
  assert.throws(() => E.apply(st, { type: "play", seat: op, success: true }), /already played/);
  assert.equal(st.phase, "mission");
  st = E.apply(st, { type: "play", seat: spy, success: false });
  assert.equal(st.phase, "propose");
  assert.equal(st.mission, 1);
  assert.deepEqual(st.rounds[0].result, { team: [spy, op].sort(), fails: 1, need: 1, success: false });
  assert.equal(st.score[SPY], 1);
  assert.equal(st.played, null);
});

test("one fail sinks a mission; the 4th mission at 7+ survives one fail and sinks on two", () => {
  // A 7-player game: reach mission 4 with 2 wins and 1 loss so nobody has won.
  let st = start(7, 5);
  const spies = E.spiesOf(st);
  const decideOneFail = (s) => s !== spies[0];
  st = runMission(st, () => true);           // m1 ok
  st = runMission(st, () => true);           // m2 ok
  st = runMission(st, decideOneFail);        // m3: one fail (if a spy is on it)
  // Whether m3 failed depends on seating; force the state we need.
  assert.equal(st.mission, 3);
  assert.equal(st.phase, "propose");
  const before = { ...st.score };
  const team = [spies[0], ...[0, 1, 2, 3, 4, 5, 6].filter((s) => !spies.includes(s))].slice(0, 4);
  st = propose(st, team);
  st = voteAll(st, () => true);
  st = playAll(st, (s) => s !== spies[0]);
  assert.equal(st.rounds[3].result.fails, 1);
  assert.equal(st.rounds[3].result.need, 2);
  assert.equal(st.rounds[3].result.success, true);
  assert.equal(st.score[RESISTANCE], before[RESISTANCE] + 1);

  // Same spot, two spies on the team and both fail: it sinks.
  let st2 = start(7, 5);
  st2 = runMission(st2, () => true);
  st2 = runMission(st2, () => true);
  st2 = runMission(st2, decideOneFail);
  const team2 = [spies[0], spies[1], ...[0, 1, 2, 3, 4, 5, 6].filter((s) => !spies.includes(s))].slice(0, 4);
  st2 = voteAll(propose(st2, team2), () => true);
  st2 = playAll(st2, (s) => !spies.includes(s));
  assert.equal(st2.rounds[3].result.fails, 2);
  assert.equal(st2.rounds[3].result.success, false);
});

test("the 4th mission at 5-6 players sinks on one fail", () => {
  let st = start(6, 2);
  const spies = E.spiesOf(st);
  st = runMission(st, () => true);
  st = runMission(st, () => true);
  st = runMission(st, (s) => !spies.includes(s)); // ensure not 3-0 yet? first team is seats 0..3
  if (st.phase === "over") return; // 3 straight successes if no spy sat in 0..3; covered elsewhere
  const team = [spies[0], ...[0, 1, 2, 3, 4, 5].filter((s) => !spies.includes(s))].slice(0, 3);
  st = playAll(voteAll(propose(st, team), () => true), (s) => s !== spies[0]);
  assert.equal(st.rounds[3].result.need, 1);
  assert.equal(st.rounds[3].result.success, false);
});

test("three successes end the game for the resistance, three fails for the spies", () => {
  let st = start(5, 11);
  st = runMission(st, () => true);
  st = runMission(st, () => true);
  assert.equal(st.phase, "propose");
  st = runMission(st, () => true);
  assert.equal(st.phase, "over");
  assert.equal(st.winner, RESISTANCE);
  assert.equal(st.reason, "missions");
  assert.deepEqual(st.score, { resistance: 3, spy: 0 });
  assert.throws(() => propose(st, [0, 1]), /cannot propose during over/);

  let st2 = start(5, 11);
  const spy = E.spiesOf(st2)[0];
  for (let i = 0; i < 3; i++) {
    const size = E.teamSize(5, st2.mission);
    const team = [spy, ...[0, 1, 2, 3, 4].filter((s) => s !== spy)].slice(0, size);
    st2 = playAll(voteAll(propose(st2, team), () => true), (s) => s !== spy);
  }
  assert.equal(st2.winner, SPY);
  assert.equal(st2.reason, "missions");
  assert.equal(st2.rounds.length, 3);
});

test("the leader token moves clockwise after a mission too", () => {
  let st = start(5, 1);
  const leader = st.leader;
  st = runMission(st, () => true);
  assert.equal(st.leader, (leader + 1) % 5);
});

// ---------- mustAct ----------
test("mustAct names exactly who is holding things up", () => {
  let st = E.createGame(1, 5);
  assert.deepEqual(E.mustAct(st), [0, 1, 2, 3, 4]);
  st = ready(st);
  assert.deepEqual(E.mustAct(st), [st.leader]);
  st = propose(st, [1, 2]);
  st = E.apply(st, { type: "vote", seat: 0, approve: true });
  assert.deepEqual(E.mustAct(st), [1, 2, 3, 4]);
  for (let s = 1; s < 5; s++) st = E.apply(st, { type: "vote", seat: s, approve: true });
  assert.deepEqual(E.mustAct(st), [1, 2]);
  st = E.apply(st, { type: "play", seat: 2, success: true });
  assert.deepEqual(E.mustAct(st), [1]);
});

// ---------- view: what each seat may see ----------
test("an operative sees their own role and nobody else's; a spy sees the spies", () => {
  const st = start(7, 9);
  const spies = E.spiesOf(st);
  for (let s = 0; s < 7; s++) {
    const v = E.view(st, s);
    assert.equal(v.role, st.roles[s]);
    assert.equal(v.roles, null);
    assert.equal(v.seat, s);
    if (st.roles[s] === SPY) assert.deepEqual(v.spies, spies);
    else assert.equal(v.spies, null);
  }
  const spec = E.view(st, null);
  assert.equal(spec.role, null);
  assert.equal(spec.spies, null);
});

test("blind spies do not see each other", () => {
  const st = start(7, 9, { blindSpies: true });
  const spy = E.spiesOf(st)[0];
  assert.equal(E.view(st, spy).spies, null);
  assert.equal(E.view(st, spy).role, SPY);
});

test("votes are hidden while voting, public once resolved", () => {
  let st = propose(start(5, 4), [0, 1]);
  st = E.apply(st, { type: "vote", seat: 3, approve: false });
  const v = E.view(st, 0);
  assert.deepEqual(v.voted, [false, false, false, true, false]);
  assert.equal(v.myVote, null);
  assert.equal(E.view(st, 3).myVote, false);
  assert.equal(JSON.stringify(v).includes('"votes"'), false, "no raw votes in a view mid-vote");
  for (const s of [0, 1, 2, 4]) st = E.apply(st, { type: "vote", seat: s, approve: true });
  const after = E.view(st, 2);
  assert.equal(after.voted, null);
  assert.deepEqual(after.rounds[0].proposals[0].votes, [true, true, true, false, true]);
});

test("mission cards are never in a view; only who has played, and the fail count afterwards", () => {
  let st = start(5, 3);
  const spy = E.spiesOf(st)[0];
  const op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  st = E.apply(st, { type: "play", seat: spy, success: false });
  const team = [spy, op].sort((a, b) => a - b);
  const v = E.view(st, op);
  assert.deepEqual(v.played, team.map((s) => s === spy));
  assert.equal(v.myCard, null);
  assert.equal(E.view(st, spy).myCard, false);
  assert.equal(JSON.stringify(E.view(st, op)).includes('"played":[false') || JSON.stringify(E.view(st, op)).includes('"played":[true'), true);
  assert.equal("roles" in v && v.roles === null, true);
  st = E.apply(st, { type: "play", seat: op, success: true });
  const after = E.view(st, op);
  assert.equal(after.played, null);
  assert.deepEqual(after.rounds[0].result, { team, fails: 1, need: 1, success: false });
  // The full state knows who played what only transiently; after resolution it is gone.
  assert.equal(st.played, null);
});

test("a view never carries the roles array or the rng until the game is over", () => {
  let st = start(6, 8);
  for (let s = 0; s < 6; s++) {
    const json = JSON.stringify(E.view(st, s));
    assert.equal(json.includes("rngState"), false);
    assert.equal(json.includes("seed"), false);
    assert.equal(/"roles":\[/.test(json), false);
  }
  st = runMission(st, () => true); st = runMission(st, () => true); st = runMission(st, () => true);
  if (st.phase === "over") {
    const v = E.view(st, 0);
    assert.deepEqual(v.roles, st.roles);
    assert.deepEqual(v.spies, E.spiesOf(st));
    assert.deepEqual(E.view(st, null).roles, st.roles);
  }
});

test("view reports the table for the current mission", () => {
  const st = start(8, 1);
  const v = E.view(st, 0);
  assert.equal(v.teamSize, 3);
  assert.equal(v.failsNeeded, 1);
  assert.deepEqual(v.sizes, [3, 4, 4, 5, 5]);
  assert.deepEqual(v.waitingOn, [st.leader]);
});

// ---------- fuzz: random legal games always terminate consistently ----------
test("500 random legal games per player count end with a consistent verdict", () => {
  for (let n = 5; n <= 10; n++) {
    for (let g = 0; g < 500; g++) {
      const rng = E.makeRng(n * 1000 + g);
      let st = E.createGame(rng.int(1e9), n);
      let steps = 0;
      while (st.phase !== "over") {
        assert.ok(++steps < 2000, "game did not terminate");
        const who = E.mustAct(st);
        assert.ok(who.length > 0, `nobody to act in ${st.phase}`);
        const seat = who[rng.int(who.length)];
        switch (st.phase) {
          case "reveal": st = E.apply(st, { type: "ready", seat }); break;
          case "propose": st = E.apply(st, { type: "propose", seat, team: E.shuffle(rng, [...Array(n).keys()]).slice(0, E.teamSize(n, st.mission)) }); break;
          case "vote": st = E.apply(st, { type: "vote", seat, approve: rng.next() < 0.6 }); break;
          case "mission": st = E.apply(st, { type: "play", seat, success: st.roles[seat] === RESISTANCE || rng.next() < 0.5 }); break;
        }
      }
      if (st.reason === "rejects") {
        assert.equal(st.winner, SPY);
        assert.equal(st.rejects, 5);
        assert.equal(E.currentRound(st).proposals.length, 5);
      } else {
        assert.equal(st.reason, "missions");
        assert.equal(st.score[st.winner], 3);
        assert.ok(st.score[st.winner === SPY ? RESISTANCE : SPY] < 3);
        const results = st.rounds.map((r) => r.result).filter(Boolean);
        assert.equal(results.filter((r) => r.success).length, st.score[RESISTANCE]);
        assert.equal(results.filter((r) => !r.success).length, st.score[SPY]);
        for (const r of results) assert.equal(r.success, r.fails < r.need);
      }
      // The public history never shows a mission card by seat.
      for (const r of st.rounds) if (r.result) assert.equal("played" in r.result, false);
    }
  }
});

// ---------- the Hour deck (天時) ----------
const hourGame = (n, seed = 1) => ready(E.createGame(seed, n, { hours: true }));
// The first seed whose opening round draws this card.
function seedFor(n, card) {
  for (let seed = 0; seed < 5000; seed++) if (hourGame(n, seed).hour === card) return seed;
  throw new Error(`no seed opens on ${card} at ${n} players`);
}
// A random legal action for whoever must act, respecting the Hour.
function legalMove(st, rng) {
  const who = E.mustAct(st);
  const seat = who[rng.int(who.length)];
  switch (st.phase) {
    case "reveal": return { type: "ready", seat };
    case "propose": {
      const pool = [...Array(st.n).keys()].filter((s) => s !== st.wounded);
      return { type: "propose", seat, team: E.shuffle(rng, pool).slice(0, E.roundTeamSize(st)) };
    }
    case "vote": return { type: "vote", seat, approve: rng.next() < 0.7 };
    default: {
      const spy = st.roles[seat] === SPY;
      return { type: "play", seat, success: !spy || (st.hour !== "orders" && rng.next() < 0.5) };
    }
  }
}

test("the Hour deck is off unless asked for", () => {
  const st = start(7, 3);
  assert.equal(st.hour, null);
  assert.deepEqual(st.hourDeck, []);
  assert.equal("hour" in st.rounds[0], false);
  assert.equal(E.view(st, 0).hour, null);
});

test("the Hour: one card a round, never repeated, only where allowed, always obeyed", () => {
  for (let n = 5; n <= 10; n++) {
    for (let g = 0; g < 150; g++) {
      const rng = E.makeRng(n * 7919 + g);
      let st = E.createGame(rng.int(1e9), n, { hours: true });
      const drawn = [];
      let steps = 0;
      while (st.phase !== "over") {
        assert.ok(++steps < 3000, "game did not terminate");
        const before = st;
        st = E.apply(st, legalMove(st, rng));
        if (st.phase !== "over" && st.rounds.length !== before.rounds.length) {
          const r = E.currentRound(st);
          assert.ok(E.HOURS.includes(st.hour), `drew ${st.hour}`);
          assert.equal(r.hour, st.hour);
          assert.ok(!drawn.includes(st.hour), `${st.hour} drawn twice`);
          drawn.push(st.hour);
          assert.equal(st.hourDeck.length, E.HOURS.length - drawn.length);
          assert.ok(E.hourAllowed(n, st.mission, st.hour), `${st.hour} not allowed on mission ${st.mission + 1} at ${n}`);
          assert.equal(st.wounded === null, st.hour !== "wounded");
          assert.equal(E.roundTeamSize(st), E.teamSize(n, st.mission) - (st.hour === "light" ? 1 : 0));
        }
      }
      for (const r of st.rounds) {
        for (const p of r.proposals) {
          assert.equal(p.team.length, E.teamSize(n, r.mission) - (r.hour === "light" ? 1 : 0));
          if (r.wounded != null) assert.ok(!p.team.includes(r.wounded), "a laid-up seat was proposed");
        }
        if (!r.result) continue;
        const spiesOn = r.result.team.filter((s) => st.roles[s] === SPY).length;
        if (r.hour === "orders") assert.equal(r.result.fails, spiesOn, "under orders every informer fails");
        if (r.hour === "signed") {
          assert.deepEqual(r.result.cards.map((c) => c.seat), r.result.team);
          assert.equal(r.result.cards.filter((c) => !c.success).length, r.result.fails);
          for (const c of r.result.cards) if (!c.success) assert.equal(st.roles[c.seat], SPY);
        } else {
          assert.equal("cards" in r.result, false, "only a signed round names cards");
        }
      }
    }
  }
});

test("Travel Light takes one off the team and is never drawn for a two-seat team", () => {
  let st = hourGame(8, seedFor(8, "light")); // mission 1 at 8 players is three seats
  assert.equal(E.roundTeamSize(st), 2);
  assert.equal(E.view(st, 0).teamSize, 2);
  assert.throws(() => propose(st, [0, 1, 2]), /team must have 2/);
  st = propose(st, [0, 1]);
  assert.equal(st.phase, "vote");
  // Mission 1 at five players is two seats: Travel Light cannot open a game there.
  for (let seed = 0; seed < 400; seed++) assert.notEqual(hourGame(5, seed).hour, "light");
});

test("Laid Up keeps one seat off every proposal this round, and never falls on mission 5", () => {
  let st = hourGame(7, seedFor(7, "wounded"));
  const hurt = st.wounded;
  assert.ok(Number.isInteger(hurt) && hurt >= 0 && hurt < 7);
  const others = [0, 1, 2, 3, 4, 5, 6].filter((s) => s !== hurt);
  assert.throws(() => propose(st, [hurt, others[0]]), /laid up/);
  st = voteAll(propose(st, others.slice(0, 2)), () => false); // rejected: same round, still laid up
  assert.equal(st.wounded, hurt);
  assert.throws(() => propose(st, [hurt, others[1]]), /laid up/);
  assert.equal(E.hourAllowed(7, 4, "wounded"), false);
  assert.equal(E.hourAllowed(7, 3, "wounded"), true);
});

test("Orders from Above: an informer on the team cannot play Success", () => {
  let st = hourGame(7, seedFor(7, "orders"));
  const spy = E.spiesOf(st)[0];
  const op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  assert.throws(() => E.apply(st, { type: "play", seat: spy, success: true }), /must play Fail/);
  st = E.apply(st, { type: "play", seat: op, success: true });
  st = E.apply(st, { type: "play", seat: spy, success: false });
  assert.equal(st.rounds[0].result.success, false);
  assert.equal(st.event.type, "mission");
  assert.equal(st.event.hour, "orders");
});

test("Signed: the result names who played what, in every seat's view, only once all cards are in", () => {
  let st = hourGame(7, seedFor(7, "signed"));
  const spy = E.spiesOf(st)[0];
  const op = st.roles.indexOf(RESISTANCE);
  st = voteAll(propose(st, [spy, op]), () => true);
  st = E.apply(st, { type: "play", seat: spy, success: false });
  assert.equal(E.view(st, op).rounds[0].result, null);
  assert.equal(E.view(st, op).myCard, null);
  st = E.apply(st, { type: "play", seat: op, success: true });
  const expect = [spy, op].sort((a, b) => a - b).map((s) => ({ seat: s, success: s !== spy }));
  for (let s = 0; s < 7; s++) assert.deepEqual(E.view(st, s).rounds[0].result.cards, expect);
  assert.deepEqual(st.event.cards, expect);
});

test("the Hour is public in every view; the deck list is sorted and the rng stays private", () => {
  const st = hourGame(9, 4);
  for (let s = 0; s < 9; s++) {
    const v = E.view(st, s);
    assert.equal(v.hour, st.hour);
    assert.equal(v.wounded, st.wounded);
    assert.deepEqual(v.hourDeck, E.HOURS.filter((c) => st.hourDeck.includes(c)));
    assert.equal(v.options.hours, true);
    assert.equal(JSON.stringify(v).includes("rngState"), false);
  }
});

test("the Hour replays: the same seed and actions draw the same cards", () => {
  const run = () => {
    const rng = E.makeRng(99);
    let st = E.createGame(1234, 8, { hours: true });
    while (st.phase !== "over") st = E.apply(st, legalMove(st, rng));
    return st.rounds.map((r) => [r.hour, r.wounded]);
  };
  assert.deepEqual(run(), run());
});
