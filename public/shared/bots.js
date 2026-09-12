// The AI seats. A bot decides from a `view` (engine.view) and nothing else, so
// it can only know what a human in that seat would know: its own role, the
// other spies if it is one, and the public history. Bots keep no memory; the
// posterior is recomputed from the history at every decision, which keeps
// them stateless (a room can be restored from storage and the bots just
// carry on) and deterministic given the rng.
//
// Model: there are at most C(10,4) = 210 possible spy sets. A resistance bot
// keeps a posterior over them, starting uniform, minus the sets that contain
// itself. Mission results are near-hard evidence (f fails means at least f
// spies on that team); votes are soft evidence (spies tend to approve teams
// that carry a spy and reject clean ones). Everything the bot does derives
// from the marginal P(spy) per seat and P(fail) per candidate team.
//
// The Hour deck feeds the same model: a signed result names the seats that
// failed outright, and a result under orders gives the exact number of spies
// on the team, because none of them could play Success. Under Lights Out the
// votes are simply not there to read, and a recused leader is one more seat
// nobody may pick.
//
// Every decision also carries a `why`, so the table-talk module can say
// something true about it.

import * as E from "./engine.js";

const { RESISTANCE, SPY } = E;

export const LEVELS = ["easy", "normal", "hard"];

// Per-level knobs. `noise` is the chance a decision is taken at random
// instead of from the model; `voteWeight` scales how much voting patterns
// count (0 = ignored); `slack` is how much worse than the best available
// team a proposal may be and still get a resistance approve; `spyCover` is
// how often a spy lets a cheap-to-blame mission (two seats, or mission 1)
// through when the score allows; `spyMimic` is how often a spy
// votes the way an operative in its seat would, instead of by its own
// interest (the rulebook's advice: act like the resistance); `fog` is how
// much weight the operatives keep on a spy set the mission results have
// ruled out — 0 is exact inference, more is the human habit of forgiving a
// seat that was on a failed mission.
//
// Tuned with tests/sim.js (300 games per cell, bots on both sides), resistance
// win rate at 5..10 players:
//   easy    34 37 21 13 25 10   spies blunder (eager fails, tell-tale votes),
//                               operatives are foggy and ignore votes
//   normal  53 66 42 38 31 38   the target band: close to the real game's feel
//   hard    55 95 48 41 39 48   near-exact operatives; six players is theirs
// Across levels: hard spies vs normal operatives 44 72 35 32 32 31; hard
// operatives vs normal spies 80 78 86 82 63 89.
export const LEVEL = {
  easy:   { noise: 0.25, voteWeight: 0.0, slack: 0.30, spyCover: 0.3, spyMimic: 0.0, fog: 0.40 },
  normal: { noise: 0.08, voteWeight: 0.5, slack: 0.15, spyCover: 0.8, spyMimic: 0.5, fog: 0.45 },
  hard:   { noise: 0.0,  voteWeight: 1.0, slack: 0.09, spyCover: 0.8, spyMimic: 1.0, fog: 0.12 },
};

// How likely a spy on a team is to play Fail, by mission — used only inside
// the likelihood of a result. Spies often let mission 1 through.
const SPY_FAIL_RATE = [0.6, 0.85, 0.9, 0.9, 0.95];

// Vote likelihoods, P(approve | voter is spy?, team carries a spy?).
const P_APPROVE = {
  spy:  { withSpy: 0.85, clean: 0.35 },
  res:  { withSpy: 0.6,  clean: 0.6 },   // uninformative on purpose: operatives don't know
};

