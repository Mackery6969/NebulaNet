# NebulaNet

Online services for Nebula co-op. NebulaNet lets friends join a room by a short code with no port forwarding, the
way sm64coopdx's CoopNet does. The world still runs on the host's PC and play goes straight between the players:
NebulaNet only introduces them.

## How a join works

1. The host's game asks a STUN server (`stun.cloudflare.com`) which public address its game socket has, and opens a
   WebSocket to NebulaNet with that address and its addresses on its own network. NebulaNet answers with a room code.
2. A friend types the code. Their game asks STUN for its own public address and sends it with the code to NebulaNet.
3. NebulaNet gives the friend the host's addresses and tells the host the friend's.
4. Both games send packets at each other at once, so both routers open a path, and the join carries on as a direct
   one. Nebula's `DirectTransport` does this part (`discover_public_address`, `punch`, `JoinConfig::alternates`).

Hosts can still skip NebulaNet and share `address:port` as before.

## What it does, next to CoopNet

NebulaNet is sm64coopdx's CoopNet made for Nebula, on Cloudflare instead of a server of its own:

| CoopNet | NebulaNet |
| --- | --- |
| Lobbies with game, version, host name, mode, description, password, max players (`LOBBY_CREATE`) | Rooms with the same (`open`), each named by a 6-character code |
| Private lobbies, found by their password (`LOBBY_LIST_GET` with a password) | `POST /v1/list` with the password. There is no public list: a room without a password is joined by its code |
| The owner updates its lobby (`LOBBY_UPDATE`) | The host sends `update` (players, name, mode, description) |
| Join errors: not found, full, wrong password, old CoopNet (`MERR_*`) | `404 not_found`, `409 full`, `403 wrong_password`, `426 old_game` |
| STUN and TURN servers handed out (`STUN_TURN`, `turn-servers.cfg`) | `ice` in `room` and the join's answer, from `STUN_SERVERS`, `TURN_SERVERS` or a Cloudflare TURN key |
| Keepalive every 180 s, dead after 240 s | The game pings every 30 s; a host silent for 240 s is closed |
| `PEER_FAILED`: the lobby owner always wins | `POST /v1/report`: a joiner that couldn't reach the host says so and the host hears `joiner_failed` |
| Metrics (`hourly.json`, `daily.json`, `current.json`) | `GET /v1/stats` |
| SDP and ICE candidates relayed through the server, every member peered with every other | The host's and the joiner's addresses swapped once: Nebula's players form a star around the host, so joiners never connect to each other |

CoopNet's reputation (which of two players to drop when they can't reach each other) has no counterpart: in a star
the host always stays, which is what CoopNet does for a lobby's owner too. Its load balancing has none either:
Cloudflare answers from the place nearest each player.

## Protocol (version 2)

The full message list is at the top of [`src/protocol.ts`](src/protocol.ts). In short:

- `GET /v1/host`, a WebSocket kept open while the room is open. The host sends `open` (protocol, game, version,
  name, mode, description, password, players, max, candidates) and gets `room` with the code and the `ice` servers;
  NebulaNet sends `joiner` with a joiner's candidates and `joiner_failed` when one couldn't get through; the host
  sends `update` when its player count, name, mode or description changes; `ping` is answered `pong`. The room ends
  when the socket closes. A host whose connection dropped reconnects with `?code=` to get the same code back while no
  other room has taken it.
- `POST /v1/join` with `{"code","candidates","password","protocol"}` answers the room's name, version, mode,
  description, players, max, the host's candidates and the `ice` servers, or `404 not_found`, `409 full`,
  `403 wrong_password`, `426 old_game`, `400 bad_request`, `429 busy`.
- `POST /v1/list` with `{"game","password"}` answers `{"rooms":[…]}`: the private rooms that have the password (none
  without one). Rooms never show their addresses there.
- `POST /v1/report` with `{"code","ok","candidates"}`: how a join went.
- `GET /v1/stats`: rooms and players open now, the most at once each hour (48 hours) and day (30 days), and the joins
  made and failed in each.

Protocol 1 games still work: what they leave out reads as empty, so their rooms have no password and are joined by
code.

A candidate is `"1.2.3.4:5678"` or `"[2001:db8::1]:5678"`. Codes are 6 characters from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O or 1/I), with case and dashes ignored.

Each room is a Durable Object named by its code. The host's socket uses the WebSocket hibernation API, so an open room
that nobody is joining costs nothing while it waits; every 5 minutes it wakes to check its host and, for a private
room, refresh its place in the list. The list and the numbers are one more Durable Object, `LobbyDirectory`
(`src/directory.ts`), which drops a room it hasn't heard from for 16 minutes. Joins are limited to 30 a minute per room (so are a password's guesses),
lists to 30 a minute per address. Passwords are kept only as hashes.

## Cost

NebulaNet fits Cloudflare's Workers Free plan, with no card needed. Over a free limit, requests fail until the daily
reset (00:00 UTC); nothing is billed. Each open room wakes every 5 minutes (about 12 Durable Object requests and 12
rows written an hour, twice that for a private room, which also refreshes its listing), well inside the free plan's
100,000 requests and 100,000 rows written a day. Pings cost nothing: Cloudflare answers them without waking the room.
Game traffic never passes through NebulaNet. Only TURN relays could cost money, and none are handed out until a TURN
secret is set.

## TURN relays

For joins that can't punch through, NebulaNet hands out TURN servers, as CoopNet does. Set one of these as a secret
(dashboard, the Worker, Settings, Variables and Secrets):

- `TURN_SERVERS`: CoopNet's `turn-servers.cfg` lines, `host:user:pass:port`, one a line or commas between them.
- `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`: a Cloudflare TURN key (Realtime, TURN); NebulaNet makes short-lived
  credentials for each room and join.

`STUN_SERVERS` (`host:port`, commas between) replaces the default `stun.cloudflare.com:3478`.

## Developing

```sh
npm install
npm run check   # TypeScript
npm test        # protocol tests (Node 22)
npm run dev     # the Worker locally on http://127.0.0.1:8787
```

## Deploying

Cloudflare deploys it from GitHub by itself (Workers Builds), with no API token to make: in the Cloudflare dashboard,
Workers & Pages, Create, Import a repository, pick this repository, keep the deploy command `npx wrangler deploy`, and
save. Every push to `main` deploys from then on. By hand instead:

```sh
npx wrangler login
npm run deploy
```

It answers at `https://nebulanet.mackery.com` (the custom domain in `wrangler.jsonc`; `mackery.com` has to be a zone
on the same Cloudflare account, and deploying adds the DNS record) and at `nebulanet.<your-subdomain>.workers.dev`.
That address is Nebula's default; its `coop_nebulanet` setting points a game at another NebulaNet.

## Coming next

- Nebula relaying through the TURN servers it is handed, for joins that can't punch through.
- Discord Join button carrying the room code (on Nebula's side).
