// NebulaNet: introduces Nebula co-op players so nobody forwards a port (Nebula's docs/COOP_PLAN.md, "Hosting"). It is
// sm64coopdx's CoopNet made for Nebula: rooms (CoopNet's lobbies) with a name, mode, description and password, lists
// of them (the public ones, and the private ones by password), the host's updates, password and version checks,
// keepalives, failed joins reported back, STUN and TURN servers handed out, and numbers on how much it's used. It never carries game traffic: Nebula's players form a star
// around their host, so a joiner only ever needs the host's addresses and the host the joiner's, and both games
// punch through their routers. See protocol.ts for the messages.
//
// Each room is a Durable Object named by its code. Its host's WebSocket uses the hibernation API, so an open room
// that nobody is joining costs nothing while it waits. The room list and the numbers are one more Durable Object
// (directory.ts) that the rooms keep up to date.
import { DurableObject } from "cloudflare:workers";
import { LobbyDirectory } from "./directory.ts";
import {
  GAME,
  MAX_MESSAGE,
  MIN_PROTOCOL,
  PROTOCOL,
  type Room,
  applyUpdate,
  hasRoom,
  joinAnswer,
  listedRoom,
  makeCode,
  normalizeCode,
  parseHostMessage,
  parseJoinRequest,
  parseListRequest,
  parseReport,
} from "./protocol.ts";

export { LobbyDirectory };

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  LOBBIES: DurableObjectNamespace<LobbyDirectory>;
  // CoopNet's turn-servers.cfg, one "host:user:pass:port" a line (or comma between them): TURN servers handed to
  // games for joins that can't punch through. A secret; none set, none handed out.
  TURN_SERVERS?: string;
  // Or a Cloudflare TURN key (dashboard, Realtime, TURN): short-lived credentials made for each room and join.
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // "host:port" STUN servers, comma between them; unset: Cloudflare's.
  STUN_SERVERS?: string;
}

// How many codes to try before giving up on finding a free one (each taken one is 1 in a billion).
const CODE_TRIES = 5;
// Joins one room takes per minute, against someone hammering a code (or guessing its password).
const JOINS_PER_MINUTE = 30;
// How long a host has to say "open" before its socket is closed.
const OPEN_WITHIN_MS = 15_000;
// CoopNet's keepalive: a host's game pings every 30 s; one not heard from for this long is gone.
const DEAD_AFTER_MS = 240_000;
// How often an open room checks its host is still there and refreshes its place in the list (directory.ts EXPIRE_MS).
// Every 5 minutes: NebulaNet stays well inside Cloudflare's free plan (each wake is a request and a row written).
const REFRESH_MS = 300_000;
const DEFAULT_STUN = "stun.cloudflare.com:3478";

// What a host's socket keeps through hibernation.
interface HostAttachment {
  code: string;
  opened: number;  // when the socket was accepted (ms)
  heard: number;   // when the host last sent a message (its pings are answered without one: see alarm())
  room: Room | null;
  secret: string;  // the room's password's hash, "" for none
  everyone?: boolean;  // asked to be in the public list (left out by sockets accepted before public rooms: not)
  owner?: string;      // the host's address, hashed: how many public rooms it has is limited (directory.ts)
}

// STUN and TURN servers as CoopNet's MPACKET_STUN_TURN hands them out.
interface Ice {
  stun: { host: string; port: number }[];
  turn: { host: string; port: number; username: string; password: string }[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A password's hash, as rooms and the list keep it ("" for none).
async function secretOf(password: string): Promise<string> {
  return password === "" ? "" : sha256(`nebulanet room password\n${password}`);
}

// A room in the directory: public, or found by its password.
function listed(attachment: HostAttachment): boolean {
  return attachment.everyone === true || attachment.secret !== "";
}

function directory(env: Env): DurableObjectStub<LobbyDirectory> {
  return env.LOBBIES.get(env.LOBBIES.idFromName("lobbies"));
}

function hostPort(text: string): { host: string; port: number } | null {
  const colon = text.lastIndexOf(":");
  const port = Number(text.slice(colon + 1));
  const host = text.slice(0, colon);
  return colon > 0 && Number.isInteger(port) && port > 0 && port < 65536 && host.length > 0 ? { host, port } : null;
}

async function iceServers(env: Env): Promise<Ice> {
  const ice: Ice = { stun: [], turn: [] };
  for (const text of (env.STUN_SERVERS ?? DEFAULT_STUN).split(",")) {
    const server = hostPort(text.trim());
    if (server !== null) ice.stun.push(server);
  }
  for (const line of (env.TURN_SERVERS ?? "").split(/[\n,]/)) {
    const parts = line.trim().split(":");
    if (parts.length !== 4) continue;
    const port = Number(parts[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    ice.turn.push({ host: parts[0], username: parts[1], password: parts[2], port });
  }
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const answer = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: 86_400 }),
        });
      const body = (await answer.json()) as { iceServers?: { urls: string[]; username?: string; credential?: string }[] };
      for (const server of body.iceServers ?? []) {
        for (const url of server.urls) {
          // Plain UDP TURN only: "turn:turn.cloudflare.com:3478?transport=udp".
          const match = /^turn:([^?]+)(\?transport=udp)?$/.exec(url);
          const at = match === null ? null : hostPort(match[1]);
          if (at === null || !server.username || !server.credential) continue;
          ice.turn.push({ ...at, username: server.username, password: server.credential });
        }
      }
    } catch {
      // No TURN this time: punching still works for most.
    }
  }
  return ice;
}

