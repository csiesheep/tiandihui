// Table talk: a short line a bot says when it proposes, votes, or reacts to
// a mission result, built from the `why` its decision carried, so the line
// is true to what the bot actually concluded (a spy lies with the same
// templates an operative uses, which is the point). Templates live in the
// language files under `talk`; this module holds no prose.

const pick = (rng, arr) => arr[rng.int(arr.length)];
const fill = (s, p) => s.replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ""));

function joinNames(seats, ctx) {
  const names = seats.map((s) => ctx.names[s]);
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(ctx.sep) + ctx.and + names[names.length - 1];
}

const wasOnFailedMission = (view, seat) =>
  view.rounds.some((r) => r.result && !r.result.success && r.result.team.includes(seat));

const sharedCleanMission = (view, a, b) =>
  view.rounds.some((r) => r.result && r.result.success && r.result.team.includes(a) && r.result.team.includes(b));

// ctx: { rng, names, T (the language's talk table), sep, and }
export function sayAction(action, view, ctx) {
  const T = ctx.T, rng = ctx.rng, me = action.seat, why = action.why || {};
  const N = (s) => ctx.names[s];

  if (action.type === "propose") {
    const trusted = (why.trusted || action.team.filter((s) => s !== me));
    const [a, b] = trusted;
    let line;
    if (view.mission === 0 && action.team.includes(me)) { // the round-one lines say "with me"
      line = fill(pick(rng, trusted.length >= 2 ? T.proposeFirst : T.proposeFirst2), { a: N(a), b: N(b) });
    } else {
      const proven = trusted.find((s) => sharedCleanMission(view, me, s));
      if (proven !== undefined) line = fill(pick(rng, T.proposeClean), { a: N(proven) });
      else line = fill(pick(rng, trusted.length >= 2 ? T.propose : T.propose2), { a: N(a), b: N(b) });
    }
    const s = (why.suspects || [])[0];
    if (s !== undefined && view.mission > 0 && rng.next() < 0.35) line += " " + fill(pick(rng, T.proposeNot), { s: N(s) });
    return line;
  }

  if (action.type === "vote") {
    if (why.forced) return pick(rng, T.voteForced);
    if (!action.approve) {
      if (!why.onTeam && rng.next() < 0.4) return pick(rng, T.rejectNotMe);
      const s = why.suspect;
      if (s === undefined) return pick(rng, T.reject);
      return fill(pick(rng, wasOnFailedMission(view, s) ? T.rejectFailed : T.reject), { s: N(s) });
    }
    return rng.next() < 0.45 ? pick(rng, T.approve) : null;
  }
  return null; // mission cards and readiness are silent
}

// After a mission resolves: what this seat says about it, or null.
export function sayResult(view, seat, ctx) {
  const T = ctx.T, rng = ctx.rng;
  const ev = view.event;
  if (!ev || ev.type !== "mission") return null;
  if (ev.success) return rng.next() < 0.4 ? pick(rng, T.success) : null;
  if (ev.team.includes(seat)) return pick(rng, T.failOnTeam);
  if (ev.team.length === 2) return fill(pick(rng, T.failOff2), { a: ctx.names[ev.team[0]], b: ctx.names[ev.team[1]] });
  return fill(pick(rng, T.failOff), { team: joinNames(ev.team, ctx) });
}
