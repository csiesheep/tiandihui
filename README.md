# Tiandihui Brotherhood 天地會

A browser social-deduction game for 5 to 10 players. You meet in a back hall and swear the oath; two to four of you have already sold it to the Qing court. Over five missions the brotherhood tries to carry three through and the informers try to wreck three. Play solo against AI, or open an online room and share a four-letter code with friends; bots fill any empty seats. English and traditional Chinese.

A free fan project, not affiliated with any publisher. All art and prose are our own. The play is inspired by *The Resistance*, a social deduction game designed by Don Eskridge; game rules and mechanics are not copyrightable, and this is a clean-room implementation under its own name and setting.

Live at https://games.csiesheep.com/tiandihui/ — solo against bots, or a room with friends.

## How it works

Everything runs on Cloudflare as one Worker, the same shape as [Dice Wars](https://github.com/csiesheep/dice_war):

- `public/` is the client: landing, setup, lobby and the table view, served as static assets. `public/shared/engine.js` holds all rules (tables, phase machine, per-seat view projection), `public/shared/bots.js` the AI and `public/shared/talk.js` the bots' table talk, all used unchanged by both the browser and the server. Every player-visible string is in `public/i18n/`.
- `src/index.js` is the Worker: the path-prefix router that serves `/tiandihui/…` plus the WebSocket entry point at `/tiandihui/ws`.
- `src/room.js` is a Durable Object, one per room, named by its code. It is authoritative: it deals the roles, applies every action through the engine, keeps the phase clock, runs the bot seats, and sends each seat only `view(state, seat)` — never the state. Connections use the WebSocket Hibernation API; all timers are the object's single alarm.

Rules of the table: 30 s to read your card, 90 s to propose, 30 s to vote, 30 s to play a card; when time runs out the table decides for whoever has not acted. A player who drops is played by a bot after 15 s and gets the seat back by reopening the link in the same tab. A player who leaves mid-game becomes a bot. The host can add bots to fill seats, and a room nobody is connected to is deleted after 30 minutes. The room's language is the host's when it was created; it governs bot talk and the table log.

URLs are query strings on the page so the same build works at any prefix:

- `/tiandihui/` landing
- `/tiandihui/?play` single player
- `/tiandihui/?room=ABCD` an online room

## Milestones

1. **M0 Scaffold** — router, placeholder page, deploy. Done.
2. **M1 Engine** — tables, phase machine, reducer, `view(state, seat)`, tests. Done.
3. **M2 Bots** — Bayesian suspicion model over spy sets, resistance and spy policies, three levels, a bot-vs-bot harness to tune win rates. Done.
4. **M3 Solo** — the full game against bots in the browser, with bot table talk. Done.
5. **M4 Rooms** — Durable Object, phase timers, chat, bot fill, disconnect takeover. Done.
6. **M5 Ship** — rules page, SEO, hub card, sitemap.

## Develop

```bash
npm install
npm run dev
```

Then open http://localhost:8787/tiandihui/.

```bash
npm test          # engine and bot tests
npm run sim 300   # bot-vs-bot win rates per player count and level
```

The harness runs each cell in a child process with retries: Node 24 on the development machine dies with an access violation a few percent of the time on this workload, under any V8 flags.

## Deploy

```bash
npm run deploy
```

Deploys from a logged-in `wrangler`. The routes in `wrangler.jsonc` attach the Worker to `games.csiesheep.com/tiandihui` and `/tiandihui/*`; the `games` hub Worker keeps the hostname itself. Pushes to `main` do not deploy on their own unless the repo is connected under Workers & Pages in the Cloudflare dashboard, as the sibling games are.