export class RoomObject extends DurableObject<Env> {
  private joins: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives answered by Cloudflare itself, without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private host(): WebSocket | null {
    return this.ctx.getWebSockets("host").find((socket) => socket.readyState === WebSocket.OPEN) ?? null;
  }

  private attachment(socket: WebSocket): HostAttachment | null {
    return (socket.deserializeAttachment() as HostAttachment | null) ?? null;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = request.headers.get("x-nebulanet-code") ?? "";
    if (url.pathname === "/host") return this.acceptHost(code, request.headers.get("x-nebulanet-owner") ?? "");
    if (url.pathname === "/join") return this.join(await request.text());
    if (url.pathname === "/report") return this.report(await request.text());
    return json({ error: "not_found" }, 404);
  }

  private acceptHost(code: string, owner: string): Response {
    // A code already in use: the Worker tries another.
    if (this.host() !== null) return json({ error: "taken" }, 409);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["host"]);
    const now = Date.now();
    const attachment: HostAttachment = {
      code, opened: now, heard: now, room: null, secret: "", everyone: false, owner,
    };
    server.serializeAttachment(attachment);
    // A host that never says "open" is closed.
    void this.ctx.storage.setAlarm(now + OPEN_WITHIN_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  // A public or private room's place in the list. A room that is neither is only joined by its code, never listed.
  // False when it asked to be public and the list didn't take it as that (directory.ts PUBLIC_PER_ADDRESS).
  private async list(attachment: HostAttachment): Promise<boolean> {
    if (attachment.room === null || !listed(attachment)) return true;
    return directory(this.env).put({
      room: listedRoom(attachment.code, attachment.room, attachment.secret !== ""),
      game: attachment.room.game,
      secret: attachment.secret,
      everyone: attachment.everyone === true,
      owner: attachment.owner ?? "",
    });
  }

  // CoopNet's keepalive and the list's refresh: a host not heard from is closed, and a listed room says it's open.
  override async alarm(): Promise<void> {
    const host = this.host();
    if (host === null) return;
    const attachment = this.attachment(host);
    if (attachment === null) return;
    const now = Date.now();
    if (attachment.room === null) {
      if (now - attachment.opened >= OPEN_WITHIN_MS) host.close(4000, "no open");
      else await this.ctx.storage.setAlarm(attachment.opened + OPEN_WITHIN_MS);
      return;
    }
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(host)?.getTime() ?? 0;
    if (now - Math.max(pinged, attachment.heard) > DEAD_AFTER_MS) {
      host.close(4003, "timed out");
      if (listed(attachment)) await directory(this.env).remove(attachment.code);
      return;
    }
    await this.list(attachment);
    await this.ctx.storage.setAlarm(now + REFRESH_MS);
  }

  private refuse(socket: WebSocket, error: string, code: number): void {
    socket.send(JSON.stringify({ t: "error", error }));
    socket.close(code, error);
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (attachment === null) return;
    const message = typeof raw === "string" ? parseHostMessage(raw) : null;
    if (message === null) return this.refuse(socket, "bad_message", 4001);
    attachment.heard = Date.now();
    if (message.t === "open") {
      if (message.room.game !== GAME) return this.refuse(socket, "bad_game", 4002);
      if (message.protocol < MIN_PROTOCOL) return this.refuse(socket, "old_game", 4004);
      attachment.room = message.room;
      attachment.secret = await secretOf(message.password);
      attachment.everyone = message.listed;
      socket.serializeAttachment(attachment);
      const shown = await this.list(attachment);
      socket.send(JSON.stringify({
        t: "room",
        code: attachment.code,
        protocol: PROTOCOL,
        public: attachment.everyone && shown,
        ice: await iceServers(this.env),
      }));
      await this.ctx.storage.setAlarm(Date.now() + REFRESH_MS);
      return;
    }
    // Only a room's host updates it (CoopNet's LOBBY_UPDATE from its owner): the socket is the host's.
    if (attachment.room === null) {
      socket.serializeAttachment(attachment);
      return;
    }
    attachment.room = applyUpdate(attachment.room, message.update);
    socket.serializeAttachment(attachment);
    await this.list(attachment);
  }

  private async ended(socket: WebSocket): Promise<void> {
    const attachment = this.attachment(socket);
    // A host back for its code has a new socket by now; its listing stays.
    const alone = this.ctx.getWebSockets("host").every((other) => other === socket ||
      other.readyState !== WebSocket.OPEN);
    if (attachment !== null && listed(attachment) && alone) {
      await directory(this.env).remove(attachment.code);
    }
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // The room ends with its host's socket. 1005/1006 carry no code to echo back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
    await this.ended(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.ended(socket);
  }

  private open(): { host: WebSocket; attachment: HostAttachment; room: Room } | null {
    const host = this.host();
    const attachment = host === null ? null : this.attachment(host);
    if (host === null || attachment === null || attachment.room === null) return null;
    return { host, attachment, room: attachment.room };
  }

  private async join(raw: string): Promise<Response> {
    const request = parseJoinRequest(raw);
    if (request === null) return json({ error: "bad_request" }, 400);
    if (request.protocol < MIN_PROTOCOL) return json({ error: "old_game" }, 426);
    const open = this.open();
    if (open === null) return json({ error: "not_found" }, 404);
    const now = Date.now();
    this.joins = this.joins.filter((at) => now - at < 60_000);
    if (this.joins.length >= JOINS_PER_MINUTE) return json({ error: "busy" }, 429);
    this.joins.push(now);
    // CoopNet's MERR_LOBBY_PASSWORD_INCORRECT. The host checks it again as the joiner says hello. A room without a
    // password takes any, as its host does (a public room picked while a password is typed for another).
    if (open.attachment.secret !== "" && await secretOf(request.password) !== open.attachment.secret) {
      return json({ error: "wrong_password" }, 403);
    }
    if (!hasRoom(open.room)) return json({ error: "full" }, 409);
    // The host starts punching toward the joiner while the joiner starts saying hello.
    open.host.send(JSON.stringify({ t: "joiner", candidates: request.candidates }));
    return json({ ...joinAnswer(open.room), protocol: PROTOCOL, ice: await iceServers(this.env) });
  }

  // A joiner's word on how its join went (CoopNet's MPACKET_PEER_FAILED; the host always wins, so a failed join is
  // the joiner's): the host hears of a failure, and the numbers count both.
  private async report(raw: string): Promise<Response> {
    const report = parseReport(raw);
    if (report === null) return json({ error: "bad_request" }, 400);
    const open = this.open();
    if (open !== null && !report.ok) {
      open.host.send(JSON.stringify({ t: "joiner_failed", candidates: report.candidates }));
    }
    await directory(this.env).joined(report.ok);
    return json({ ok: true });
  }
}

async function hostRoom(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_expected" }, 426);
  }
  // A host that lost its connection asks for its code back (?code=), so the code its friends have keeps working;
  // it gets it unless another room took it meanwhile.
  const wanted = normalizeCode(new URL(request.url).searchParams.get("code"));
  const owner = await sha256(request.headers.get("cf-connecting-ip") ?? "");
  for (let i = 0; i < CODE_TRIES; ++i) {
    const code = i === 0 && wanted !== null ? wanted : makeCode((bytes) => crypto.getRandomValues(bytes));
    const room = env.ROOMS.get(env.ROOMS.idFromName(code));
    const headers = new Headers(request.headers);
    headers.set("x-nebulanet-code", code);
    headers.set("x-nebulanet-owner", owner);
    const answer = await room.fetch(new Request("https://room/host", { headers }));
    if (answer.status !== 409) return answer;
  }
  return json({ error: "busy" }, 503);
}

async function body(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_MESSAGE) return null;
  const text = await request.text();
  return text.length > MAX_MESSAGE ? null : text;
}