// ---------- combinatorics ----------
export function combos(items, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

// ---------- the posterior ----------
// A spy set is a bitmask over seats (n <= 10, so it fits in an int). Keeping
// the whole model in ints and flat arrays means a decision allocates almost
// nothing, which matters in a Durable Object and keeps the harness fast.
const popcount = (x) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
export const maskOf = (seats) => seats.reduce((m, s) => m | (1 << s), 0);

// `knownClean` is a seat that is certainly not a spy (the bot itself, when it
// is an operative). Pass null for an outsider's view of the table, which is
// what a spy uses to judge how it looks to the others.
// Returns [{ set, mask, p }], p summing to 1.
export function posterior(view, { knownClean = null, voteWeight = 0.5, fog = 0 } = {}) {
  const n = view.n;
  const sets = [];
  for (const set of combos([...Array(n).keys()], E.SPIES[n])) {
    const mask = maskOf(set);
    if (knownClean !== null && (mask >> knownClean) & 1) continue;
    sets.push({ set, mask, w: 1, p: 0 });
  }
  const fS = new Float64Array(n), fR = new Float64Array(n); // per-voter factors, reused

  for (const round of view.rounds) {
    const rate = SPY_FAIL_RATE[round.mission] ?? 0.9;
    round.proposals.forEach((p, idx) => {
      // The fifth proposal is forced (approve or lose), so it says nothing.
      if (voteWeight <= 0 || idx >= E.MAX_REJECTS - 1 || !p.votes) return; // !votes: counted in the dark
      const teamMask = maskOf(p.team);
      for (const carries of [false, true]) {
        const pS = carries ? P_APPROVE.spy.withSpy : P_APPROVE.spy.clean;
        const pR = carries ? P_APPROVE.res.withSpy : P_APPROVE.res.clean;
        for (let v = 0; v < n; v++) { fS[v] = p.votes[v] ? pS : 1 - pS; fR[v] = p.votes[v] ? pR : 1 - pR; }
        for (const h of sets) {
          if (((h.mask & teamMask) !== 0) !== carries) continue;
          let like = 1;
          for (let v = 0; v < n; v++) like *= (h.mask >> v) & 1 ? fS[v] : fR[v];
          h.w *= Math.pow(like, voteWeight);
        }
      }
    });
    if (round.result) {
      const r = round.result;
      const teamMask = maskOf(r.team);
      if (r.cards) {
        // Signed: every seat that played Fail was seen doing it. No fog; this
        // is not an inference anybody can talk themselves out of.
        const failMask = maskOf(r.cards.filter((c) => !c.success).map((c) => c.seat));
        for (const h of sets) if ((h.mask & failMask) !== failMask) h.w = 0;
      } else if (round.hour === "orders") {
        // Under orders no spy on the team could play Success: the count is exact.
        for (const h of sets) if (popcount(h.mask & teamMask) !== r.fails) h.w *= fog;
      } else {
        for (const h of sets) {
          const k = popcount(h.mask & teamMask);
          if (r.fails > k) { h.w *= fog; continue; }
          h.w *= binom(k, r.fails) * Math.pow(rate, r.fails) * Math.pow(1 - rate, k - r.fails);
        }
      }
    }
  }
  let total = 0;
  for (const h of sets) total += h.w;
  if (!(total > 0)) { for (const h of sets) h.w = 1; total = sets.length; } // contradictory history (should not happen)
  for (const h of sets) h.p = h.w / total;
  return sets;
}

export function marginals(sets, n) {
  const m = new Array(n).fill(0);
  for (const h of sets) for (let s = 0; s < n; s++) if ((h.mask >> s) & 1) m[s] += h.p;
  return m;
}

// P(the mission fails | this team), assuming spies fail whenever they can.
export function pFail(sets, team, need) {
  const teamMask = maskOf(team);
  let p = 0;
  for (const h of sets) if (popcount(h.mask & teamMask) >= need) p += h.p;
  return p;
}

// ---------- policies ----------
const sortNum = (a) => a.slice().sort((x, y) => x - y);
// The operative's approval rule: a team is fine if it is not much worse than
// the best team this seat could propose. The vote track loosens it.
const wouldApprove = (pf, bestPf, view, lv) => pf <= bestPf + lv.slack + 0.08 * view.rejects;
// Seats nobody may put on a team this round: whoever is laid up, and the
// leader when recused.
function barredSeats(view) {
  const b = new Set();
  if (view.wounded != null) b.add(view.wounded);
  if (view.hour === "recused") b.add(view.leader);
  return b;
}
// Every legal team of size k that includes `me` when it can.
function teamsFor(view, me, k) {
  const barred = barredSeats(view);
  const others = [...Array(view.n).keys()].filter((s) => s !== me && !barred.has(s));
  return barred.has(me) ? combos(others, k) : combos(others, k - 1).map((rest) => sortNum([me, ...rest]));
}
// Best team for `me`, by P(fail), under a posterior.
function bestTeamWith(sets, view, me, k, need) {
  let best = null;
  for (const team of teamsFor(view, me, k)) {
    const pf = pFail(sets, team, need);
    if (!best || pf < best.pf) best = { team, pf };
  }
  return best;
}
const topSuspects = (m, exclude, count = 2) =>
  [...m.keys()].filter((s) => !exclude.includes(s)).sort((a, b) => m[b] - m[a]).slice(0, count);
// A signed team is safe unless the spies need only one more fail: short of
// that, no spy will name themself by failing it.
const signedSafe = (view) => view.hour === "signed" && view.score[SPY] < E.WINS_NEEDED - 1;

function resistanceDecision(view, lv, rng) {
  const me = view.seat;
  const sets = posterior(view, { knownClean: me, voteWeight: lv.voteWeight, fog: lv.fog });
  const m = marginals(sets, view.n);
  const k = view.teamSize, need = view.failsNeeded;
  // Every legal team, scored by P(fail). I know I am clean, so a team with me
  // on it beats the same team with me swapped out, unless I am laid up.
  const candidates = teamsFor(view, me, k)
    .map((team) => ({ team, pf: pFail(sets, team, need) }))
    .sort((a, b) => a.pf - b.pf || (a.team.join() < b.team.join() ? -1 : 1));
  const best = candidates[0];

  if (view.phase === "propose") {
    const pick = rng.next() < lv.noise ? candidates[rng.int(Math.min(3, candidates.length))] : best;
    return { type: "propose", seat: me, team: pick.team, why: { trusted: pick.team.filter((s) => s !== me), pFail: pick.pf, suspects: topSuspects(m, pick.team) } };
  }

  if (view.phase === "vote") {
    const team = view.proposal;
    const pf = pFail(sets, team, need);
    const forced = view.rejects >= E.MAX_REJECTS - 1;
    let approve = forced || view.leader === me || signedSafe(view) || wouldApprove(pf, best.pf, view, lv);
    if (!forced && rng.next() < lv.noise) approve = rng.next() < 0.6;
    const worst = team.filter((s) => s !== me).sort((a, b) => m[b] - m[a])[0];
    return { type: "vote", seat: me, approve, why: { forced, pFail: pf, bestPFail: best.pf, onTeam: team.includes(me), suspect: worst, suspectP: m[worst] } };
  }

  if (view.phase === "mission") return { type: "play", seat: me, success: true };
  return null;
}

function spyDecision(view, lv, rng) {
  const me = view.seat;
  const n = view.n;
  const spies = view.spies ? view.spies : [me]; // blind spies know only themselves
  const isSpy = (s) => spies.includes(s);
  // How the table looks from the outside: which seats the operatives trust.
  const sets = posterior(view, { knownClean: null, voteWeight: lv.voteWeight, fog: lv.fog });
  const m = marginals(sets, n);
  const k = view.teamSize, need = view.failsNeeded;
  const score = view.score;
  const decisive = score[SPY] === E.WINS_NEEDED - 1 || score[RESISTANCE] === E.WINS_NEEDED - 1;
  const lastFail = score[SPY] === E.WINS_NEEDED - 1;
  const exposed = view.hour === "signed"; // a Fail on this round names whoever played it

  if (view.phase === "propose") {
    const barred = barredSeats(view);
    const pool = [...Array(n).keys()].filter((s) => !barred.has(s));
    const canSelf = !barred.has(me); // a recused spy leader sends a fellow spy instead
    // Me plus the most-trusted operatives: exactly the spies it takes to sink
    // the mission, and a team that reads as a sensible pick. On a signed round
    // a fail names its player, so the team just looks clean.
    const spiesWanted = exposed && !lastFail ? (canSelf ? 1 : 0) : Math.min(need, spies.length, k);
    const otherSpies = spies.filter((s) => s !== me && !barred.has(s)).sort((a, b) => m[a] - m[b])
      .slice(0, Math.max(0, spiesWanted - (canSelf ? 1 : 0)));
    const ops = pool.filter((s) => !isSpy(s)).sort((a, b) => m[a] - m[b]);
    const fill = (first) => {
      const out = [...new Set(first)];
      for (const s of pool) { if (out.length >= k) break; if (!out.includes(s)) out.push(s); }
      return sortNum(out.slice(0, k));
    };
    const team = fill([...(canSelf ? [me] : []), ...otherSpies, ...ops]);
    if (rng.next() < lv.noise) {
      const rnd = fill([...(canSelf ? [me] : []), ...E.shuffle(rng, pool.filter((s) => s !== me))]);
      return { type: "propose", seat: me, team: rnd, why: { trusted: rnd.filter((s) => s !== me), suspects: topSuspects(m, rnd) } };
    }
    return { type: "propose", seat: me, team, why: { trusted: team.filter((s) => s !== me), suspects: topSuspects(m, team) } };
  }

  if (view.phase === "vote") {
    const team = view.proposal;
    const spiesOn = team.filter(isSpy).length;
    const canSink = spiesOn >= need && (!exposed || lastFail);
    let approve;
    if (view.rejects >= E.MAX_REJECTS - 1) approve = false;          // the fifth rejection wins
    else if (decisive) approve = canSink;                              // this vote decides the game
    else if (view.leader === me) approve = true;                       // nobody rejects their own team
    else if (view.hour === "dark") approve = canSink;                  // in the dark there is nobody to fool
    else if (rng.next() < lv.spyMimic) {
      // Vote as an operative in this seat would, from the outsider posterior
      // (which does not know I am a spy), so my votes carry no signal.
      const outsiderBest = bestTeamWith(sets, view, me, k, need);
      approve = signedSafe(view) || wouldApprove(pFail(sets, team, need), outsiderBest.pf, view, lv);
    }
    else if (canSink) approve = rng.next() < 0.85;
    else if (view.mission === 0) approve = rng.next() < 0.8;           // cover on mission 1
    else approve = rng.next() < 0.3;
    if (rng.next() < lv.noise) approve = rng.next() < 0.6;
    const worst = team.filter((s) => s !== me).sort((a, b) => m[b] - m[a])[0];
    return { type: "vote", seat: me, approve, why: { canSink, pFail: pFail(sets, team, need), onTeam: team.includes(me), suspect: worst, suspectP: m[worst] } };
  }

  if (view.phase === "mission") {
    const team = view.proposal;
    const spiesOn = team.filter(isSpy);
    // Orders leave no choice: the engine would refuse a Success.
    if (view.hour === "orders") return { type: "play", seat: me, success: false };
    if (exposed) {
      // A signed Fail names the one who played it. Only worth it if it ends the game.
      const wins = lastFail && (view.spies ? spiesOn.length >= need && spiesOn.slice(0, need).includes(me) : need === 1);
      return { type: "play", seat: me, success: !wins };
    }
    if (!view.spies) {
      // Blind: cannot coordinate. Fail unless it is clearly wasted.
      return { type: "play", seat: me, success: need > 1 && rng.next() < 0.5 };
    }
    if (spiesOn.length < need) return { type: "play", seat: me, success: true }; // cannot sink; don't burn cover
    // Exactly `need` spies fail, chosen by seat order so they never over-fail.
    const designated = spiesOn.slice(0, need);
    if (!designated.includes(me)) return { type: "play", seat: me, success: true };
    // A fail on a two-seat team, or on mission 1, costs a lot of cover: the
    // operatives learn half a name. Let those through unless the score says
    // every remaining mission has to sink.
    const failsStillNeeded = E.WINS_NEEDED - score[SPY];
    const missionsLeft = E.MISSIONS - view.mission;
    const must = decisive || failsStillNeeded >= missionsLeft;
    const cheap = team.length <= 2 || view.mission === 0;
    if (!must && cheap && rng.next() < lv.spyCover) return { type: "play", seat: me, success: true };
    return { type: "play", seat: me, success: false };
  }
  return null;
}

// ---------- entry point ----------
// Returns the action this seat should take now, or null if it is not its turn.
export function decide(view, level = "normal", rng = E.makeRng(E.randomSeed())) {
  const lv = LEVEL[level] || LEVEL.normal;
  const me = view.seat;
  if (me === null || !view.waitingOn.includes(me)) return null;
  if (view.phase === "reveal") return { type: "ready", seat: me };
  if (view.role === SPY) return spyDecision(view, lv, rng);
  return resistanceDecision(view, lv, rng);
}

// Suspicion as this seat sees it — for the UI's "who do you think" hints and
// for table talk. Operatives get their own posterior; spies get the outsider view.
export function suspicion(view, level = "normal") {
  const lv = LEVEL[level] || LEVEL.normal;
  const clean = view.role === RESISTANCE ? view.seat : null;
  return marginals(posterior(view, { knownClean: clean, voteWeight: lv.voteWeight, fog: lv.fog }), view.n);
}
