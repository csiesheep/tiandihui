// The rules of the game, and nothing else. Pure functions over a plain
// state object; no DOM, no network, no timers. Used unchanged by the browser
// (solo mode) and by the room Durable Object (multiplayer), which is why the
// per-seat `view()` lives here too: whoever holds the full state must never
// send it, only what that seat may see.
//
// Seats are integers 0..n-1 around the table, clockwise. Missions are indexed
// 0..4 ("mission 1" is index 0).

export const RESISTANCE = "resistance";
export const SPY = "spy";
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const MISSIONS = 5;
export const WINS_NEEDED = 3;
export const MAX_REJECTS = 5; // fifth rejected team in one round: spies win

// Spies per player count.
export const SPIES = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

// Team size per mission per player count.
export const TEAM = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

// The 4th mission (index 3) with 7 or more players needs two Fail cards.
export const failsNeeded = (n, mission) => (n >= 7 && mission === 3 ? 2 : 1);
export const teamSize = (n, mission) => TEAM[n][mission];

// ---------- the Hour deck (天時) ----------
// An optional deck of eight table-wide conditions. One card is drawn face up at
// the start of every round and holds for that round only. Drawn cards are not
// returned, so a five-round game shows five of the eight and anyone can count
// what is left.
//   light    輕裝  the team goes one short
//   signed   畫押  no shuffle: who played what is public
//   orders   密令  informers on the team must play Fail
//   wounded  掛彩  one random seat cannot be sent this round
//   silence  封口  nobody talks this round (enforced by the clients and room)
//   quiet    無事  nothing
//   dark     熄燈  votes are counted in the dark: only the tally is public
//                  until the game ends
//   recused  避嫌  the leader may not put themself on the team
export const HOURS = ["light", "signed", "orders", "wounded", "silence", "quiet", "dark", "recused"];

// Whether a card may be drawn for this mission. Travel Light never takes a
// two-seat team down to one, and nobody is laid up on the fifth mission,
// where a random absence would decide the game by luck. Recused stays out of
// the last two missions, where teams are biggest and the game gets decided,
// and is drawn only when a brother leader could still send a team of
// brothers without themself; otherwise it would not tilt the round, it would
// decide it.
export function hourAllowed(n, mission, card) {
  if (card === "light") return TEAM[n][mission] > 2;
  if (card === "wounded") return mission < MISSIONS - 1;
  if (card === "recused") return mission < MISSIONS - 2 && n - SPIES[n] - 1 >= TEAM[n][mission];
  return true;
}

// The team size this round, after the Hour.
export const roundTeamSize = (state) =>
  teamSize(state.n, state.mission) - (state.hour === "light" ? 1 : 0);