// A room's own request (a join, a report), passed to the room of its code.
async function toRoom(request: Request, env: Env, path: string, code: string | null, text: string): Promise<Response> {
  if (code === null) return json({ error: "bad_request" }, 400);
  const room = env.ROOMS.get(env.ROOMS.idFromName(code));
  return room.fetch(new Request(`https://room${path}`, { method: "POST", body: text }));
}

async function listRooms(request: Request, env: Env): Promise<Response> {
  const text = await body(request);
  const parsed = text === null ? null : parseListRequest(text);
  if (parsed === null) return json({ error: "bad_request" }, 400);
  // No password: the public rooms (CoopNet's public lobbies). One: the rooms that have it (its private lobbies).
  const asker = request.headers.get("cf-connecting-ip") ?? "";
  const rooms = await directory(env).list(parsed.game, await secretOf(parsed.password), await sha256(asker));
  return rooms === null ? json({ error: "busy" }, 429) : json({ rooms });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/host" && request.method === "GET") return hostRoom(request, env);
    if (request.method === "POST" && (url.pathname === "/v1/join" || url.pathname === "/v1/report")) {
      const text = await body(request);
      if (text === null) return json({ error: "bad_request" }, 400);
      const join = url.pathname === "/v1/join";
      const code = join ? parseJoinRequest(text)?.code ?? null : parseReport(text)?.code ?? null;
      return toRoom(request, env, join ? "/join" : "/report", code, text);
    }
    if (url.pathname === "/v1/list" && request.method === "POST") return listRooms(request, env);
    if (url.pathname === "/v1/stats" && request.method === "GET") return json(await directory(env).stats());
    if (url.pathname === "/" || url.pathname === "/v1/health") {
      return json({ service: "NebulaNet", protocol: PROTOCOL, min_protocol: MIN_PROTOCOL });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
