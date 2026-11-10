// The room list (CoopNet's LOBBY_LIST_GET, its private lobbies) and NebulaNet's numbers (CoopNet's metrics): one
// Durable Object that every private room tells when it opens, changes and closes. Rooms without a password aren't
// listed at all: they are joined by their code. A room it hasn't heard from for EXPIRE_MS is taken off, so a room
// whose Durable Object went away without saying so doesn't stay listed.
import { DurableObject } from "cloudflare:workers";
import { type ListedRoom, sortListed } from "./protocol.ts";

// A listed room refreshes its entry every REFRESH_MS (index.ts); this many missed refreshes and it's gone.
export const EXPIRE_MS = 16 * 60_000;
// Lists one address may ask for a minute.
const LISTS_PER_MINUTE = 30;
// How long the numbers are kept.
const KEEP_HOURS = 90 * 24;
const HOUR_MS = 3_600_000;

// What a room tells the directory. `secret` is its password's hash, "" for a public room.
export interface Entry {
  room: ListedRoom;
  game: string;
  secret: string;
}

export interface Numbers {
  rooms: number;
  players: number;
}

// The most rooms and players open at once in an hour or a day, and the joins in it: made, and failed (the joiner
// couldn't reach the host).
export interface Period extends Numbers {
  joins: number;
  failed: number;
}

export interface Stats {
  current: Numbers;
  // The latest last.
  hourly: (Period & { hour: string })[];
  daily: (Period & { day: string })[];
}

export class LobbyDirectory extends DurableObject<Record<string, never>> {
  private lists = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, game TEXT NOT NULL, secret TEXT NOT NULL, room TEXT NOT NULL, players INTEGER NOT NULL,
      seen INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hours (
      hour INTEGER PRIMARY KEY, rooms INTEGER NOT NULL, players INTEGER NOT NULL, joins INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0)`);
  }

  // A room opened, changed or is still open.
  put(entry: Entry): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, game, secret, room, players, seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET game = excluded.game, secret = excluded.secret, room = excluded.room,
       players = excluded.players, seen = excluded.seen`,
      entry.room.code, entry.game, entry.secret, JSON.stringify(entry.room), entry.room.players, now);
    this.count(now);
  }

  // A room closed.
  remove(code: string): void {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE code = ?", code);
  }

  // The rooms of `game` with `secret` (a password's hash; "" for the public ones). Null when `asker` (an address)
  // asked too often.
  list(game: string, secret: string, asker: string): ListedRoom[] | null {
    const now = Date.now();
    const asked = (this.lists.get(asker) ?? []).filter((at) => now - at < 60_000);
    if (asked.length >= LISTS_PER_MINUTE) return null;
    asked.push(now);
    this.lists.set(asker, asked);
    if (this.lists.size > 10_000) this.lists.clear();  // memory stays bounded; the limit is a courtesy
    this.expire(now);
    const rows = this.ctx.storage.sql.exec<{ room: string }>(
      "SELECT room FROM rooms WHERE game = ? AND secret = ?", game, secret).toArray();
    return sortListed(rows.map((row) => JSON.parse(row.room) as ListedRoom));
  }

  // A join went through (ok) or failed.
  joined(ok: boolean): void {
    const now = Date.now();
    this.count(now);
    this.ctx.storage.sql.exec(
      `UPDATE hours SET joins = joins + ?, failed = failed + ? WHERE hour = ?`,
      ok ? 1 : 0, ok ? 0 : 1, Math.floor(now / HOUR_MS));
  }

  stats(): Stats {
    const now = Date.now();
    this.expire(now);
    const current = this.current();
    type Row = { hour: number; rooms: number; players: number; joins: number; failed: number };
    const hours = this.ctx.storage.sql.exec<Row>(
      "SELECT hour, rooms, players, joins, failed FROM hours WHERE hour >= ? ORDER BY hour",
      Math.floor(now / HOUR_MS) - KEEP_HOURS).toArray();
    const hourly = hours.slice(-48).map((row) => ({
      hour: new Date(row.hour * HOUR_MS).toISOString(),
      rooms: row.rooms,
      players: row.players,
      joins: row.joins,
      failed: row.failed,
    }));
    const days = new Map<string, Period>();
    for (const row of hours) {
      const day = new Date(row.hour * HOUR_MS).toISOString().slice(0, 10);
      const most = days.get(day) ?? { rooms: 0, players: 0, joins: 0, failed: 0 };
      days.set(day, {
        rooms: Math.max(most.rooms, row.rooms),
        players: Math.max(most.players, row.players),
        joins: most.joins + row.joins,
        failed: most.failed + row.failed,
      });
    }
    const daily = [...days].slice(-30).map(([day, period]) => ({ day, ...period }));
    return { current, hourly, daily };
  }

  private current(): Numbers {
    const row = this.ctx.storage.sql.exec<{ rooms: number; players: number | null }>(
      "SELECT COUNT(*) AS rooms, SUM(players) AS players FROM rooms").one();
    return { rooms: row.rooms, players: row.players ?? 0 };
  }

  private expire(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE seen < ?", now - EXPIRE_MS);
  }

  // This hour's most rooms and players.
  private count(now: number): void {
    this.expire(now);
    const { rooms, players } = this.current();
    const hour = Math.floor(now / HOUR_MS);
    this.ctx.storage.sql.exec(
      `INSERT INTO hours (hour, rooms, players) VALUES (?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET rooms = MAX(rooms, excluded.rooms), players = MAX(players, excluded.players)`,
      hour, rooms, players);
    this.ctx.storage.sql.exec("DELETE FROM hours WHERE hour < ?", hour - KEEP_HOURS);
  }
}
