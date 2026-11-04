// NebulaNet's protocol: what a host and a joiner send, checked before anything else sees it. Pure functions with no
// Cloudflare APIs, so the tests run them under plain Node.
//
// A host keeps a WebSocket open to /v1/host for as long as its room is open:
//   host -> NebulaNet  {"t":"open","game":"Nebula","version":"…","name":"…","players":1,"max":8,"candidates":[…]}
//   NebulaNet -> host  {"t":"room","code":"K7QX2M"}
//   NebulaNet -> host  {"t":"joiner","candidates":[…]}      someone is joining: punch toward these addresses
//   host -> NebulaNet  {"t":"update","players":3}           the room's player count changed
//   NebulaNet -> host  {"t":"error","error":"…"}            then the socket closes
//   "ping" -> "pong"                                         a keepalive answered without waking the room
// A joiner asks once, over HTTPS:
//   POST /v1/join {"code":"K7QX2M","candidates":[…]}
//   200 {"name":"…","game":"Nebula","version":"…","players":3,"max":8,"candidates":[…]}  the host's addresses
//   404 {"error":"not_found"}, 409 {"error":"full"}, 400 {"error":"bad_request"}, 429 {"error":"busy"}
//
// A candidate is an address a side's game socket may be reached at: "203.0.113.5:61000" or "[2001:db8::9]:61000".
// The first is its public address as a STUN server saw it; the others its addresses on its own network.

export const PROTOCOL = 1;
export const GAME = "Nebula";

// Room codes: no 0/O or 1/I, so a code read aloud or off a screen can't be mistyped into another.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;

export const MAX_CANDIDATES = 6;
export const MAX_NAME = 32;
export const MAX_VERSION = 64;
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

function count(input: unknown, min: number, max: number): number | null {
  return typeof input === "number" && Number.isInteger(input) && input >= min && input <= max ? input : null;
}

export interface Room {
  game: string;
  version: string;
  name: string;
  players: number;
  max: number;
  candidates: string[];
}

export type HostMessage = { t: "open"; room: Room } | { t: "update"; players: number };

// A host's message, or null when it isn't a valid one.
export function parseHostMessage(raw: string): HostMessage | null {
  if (raw.length > MAX_MESSAGE) return null;
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    message = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (message.t === "open") {
    const max = count(message.max, 2, MAX_PLAYERS);
    const players = max === null ? null : count(message.players ?? 1, 1, max);
    const room = {
      game: text(message.game, 32),
      version: text(message.version, MAX_VERSION),
      name: text(message.name, MAX_NAME),
      candidates: parseCandidates(message.candidates),
    };
    if (max === null || players === null || room.game === null || room.version === null || room.name === null ||
        room.candidates === null) {
      return null;
    }
    return {
      t: "open",
      room: { game: room.game, version: room.version, name: room.name, players, max, candidates: room.candidates },
    };
  }
  if (message.t === "update") {
    const players = count(message.players, 1, MAX_PLAYERS);
    return players === null ? null : { t: "update", players };
  }
  return null;
}

export interface JoinRequest {
  code: string;
  candidates: string[];
}

export function parseJoinRequest(raw: string): JoinRequest | null {
  if (raw.length > MAX_MESSAGE) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    const code = normalizeCode(body.code);
    const candidates = parseCandidates(body.candidates);
    return code === null || candidates === null ? null : { code, candidates };
  } catch {
    return null;
  }
}

// What a joiner hears of the room it asked for.
export function joinAnswer(room: Room): Room {
  return { ...room, candidates: [...room.candidates] };
}

// A room takes a join while it has room for one more.
export function hasRoom(room: Room): boolean {
  return room.players < room.max;
}
