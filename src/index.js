// Cloudflare Worker: path-prefix router in front of the static assets, plus the
// WebSocket entry point for multiplayer rooms (one Durable Object per room).
//
// `run_worker_first: true` (wrangler.jsonc) sends every request here before
// asset matching, so we can strip the prefix and still serve from
// the bare *.workers.dev root (or `wrangler dev`) while testing.
//
// The public path segment is independent of the repo / Worker name — change
// PREFIX alone to move the site to a different path.
export { Room } from "./room.js";

const PREFIX = "/tiandihui";
const CANONICAL = "https://games.csiesheep.com" + PREFIX + "/";
// Prefix-scoped sitemap. Game modes are query strings on the one page and
// carry a canonical back to it, so the page and the rules are all there is.
const SITEMAP_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  "  <url>",
  "    <loc>" + CANONICAL + "</loc>",
  "  </url>",
  "  <url>",
  "    <loc>" + CANONICAL + "rules</loc>",
  "  </url>",
  "</urlset>",
  "",
].join(String.fromCharCode(10));
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

// /tiandihui/ws?create=1&name=Alice&lang=en    opens a fresh room
// /tiandihui/ws?room=ABCD&name=Bob&token=…     joins (or reconnects to) a room
async function connectRoom(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a WebSocket", { status: 426 });
  }
  let code = (url.searchParams.get("room") || "").toUpperCase();
  if (url.searchParams.get("create") === "1") {
    // Pick a code nobody holds. Rooms are named by their code, so ask the
    // object whether it already has state.
    for (let i = 0; i < 20; i++) {
      code = newCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch("https://room/status");
      if (!(await res.json()).exists) break;
    }
    url.searchParams.set("room", code);
  } else if (!/^[A-Z0-9]{4}$/.test(code)) {
    return new Response("Bad room code", { status: 400 });
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  return stub.fetch(new Request(url.toString(), request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === PREFIX) {
      url.pathname = PREFIX + "/";
      return Response.redirect(url.toString(), 301);
    }

    if (!url.pathname.startsWith(PREFIX + "/")) {
      return new Response("Not found", { status: 404 });
    }

    const sub = url.pathname.slice(PREFIX.length);
    if (sub === "/ws") return connectRoom(request, env, url);
    if (sub === "/sitemap.xml") {
      return new Response(SITEMAP_XML, { headers: { "content-type": "application/xml; charset=utf-8" } });
    }

    url.pathname = sub;
    const response = await env.ASSETS.fetch(new Request(url, request));

    // The static-asset handler builds Location from the url we just stripped
    // the prefix off, so a same-origin redirect would escape this Worker and
    // 404 on the hub. Put the prefix back on.
    const location = response.headers.get("location");
    if (location) {
      const target = new URL(location, url);
      if (
        target.origin === url.origin &&
        target.pathname !== PREFIX &&
        !target.pathname.startsWith(PREFIX + "/")
      ) {
        target.pathname = PREFIX + target.pathname;
        const headers = new Headers(response.headers);
        headers.set("location", target.toString());
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }
    return response;
  },
};
