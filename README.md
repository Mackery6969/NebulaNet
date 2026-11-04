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

## Protocol (version 1)

The full message list is at the top of [`src/protocol.ts`](src/protocol.ts). In short:

- `GET /v1/host`, a WebSocket kept open while the room is open. The host sends `open` (game, version, name, players,
  max, candidates) and gets `room` with the code; NebulaNet sends `joiner` with a joiner's candidates; the host sends
  `update` when its player count changes; `ping` is answered `pong`. The room ends when the socket closes.
- `POST /v1/join` with `{"code","candidates"}` answers the room's name, version, players, max and the host's
  candidates, or `404 not_found`, `409 full`, `400 bad_request`, `429 busy`.

A candidate is `"1.2.3.4:5678"` or `"[2001:db8::1]:5678"`. Codes are 6 characters from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O or 1/I), with case and dashes ignored.

Each room is a Durable Object named by its code. The host's socket uses the WebSocket hibernation API, so an open room
that nobody is joining costs nothing while it waits. Joins are limited to 30 a minute per room.

## Developing

```sh
npm install
npm run check   # TypeScript
npm test        # protocol tests (Node 22)
npm run dev     # the Worker locally on http://127.0.0.1:8787
```

## Deploying

Merging to `main` deploys through GitHub Actions (`.github/workflows/deploy.yml`) once the repository has two secrets:
`CLOUDFLARE_API_TOKEN` (a token made from the "Edit Cloudflare Workers" template, with the `mackery.com` zone
included) and `CLOUDFLARE_ACCOUNT_ID`. By hand:

```sh
npx wrangler login
npm run deploy
```

It answers at `https://nebulanet.mackery.com` (the custom domain in `wrangler.jsonc`; `mackery.com` has to be a zone
on the same Cloudflare account, and deploying adds the DNS record) and at `nebulanet.<your-subdomain>.workers.dev`.
That address is Nebula's default; its `coop_nebulanet` setting points a game at another NebulaNet.

## Coming next

- Relay fallback: short-lived Cloudflare TURN credentials for joins that can't punch through.
- Discord Join button carrying the room code (on Nebula's side).
- An optional public room list.
