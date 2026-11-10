// NebulaNet's protocol: what a host and a joiner send, checked before anything else sees it. Pure functions with no
// Cloudflare APIs, so the tests run them under plain Node. It offers what sm64coopdx's CoopNet offers its games, for
// Nebula's star of players around a host: rooms with a name, mode, description and password, a list of the public
// ones (and of the private ones by their password), the host's updates, and joins checked against all that.
//
// A host keeps a WebSocket open to /v1/host for as long as its room is open (/v1/host?code=K7QX2M after a dropped
// connection asks for its code back):
//   host -> NebulaNet  {"t":"open","protocol":2,"game":"Nebula","version":"…","name":"…","mode":"…",
//                       "description":"…","password":"…","players":1,"max":8,"candidates":[…]}
//                       (mode, description and password may be left out; a password makes the room private)
//   NebulaNet -> host  {"t":"room","code":"K7QX2M","protocol":2}
//   NebulaNet -> host  {"t":"joiner","candidates":[…]}      someone is joining: punch toward these addresses
//   host -> NebulaNet  {"t":"update","players":3,"name":"…","mode":"…","description":"…"}  any of them, changed
//   NebulaNet -> host  {"t":"error","error":"…"}            then the socket closes
//   "ping" -> "pong"                                         a keepalive answered without waking the room; a host
//                                                            heard from for DEAD_AFTER_MS is closed
// A joiner asks once, over HTTPS:
//   POST /v1/join {"code":"K7QX2M","candidates":[…],"password":"…","protocol":2}
//   200 {"name":"…","game":"Nebula","version":"…","mode":"…","description":"…","players":3,"max":8,
//        "candidates":[…]}                                   the host's addresses
//   404 {"error":"not_found"}, 409 {"error":"full"}, 403 {"error":"wrong_password"}, 426 {"error":"old_game"},
//   400 {"error":"bad_request"}, 429 {"error":"busy"}
// Anyone may list the rooms:
//   POST /v1/list {"game":"Nebula","password":"…"}           no password: the public rooms; one: the private rooms
//                                                            that have it (CoopNet's private lobbies)
//   200 {"rooms":[{"code","name","version","mode","description","players","max","private"}…]}
//   POST /v1/report {"code":"K7QX2M","ok":false,"candidates":[…]}  how a join went (CoopNet's PEER_FAILED): the host
//                                                            hears {"t":"joiner_failed","candidates":[…]}
//   GET /v1/stats  {"current":{"rooms","players"},"hourly":[…],"daily":[…]}  CoopNet's metrics
// "room" and the join's answer also carry "ice": {"stun":[{"host","port"}…],"turn":[{"host","port","username",
// "password"}…]}, the STUN and TURN servers to use (CoopNet's MPACKET_STUN_TURN).
//
// A candidate is an address a side's game socket may be reached at: "203.0.113.5:61000" or "[2001:db8::9]:61000".
// The first is its public address as a STUN server saw it; the others its addresses on its own network.

export const PROTOCOL = 2;
// The oldest protocol a game may speak: older ones are told to update (CoopNet's MERR_COOPNET_VERSION).
export const MIN_PROTOCOL = 1;
export const GAME = "Nebula";

// Room codes: no 0/O or 1/I, so a code read aloud or off a screen can't be mistyped into another.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;

export const MAX_CANDIDATES = 6;
export const MAX_NAME = 32;
export const MAX_VERSION = 64;
export const MAX_MODE = 32;
export const MAX_DESCRIPTION = 256;
export const MAX_PASSWORD = 64;
// The most rooms one list answers.
export const MAX_LISTED = 100;
export const MAX_PLAYERS = 64;
// The longest message a host may send, and the longest join request body.
export const MAX_MESSAGE = 4096;

// `random` fills its argument with random bytes (crypto.getRandomValues).
export function makeCode(random: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  random(bytes);
  let code = "";
  // 256 is a multiple of 32: every letter equally likely.
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

// A code as a player typed it ("k7qx-2m", " K7QX2M "), or null when it can't be one.
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const letter of code) {
    if (!CODE_ALPHABET.includes(letter)) return null;
  }
  return code;
}

