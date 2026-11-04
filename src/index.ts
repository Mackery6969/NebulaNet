// NebulaNet: introduces Nebula co-op players so nobody forwards a port (Nebula's docs/COOP_PLAN.md, "Hosting").
// It never carries game traffic: a host gets a room code, a joiner asks for that code, and each learns the other's
// addresses so both games can punch through their routers. See protocol.ts for the messages.
//
// Each room is a Durable Object named by its code. Its host's WebSocket uses the hibernation API, so an open room
// that nobody is joining costs nothing while it waits.
import { DurableObject } from "cloudflare:workers";
import {
  GAME,
  MAX_MESSAGE,
  PROTOCOL,
  type Room,
  hasRoom,
  joinAnswer,
  makeCode,
  parseHostMessage,
  parseJoinRequest,
} from "./protocol.ts";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
}

// How many codes to try before giving up on finding a free one (each taken one is 1 in a billion).
const CODE_TRIES = 5;
// Joins one room takes per minute, against someone hammering a code.
const JOINS_PER_MINUTE = 30;
// How long a host has to say "open" before its socket is closed.
const OPEN_WITHIN_MS = 15_000;

// What a host's socket keeps through hibernation.
interface HostAttachment {
  code: string;
  opened: number;  // when the socket was accepted (ms)
  room: Room | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export class RoomObject extends DurableObject<Env> {
  private joins: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives answered by Cloudflare itself, without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private host(): WebSocket | null {
    return this.ctx.getWebSockets("host")[0] ?? null;
  }

  private attachment(socket: WebSocket): HostAttachment | null {
    return (socket.deserializeAttachment() as HostAttachment | null) ?? null;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = request.headers.get("x-nebulanet-code") ?? "";
    if (url.pathname === "/host") return this.acceptHost(code);
    if (url.pathname === "/join") return this.join(await request.text());
    return json({ error: "not_found" }, 404);
  }

  private acceptHost(code: string): Response {
    // A code already in use: the Worker tries another.
    if (this.host() !== null) return json({ error: "taken" }, 409);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["host"]);
    const attachment: HostAttachment = { code, opened: Date.now(), room: null };
    server.serializeAttachment(attachment);
    // A host that never says "open" is closed.
    void this.ctx.storage.setAlarm(Date.now() + OPEN_WITHIN_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    const host = this.host();
    if (host === null) return;
    const attachment = this.attachment(host);
    if (attachment !== null && attachment.room === null) host.close(4000, "no open");
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (attachment === null) return;
    const message = typeof raw === "string" ? parseHostMessage(raw) : null;
    if (message === null) {
      socket.send(JSON.stringify({ t: "error", error: "bad_message" }));
      socket.close(4001, "bad message");
      return;
    }
    if (message.t === "open") {
      if (message.room.game !== GAME) {
        socket.send(JSON.stringify({ t: "error", error: "bad_game" }));
        socket.close(4002, "bad game");
        return;
      }
      attachment.room = message.room;
      socket.serializeAttachment(attachment);
      socket.send(JSON.stringify({ t: "room", code: attachment.code, protocol: PROTOCOL }));
      return;
    }
    if (attachment.room === null) return;
    attachment.room.players = Math.min(message.players, attachment.room.max);
    socket.serializeAttachment(attachment);
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // The room ends with its host's socket. 1005/1006 carry no code to echo back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  private join(raw: string): Response {
    const request = parseJoinRequest(raw);
    if (request === null) return json({ error: "bad_request" }, 400);
    const host = this.host();
    const room = host === null ? null : this.attachment(host)?.room ?? null;
    if (host === null || room === null) return json({ error: "not_found" }, 404);
    const now = Date.now();
    this.joins = this.joins.filter((at) => now - at < 60_000);
    if (this.joins.length >= JOINS_PER_MINUTE) return json({ error: "busy" }, 429);
    this.joins.push(now);
    if (!hasRoom(room)) return json({ error: "full" }, 409);
    // The host starts punching toward the joiner while the joiner starts saying hello.
    host.send(JSON.stringify({ t: "joiner", candidates: request.candidates }));
    return json(joinAnswer(room));
  }
}

async function hostRoom(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_expected" }, 426);
  }
  for (let i = 0; i < CODE_TRIES; ++i) {
    const code = makeCode((bytes) => crypto.getRandomValues(bytes));
    const room = env.ROOMS.get(env.ROOMS.idFromName(code));
    const headers = new Headers(request.headers);
    headers.set("x-nebulanet-code", code);
    const answer = await room.fetch(new Request("https://room/host", { headers }));
    if (answer.status !== 409) return answer;
  }
  return json({ error: "busy" }, 503);
}

async function joinRoom(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_MESSAGE) return json({ error: "bad_request" }, 400);
  const body = await request.text();
  const parsed = parseJoinRequest(body);
  if (parsed === null) return json({ error: "bad_request" }, 400);
  const room = env.ROOMS.get(env.ROOMS.idFromName(parsed.code));
  return room.fetch(new Request("https://room/join", { method: "POST", body }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/host" && request.method === "GET") return hostRoom(request, env);
    if (url.pathname === "/v1/join" && request.method === "POST") return joinRoom(request, env);
    if (url.pathname === "/" || url.pathname === "/v1/health") {
      return json({ service: "NebulaNet", protocol: PROTOCOL });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