// ---------- seeded RNG (mulberry32), so a game replays from seed + actions ----------
export function makeRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(k) { return Math.floor(this.next() * k); },
    getState() { return a; },
    setState(s) { a = s >>> 0; },
  };
}
export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- game creation ----------
export function createGame(seed, n, options = {}) {
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}, got ${n}`);
  }
  const rng = makeRng(seed);
  const roles = new Array(n).fill(RESISTANCE);
  for (const s of shuffle(rng, [...Array(n).keys()]).slice(0, SPIES[n])) roles[s] = SPY;
  const leader = rng.int(n);
  const hours = !!options.hours;
  return {
    seed, n, roles, leader,
    options: { blindSpies: !!options.blindSpies, hours },
    phase: "reveal",          // reveal | propose | vote | mission | over
    ready: new Array(n).fill(false),
    mission: 0,               // index of the current mission
    rejects: 0,               // rejected proposals this round (the vote track)
    proposal: null,           // seats on the proposed / approved team
    votes: null,              // per seat: true / false / null (null = not yet)
    played: null,             // per seat: true (Success) / false (Fail) / null; only team seats
    rounds: [],               // one entry per mission attempted; public history
    score: { [RESISTANCE]: 0, [SPY]: 0 },
    winner: null,
    reason: null,             // "missions" | "rejects"
    event: null,              // what the last action caused, for the UI / bots
    hourDeck: hours ? HOURS.slice() : [], // Hour cards not yet drawn
    hour: null,               // this round's Hour card
    wounded: null,            // the seat laid up this round, if any
    rngState: rng.getState(),
  };
}

export const spiesOf = (state) => state.roles.map((r, i) => (r === SPY ? i : -1)).filter((i) => i >= 0);
export const isSpy = (state, seat) => state.roles[seat] === SPY;
export const nextSeat = (state, seat) => (seat + 1) % state.n;
export const currentRound = (state) => state.rounds[state.rounds.length - 1];

// Seats that still have to act in the current phase.
export function mustAct(state) {
  switch (state.phase) {
    case "reveal": return state.ready.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
    case "propose": return [state.leader];
    case "vote": return state.votes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    case "mission": return state.proposal.filter((s) => state.played[s] === null);
    default: return [];
  }
}

// The state is plain JSON (arrays, numbers, strings, booleans, null), so this
// is a complete copy. Chosen over structuredClone, which crashed V8 (Node 24)
// under the bot harness's allocation pressure.
export const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- the reducer ----------
// Returns a new state; the input is never mutated. Illegal actions throw, and
// the message says why, so the UI can gate buttons with the same checks.
export function apply(prev, action) {
  const st = clone(prev);
  st.event = null;
  const seat = action.seat;
  const checkSeat = () => {
    if (!Number.isInteger(seat) || seat < 0 || seat >= st.n) throw new Error(`bad seat ${seat}`);
  };
  const needPhase = (p) => {
    if (st.phase !== p) throw new Error(`cannot ${action.type} during ${st.phase}`);
  };

  switch (action.type) {
    case "ready": {
      needPhase("reveal"); checkSeat();
      st.ready[seat] = true;
      if (st.ready.every(Boolean)) startRound(st);
      return st;
    }
    case "propose": {
      needPhase("propose"); checkSeat();
      if (seat !== st.leader) throw new Error(`seat ${seat} is not the leader`);
      const team = Array.isArray(action.team) ? action.team.slice().sort((a, b) => a - b) : null;
      const size = roundTeamSize(st);
      if (!team || team.length !== size) throw new Error(`team must have ${size} seats`);
      if (new Set(team).size !== team.length) throw new Error("duplicate seat on team");
      if (team.some((s) => !Number.isInteger(s) || s < 0 || s >= st.n)) throw new Error("bad seat on team");
      if (st.wounded != null && team.includes(st.wounded)) throw new Error(`seat ${st.wounded} is laid up this round`);
      if (st.hour === "recused" && team.includes(seat)) throw new Error("the leader is recused this round");
      st.proposal = team;
      st.votes = new Array(st.n).fill(null);
      st.phase = "vote";
      st.event = { type: "proposed", leader: seat, team };
      return st;
    }
    case "vote": {
      needPhase("vote"); checkSeat();
      if (typeof action.approve !== "boolean") throw new Error("vote must be true or false");
      if (st.votes[seat] !== null) throw new Error(`seat ${seat} already voted`);
      st.votes[seat] = action.approve;
      if (st.votes.some((v) => v === null)) return st;
      // Everyone has voted: votes become public, and the proposal resolves.
      const yes = st.votes.filter(Boolean).length;
      const approved = yes * 2 > st.n; // a tie rejects
      const record = { leader: st.leader, team: st.proposal, votes: st.votes, approved };
      st.event = { type: "voted", team: st.proposal, votes: st.votes, yes, approved };
      // Lights Out: the state keeps the votes; views show only the tally until the game ends.
      if (st.hour === "dark") { record.dark = true; st.event.dark = true; }
      currentRound(st).proposals.push(record);
      if (approved) {
        st.played = new Array(st.n).fill(null);
        st.votes = null;
        st.phase = "mission";
      } else {
        st.rejects += 1;
        st.votes = null;
        st.proposal = null;
        if (st.rejects >= MAX_REJECTS) {
          endGame(st, SPY, "rejects");
        } else {
          st.leader = nextSeat(st, st.leader);
          st.phase = "propose";
        }
      }
      return st;
    }
    case "play": {
      needPhase("mission"); checkSeat();
      if (!st.proposal.includes(seat)) throw new Error(`seat ${seat} is not on the mission`);
      if (st.played[seat] !== null) throw new Error(`seat ${seat} already played`);
      if (typeof action.success !== "boolean") throw new Error("card must be true (Success) or false (Fail)");
      if (!action.success && st.roles[seat] === RESISTANCE) throw new Error("operatives must play Success");
      if (action.success && st.hour === "orders" && st.roles[seat] === SPY) throw new Error("under orders, informers must play Fail");
      st.played[seat] = action.success;
      if (st.proposal.some((s) => st.played[s] === null)) return st;
      // Every card is in: count fails. Who played what is recorded only on a
      // signed round, where the cards are not shuffled.
      const fails = st.proposal.filter((s) => st.played[s] === false).length;
      const need = failsNeeded(st.n, st.mission);
      const success = fails < need;
      const round = currentRound(st);
      round.result = { team: st.proposal, fails, need, success };
      st.event = { type: "mission", mission: st.mission, team: st.proposal, fails, need, success };
      if (st.hour) st.event.hour = st.hour;
      if (st.hour === "signed") {
        round.result.cards = st.proposal.map((s) => ({ seat: s, success: st.played[s] }));
        st.event.cards = clone(round.result.cards);
      }
      st.score[success ? RESISTANCE : SPY] += 1;
      st.played = null;
      st.proposal = null;
      const side = success ? RESISTANCE : SPY;
      if (st.score[side] >= WINS_NEEDED) {
        endGame(st, side, "missions");
      } else {
        st.mission += 1;
        st.rejects = 0;
        st.leader = nextSeat(st, st.leader);
        startRound(st);
      }
      return st;
    }
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}

function startRound(st) {
  const round = { mission: st.mission, proposals: [], result: null };
  st.hour = null;
  st.wounded = null;
  if (st.options.hours) {
    // Draw from what is left, among the cards allowed for this mission. The
    // rng lives in the state, so a game still replays from seed + actions.
    const rng = makeRng(0);
    rng.setState(st.rngState);
    const legal = st.hourDeck.filter((c) => hourAllowed(st.n, st.mission, c));
    if (legal.length) {
      st.hour = legal[rng.int(legal.length)];
      st.hourDeck.splice(st.hourDeck.indexOf(st.hour), 1);
      if (st.hour === "wounded") st.wounded = rng.int(st.n);
    }
    st.rngState = rng.getState();
    round.hour = st.hour;
    round.wounded = st.wounded;
  }
  st.rounds.push(round);
  st.phase = "propose";
  st.proposal = null;
  st.votes = null;
  st.played = null;
}

function endGame(st, winner, reason) {
  st.phase = "over";
  st.winner = winner;
  st.reason = reason;
  st.proposal = null;
  st.votes = null;
  st.played = null;
  st.hour = null;
  st.wounded = null;
  st.event = { ...(st.event || {}), over: true, winner, reason };
}

// A Lights Out vote leaves the process without its per-seat votes until the
// game is over; the tally (yes) stays.
const darkened = (ev, over) => (ev.dark && !over && ev.votes ? { ...ev, votes: null } : ev);
const darkProposal = (p, over) => (p.dark && !over ? { ...p, votes: null, yes: p.votes.filter(Boolean).length } : p);

// ---------- per-seat projection ----------
// `seat` is the viewer, or null for a spectator. This is the only thing that
// may leave the process that holds the full state.
export function view(state, seat = null) {
  const over = state.phase === "over";
  const mine = seat === null ? null : state.roles[seat];
  const spiesVisible = over || (mine === SPY && !state.options.blindSpies);
  const v = {
    n: state.n,
    seat,
    role: mine,
    spies: spiesVisible ? spiesOf(state) : null,
    roles: over ? state.roles.slice() : null,
    options: { blindSpies: !!state.options.blindSpies, hours: !!state.options.hours },
    phase: state.phase,
    leader: state.leader,
    mission: state.mission,
    teamSize: state.mission < MISSIONS ? roundTeamSize(state) : null,
    failsNeeded: state.mission < MISSIONS ? failsNeeded(state.n, state.mission) : null,
    sizes: TEAM[state.n],
    rejects: state.rejects,
    ready: state.ready.slice(),
    proposal: state.proposal ? state.proposal.slice() : null,
    // While voting, only *who* has voted is visible. Once everyone has, the
    // resolved votes are in rounds[].proposals[] and this is null.
    voted: state.votes ? state.votes.map((x) => x !== null) : null,
    myVote: state.votes && seat !== null ? state.votes[seat] : null,
    // Same for mission cards: only who has played, never what, until the
    // mission resolves. Then only the count of fails is published, through
    // rounds[].result, unless the round was signed.
    played: state.played ? state.proposal.map((s) => state.played[s] !== null) : null,
    myCard: state.played && seat !== null ? state.played[seat] : null,
    // The Hour is public: this round's card, the seat laid up, and what is
    // left in the deck (sorted, so the list says nothing about draw order).
    hour: state.hour ?? null,
    wounded: state.wounded ?? null,
    hourDeck: state.hourDeck ? state.hourDeck.slice().sort((a, b) => HOURS.indexOf(a) - HOURS.indexOf(b)) : [],
    rounds: clone(state.rounds).map((r) => ({ ...r, proposals: r.proposals.map((p) => darkProposal(p, over)) })),
    score: { ...state.score },
    winner: state.winner,
    reason: state.reason,
    event: state.event ? darkened(clone(state.event), over) : null,
    waitingOn: mustAct(state),
  };
  return v;
}