function isIPv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIPv6(text: string): boolean {
  if (text.length < 2 || text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return false;
  const doubles = text.split("::").length - 1;
  if (doubles > 1) return false;
  const groups = text.split(":").filter((group) => group !== "");
  // An IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const last = groups[groups.length - 1] ?? "";
  const count = groups.length + (last.includes(".") ? 1 : 0);
  if (last.includes(".") && !isIPv4(last)) return false;
  if (!groups.slice(0, last.includes(".") ? -1 : undefined).every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) {
    return false;
  }
  return doubles === 1 ? count < 8 : count === 8;
}

// "1.2.3.4:5678" or "[::1]:5678", tidied, or null when it isn't one.
export function parseCandidate(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  let host: string;
  let port: string;
  if (input.startsWith("[")) {
    const close = input.indexOf("]:");
    if (close < 0) return null;
    host = input.slice(1, close);
    port = input.slice(close + 2);
    if (!isIPv6(host)) return null;
  } else {
    const colon = input.lastIndexOf(":");
    if (colon < 0) return null;
    host = input.slice(0, colon);
    port = input.slice(colon + 1);
    if (!isIPv4(host)) return null;
  }
  if (!/^\d{1,5}$/.test(port)) return null;
  const number = Number(port);
  if (number < 1 || number > 65535) return null;
  return input.startsWith("[") ? `[${host.toLowerCase()}]:${number}` : `${host}:${number}`;
}

// The candidates a side sent: at least one, at most MAX_CANDIDATES, each valid, none twice.
export function parseCandidates(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CANDIDATES) return null;
  const out: string[] = [];
  for (const item of input) {
    const candidate = parseCandidate(item);
    if (candidate === null) return null;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function text(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  // Control characters out; the game shows names in its own font.
  const clean = input.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.length > 0 && clean.length <= max ? clean : null;
}

// Text that may be left out (or empty): "" then.
function optionalText(input: unknown, max: number): string | null {
  if (input === undefined || input === null || input === "") return "";
  return text(input, max);
}

// A password as typed: anything but control characters, kept exactly; "" for none.
function password(input: unknown): string | null {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string" || input.length > MAX_PASSWORD || /[\u0000-\u001f\u007f]/.test(input)) return null;
  return input;
}

function protocol(input: unknown): number | null {
  if (input === undefined) return 1;  // protocol 1 games didn't say
  return count(input, 1, 1_000_000);
}

function count(input: unknown, min: number, max: number): number | null {
  return typeof input === "number" && Number.isInteger(input) && input >= min && input <= max ? input : null;
}

function object(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_MESSAGE) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface Room {
  game: string;
  version: string;
  name: string;
  mode: string;
  description: string;
  players: number;
  max: number;
  candidates: string[];
}

// What a host may change while its room is open (CoopNet's LOBBY_UPDATE): only what it sent.
export interface RoomUpdate {
  players?: number;
  name?: string;
  mode?: string;
  description?: string;
}

export type HostMessage =
  | { t: "open"; room: Room; password: string; protocol: number }
  | { t: "update"; update: RoomUpdate };

// A host's message, or null when it isn't a valid one.
export function parseHostMessage(raw: string): HostMessage | null {
  const message = object(raw);
  if (message === null) return null;
  if (message.t === "open") {
    const max = count(message.max, 2, MAX_PLAYERS);
    const players = max === null ? null : count(message.players ?? 1, 1, max);
    const room = {
      game: text(message.game, 32),
      version: text(message.version, MAX_VERSION),
      name: text(message.name, MAX_NAME),
      mode: optionalText(message.mode, MAX_MODE),
      description: optionalText(message.description, MAX_DESCRIPTION),
      candidates: parseCandidates(message.candidates),
    };
    const secret = password(message.password);
    const spoken = protocol(message.protocol);
    if (max === null || players === null || room.game === null || room.version === null || room.name === null ||
        room.mode === null || room.description === null || room.candidates === null || secret === null ||
        spoken === null) {
      return null;
    }
    return {
      t: "open",
      room: {
        game: room.game,
        version: room.version,
        name: room.name,
        mode: room.mode,
        description: room.description,
        players,
        max,
        candidates: room.candidates,
      },
      password: secret,
      protocol: spoken,
    };
  }
  if (message.t === "update") {
    const update: RoomUpdate = {};
    if (message.players !== undefined) {
      const players = count(message.players, 1, MAX_PLAYERS);
      if (players === null) return null;
      update.players = players;
    }
    if (message.name !== undefined) {
      const name = text(message.name, MAX_NAME);
      if (name === null) return null;
      update.name = name;
    }
    for (const [key, max] of [["mode", MAX_MODE], ["description", MAX_DESCRIPTION]] as const) {
      if (message[key] === undefined) continue;
      const value = optionalText(message[key], max);
      if (value === null) return null;
      update[key] = value;
    }
    return Object.keys(update).length === 0 ? null : { t: "update", update };
  }
  return null;
}

// The room after its host's update. Players stay within its max.
export function applyUpdate(room: Room, update: RoomUpdate): Room {
  const next = { ...room, candidates: [...room.candidates] };
  if (update.players !== undefined) next.players = Math.min(update.players, room.max);
  if (update.name !== undefined) next.name = update.name;
  if (update.mode !== undefined) next.mode = update.mode;
  if (update.description !== undefined) next.description = update.description;
  return next;
}

export interface JoinRequest {
  code: string;
  candidates: string[];
  password: string;
  protocol: number;
}

export function parseJoinRequest(raw: string): JoinRequest | null {
  const body = object(raw);
  if (body === null) return null;
  const code = normalizeCode(body.code);
  const candidates = parseCandidates(body.candidates);
  const secret = password(body.password);
  const spoken = protocol(body.protocol);
  return code === null || candidates === null || secret === null || spoken === null
    ? null
    : { code, candidates, password: secret, protocol: spoken };
}

export interface ListRequest {
  game: string;
  password: string;
}

export function parseListRequest(raw: string): ListRequest | null {
  const body = object(raw);
  if (body === null) return null;
  const game = text(body.game ?? GAME, 32);
  const secret = password(body.password);
  return game === null || secret === null ? null : { game, password: secret };
}

// What a joiner hears of the room it asked for.
export function joinAnswer(room: Room): Room {
  return { ...room, candidates: [...room.candidates] };
}

// A room as the list shows it: never its addresses or password.
export interface ListedRoom {
  code: string;
  name: string;
  version: string;
  mode: string;
  description: string;
  players: number;
  max: number;
  private: boolean;
}

export function listedRoom(code: string, room: Room, locked: boolean): ListedRoom {
  return {
    code,
    name: room.name,
    version: room.version,
    mode: room.mode,
    description: room.description,
    players: room.players,
    max: room.max,
    private: locked,
  };
}

// The list's order: the fullest rooms that still have space first, then the full ones; by name within.
export function sortListed(rooms: ListedRoom[]): ListedRoom[] {
  const full = (room: ListedRoom) => (room.players >= room.max ? 1 : 0);
  return [...rooms]
    .sort((a, b) => full(a) - full(b) || b.players - a.players || a.name.localeCompare(b.name) ||
                    a.code.localeCompare(b.code))
    .slice(0, MAX_LISTED);
}

// A joiner's word on how its join went: ok, or it couldn't reach the host (its candidates, for the host's log).
export interface Report {
  code: string;
  ok: boolean;
  candidates: string[];
}

export function parseReport(raw: string): Report | null {
  const body = object(raw);
  if (body === null || typeof body.ok !== "boolean") return null;
  const code = normalizeCode(body.code);
  const candidates = body.candidates === undefined ? [] : parseCandidates(body.candidates);
  return code === null || candidates === null ? null : { code, ok: body.ok, candidates };
}

// A room takes a join while it has room for one more.
export function hasRoom(room: Room): boolean {
  return room.players < room.max;
}
