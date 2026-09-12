// Bot-vs-bot harness. Plays whole games through the engine with every seat a
// bot, and reports the resistance win rate per player count and level
// matchup. This is how the bots get tuned: by numbers, not by feel.
//
//   node tests/sim.js                 # default: 400 games × 5..10 players × matchups
//   node tests/sim.js 2000 7          # 2000 games, 7 players only
//   node tests/sim.js 500 5 normal hard   # resistance level, spy level
import * as E from "../public/shared/engine.js";
import * as B from "../public/shared/bots.js";

export function playGame(seed, n, resLevel, spyLevel, options = {}) {
  const rng = E.makeRng(seed);
  let st = E.createGame(rng.int(2 ** 31), n, options);
  let steps = 0;
  while (st.phase !== "over") {
    if (++steps > 2000) throw new Error("game did not terminate");
    const who = E.mustAct(st);
    const seat = who[rng.int(who.length)];
    const level = st.roles[seat] === E.SPY ? spyLevel : resLevel;
    const action = B.decide(E.view(st, seat), level, rng);
    if (!action) throw new Error(`bot in seat ${seat} returned no action during ${st.phase}`);
    st = E.apply(st, action);
  }
  return st;
}

export function simulate({ games = 400, n = 7, resLevel = "normal", spyLevel = "normal", seed = 1, options = {} } = {}) {
  const out = { games, n, resLevel, spyLevel, resWins: 0, byRejects: 0, rounds: 0, proposals: 0,
    // diagnostics: per mission index, how often it was attempted / failed;
    // approval rate of proposals that carried a spy vs clean ones.
    missionTried: [0, 0, 0, 0, 0], missionFailed: [0, 0, 0, 0, 0],
    spyTeams: 0, spyTeamsApproved: 0, cleanTeams: 0, cleanTeamsApproved: 0 };
  for (let g = 0; g < games; g++) {
    const st = playGame(seed * 100003 + g, n, resLevel, spyLevel, options);
    if (st.winner === E.RESISTANCE) out.resWins++;
    if (st.reason === "rejects") out.byRejects++;
    out.rounds += st.rounds.length;
    const spies = E.spiesOf(st);
    for (const r of st.rounds) {
      out.proposals += r.proposals.length;
      if (r.result) { out.missionTried[r.mission]++; if (!r.result.success) out.missionFailed[r.mission]++; }
      for (const p of r.proposals) {
        const carries = p.team.some((s) => spies.includes(s));
        if (carries) { out.spyTeams++; if (p.approved) out.spyTeamsApproved++; }
        else { out.cleanTeams++; if (p.approved) out.cleanTeamsApproved++; }
      }
    }
  }
  out.resRate = out.resWins / games;
  out.avgRounds = out.rounds / games;
  out.avgProposalsPerRound = out.proposals / out.rounds;
  return out;
}

// ---------- CLI ----------
// Each cell runs in its own child process, retried on a non-zero exit. Node
// 24 on the development machine dies with an access violation (0xC0000005)
// a few percent of the time on long runs of this workload, regardless of V8
// flags; isolating cells keeps one crash from taking the whole table down.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain && process.argv[2] === "--cell") {
  const [, , , resLevel, spyLevel, n, games, seed, hours] = process.argv;
  const o = simulate({ games: Number(games), n: Number(n), resLevel, spyLevel, seed: Number(seed), options: { hours: hours === "1" } });
  process.stdout.write(JSON.stringify(o));
} else if (isMain) {
  // --hours runs every cell with the Hour deck on.
  const HOURS_ON = process.argv.includes("--hours");
  const argv = process.argv.filter((a) => a !== "--hours");
  const games = Number(argv[2]) || 400;
  const only = Number(argv[3]) || null;
  const matchups = argv[4]
    ? [[argv[4], argv[5] || argv[4]]]
    : [["easy", "easy"], ["normal", "normal"], ["hard", "hard"], ["normal", "hard"], ["hard", "normal"]];
  const counts = only ? [only] : [5, 6, 7, 8, 9, 10];
  const self = fileURLToPath(import.meta.url);
  const cell = (r, s, n) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = spawnSync(process.execPath, [self, "--cell", r, s, String(n), String(games), "1", HOURS_ON ? "1" : "0"], { encoding: "utf8" });
      if (res.status === 0 && res.stdout) return JSON.parse(res.stdout);
      process.stderr.write(`cell ${r}/${s} n=${n} attempt ${attempt + 1} exited ${res.status}; retrying\n`);
    }
    return null;
  };
  console.log(`${games} games each${HOURS_ON ? ", with the Hour deck" : ""}. Resistance win rate (share lost on the vote track) | avg rounds | proposals per round`);
  console.log("res/spy   " + counts.map((n) => String(n).padStart(14)).join(""));
  for (const [r, s] of matchups) {
    const cells = counts.map((n) => {
      const o = cell(r, s, n);
      if (!o) return "crashed".padStart(14);
      return `${(o.resRate * 100).toFixed(0).padStart(3)}% (${(o.byRejects / games * 100).toFixed(0).padStart(2)}%) ${o.avgRounds.toFixed(1)}/${o.avgProposalsPerRound.toFixed(1)}`.padStart(14);
    });
    console.log(`${r}/${s}`.padEnd(10) + cells.join(""));
  }
}
