import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_CANDIDATES,
  MAX_LISTED,
  applyUpdate,
  hasRoom,
  listedRoom,
  makeCode,
  normalizeCode,
  parseCandidate,
  parseCandidates,
  parseHostMessage,
  parseJoinRequest,
  parseListRequest,
  parseReport,
  sortListed,
} from "../src/protocol.ts";

test("codes use the readable alphabet only", () => {
  let seed = 7;
  const random = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; ++i) bytes[i] = (seed = (seed * 1103515245 + 12345) & 0xff);
  };
  for (let i = 0; i < 200; ++i) {
    const code = makeCode(random);
    assert.equal(code.length, CODE_LENGTH);
    for (const letter of code) assert.ok(CODE_ALPHABET.includes(letter), code);
  }
  assert.ok(!/[01IO]/.test(CODE_ALPHABET));
});

test("codes are read as players type them", () => {
  assert.equal(normalizeCode("k7qx2m"), "K7QX2M");
  assert.equal(normalizeCode(" K7Q-X2M "), "K7QX2M");
  assert.equal(normalizeCode("K7QX2"), null);
  assert.equal(normalizeCode("K7QX2O"), null, "O is not in the alphabet");
  assert.equal(normalizeCode(123456), null);
});

test("candidates are IP addresses and ports", () => {
  assert.equal(parseCandidate("203.0.113.5:61000"), "203.0.113.5:61000");
  assert.equal(parseCandidate("[2001:DB8::9]:7777"), "[2001:db8::9]:7777");
  assert.equal(parseCandidate("[::ffff:192.168.1.4]:7777"), "[::ffff:192.168.1.4]:7777");
  assert.equal(parseCandidate("[1:2:3:4:5:6:7:8]:1"), "[1:2:3:4:5:6:7:8]:1");
  assert.equal(parseCandidate("example.com:7777"), null, "names are not taken");
  assert.equal(parseCandidate("256.0.0.1:7777"), null);
  assert.equal(parseCandidate("1.2.3.4:0"), null);
  assert.equal(parseCandidate("1.2.3.4:70000"), null);
  assert.equal(parseCandidate("1.2.3.4"), null);
  assert.equal(parseCandidate("[1::2::3]:7777"), null);
  assert.equal(parseCandidate("[1:2:3:4:5:6:7]:7777"), null);
  assert.deepEqual(parseCandidates(["1.2.3.4:5", "1.2.3.4:5", "10.0.0.2:5"]), ["1.2.3.4:5", "10.0.0.2:5"]);
  assert.equal(parseCandidates([]), null);
  assert.equal(parseCandidates(Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => `1.2.3.4:${i + 1}`)), null);
  assert.equal(parseCandidates(["1.2.3.4:5", "nope"]), null);
});

test("a host opens a room and updates it", () => {
  const open = parseHostMessage(JSON.stringify({
    t: "open", game: "Nebula", version: "1.4.0 abc", name: "  Mario\u0007 ", players: 1, max: 8,
    candidates: ["198.51.100.7:61000", "192.168.1.20:7777"],
  }));
  assert.deepEqual(open, {
    t: "open",
    room: {
      game: "Nebula", version: "1.4.0 abc", name: "Mario", mode: "", description: "", players: 1, max: 8,
      candidates: ["198.51.100.7:61000", "192.168.1.20:7777"],
    },
    password: "",
    protocol: 1,
  }, "a protocol 1 game's open still works");
  const full = parseHostMessage(JSON.stringify({
    t: "open", protocol: 2, game: "Nebula", version: "1", name: "Room", mode: "CO-OP", description: "Mods: A",
    password: " secret ", players: 2, max: 4, candidates: ["198.51.100.7:61000"],
  }));
  assert.ok(full !== null && full.t === "open");
  assert.equal(full.password, " secret ", "a password is kept exactly");
  assert.equal(full.room.mode, "CO-OP");
  assert.equal(full.room.description, "Mods: A");
  assert.equal(full.protocol, 2);
  assert.deepEqual(parseHostMessage('{"t":"update","players":3}'), { t: "update", update: { players: 3 } });
  assert.deepEqual(parseHostMessage('{"t":"update","name":"New","description":""}'),
                   { t: "update", update: { name: "New", description: "" } });
  assert.equal(parseHostMessage('{"t":"update"}'), null, "an update changes something");
  assert.equal(parseHostMessage('{"t":"update","name":""}'), null, "a room keeps a name");
  assert.equal(parseHostMessage('{"t":"update","players":0}'), null);
  assert.equal(parseHostMessage('{"t":"open","game":"Nebula","version":"1","name":"A","max":9,"players":10,' +
                                 '"candidates":["1.2.3.4:5"]}'), null, "more players than the room holds");
  assert.equal(parseHostMessage('{"t":"open","game":"Nebula","version":"1","name":"","max":8,' +
                                 '"candidates":["1.2.3.4:5"]}'), null, "a name is needed");
  assert.equal(parseHostMessage(JSON.stringify({
    t: "open", game: "Nebula", version: "1", name: "A", max: 8, password: "x".repeat(65), candidates: ["1.2.3.4:5"],
  })), null, "passwords are at most 64 characters");
  assert.equal(parseHostMessage("not json"), null);
  assert.equal(parseHostMessage("[1,2]"), null);
  assert.equal(parseHostMessage(`{"t":"open","name":"${"x".repeat(5000)}"}`), null);
});

test("updates change only what they name, players within the room", () => {
  const room = {
    game: "Nebula", version: "1", name: "A", mode: "", description: "", players: 2, max: 4, candidates: ["1.2.3.4:5"],
  };
  assert.deepEqual(applyUpdate(room, { players: 9 }), { ...room, players: 4 });
  assert.deepEqual(applyUpdate(room, { name: "B", mode: "PVP" }), { ...room, name: "B", mode: "PVP" });
});

test("a joiner asks by code with its own addresses and the password", () => {
  assert.deepEqual(parseJoinRequest('{"code":"k7qx2m","candidates":["203.0.113.9:50000"]}'),
                   { code: "K7QX2M", candidates: ["203.0.113.9:50000"], password: "", protocol: 1 });
  assert.deepEqual(parseJoinRequest('{"code":"K7QX2M","candidates":["203.0.113.9:50000"],"password":"pw",' +
                                    '"protocol":2}'),
                   { code: "K7QX2M", candidates: ["203.0.113.9:50000"], password: "pw", protocol: 2 });
  assert.equal(parseJoinRequest('{"code":"k7qx2m","candidates":[]}'), null);
  assert.equal(parseJoinRequest('{"code":"nope","candidates":["203.0.113.9:50000"]}'), null);
  assert.equal(parseJoinRequest('{"code":"K7QX2M","candidates":["203.0.113.9:50000"],"password":7}'), null);
});

test("lists ask for a game's rooms, public or by password", () => {
  assert.deepEqual(parseListRequest("{}"), { game: "Nebula", password: "" });
  assert.deepEqual(parseListRequest('{"game":"Nebula","password":"pw"}'), { game: "Nebula", password: "pw" });
  assert.equal(parseListRequest('{"password":"a\nb"}'), null);
});

test("the list shows rooms without their addresses, fullest first and full ones last", () => {
  const room = {
    game: "Nebula", version: "1", name: "A", mode: "", description: "", players: 2, max: 4, candidates: ["1.2.3.4:5"],
  };
  const listed = listedRoom("K7QX2M", room, true);
  assert.equal(JSON.stringify(listed).includes("1.2.3.4"), false);
  assert.equal(listed.private, true);
  const sorted = sortListed([
    listedRoom("AAAAAA", { ...room, players: 4 }, false),
    listedRoom("BBBBBB", { ...room, players: 1 }, false),
    listedRoom("CCCCCC", { ...room, players: 3 }, false),
  ]);
  assert.deepEqual(sorted.map((r) => r.code), ["CCCCCC", "BBBBBB", "AAAAAA"]);
  const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => listedRoom(`K${i}`, room, false));
  assert.equal(sortListed(many).length, MAX_LISTED);
});

test("joiners report how a join went", () => {
  assert.deepEqual(parseReport('{"code":"k7qx2m","ok":true}'), { code: "K7QX2M", ok: true, candidates: [] });
  assert.deepEqual(parseReport('{"code":"K7QX2M","ok":false,"candidates":["203.0.113.9:50000"]}'),
                   { code: "K7QX2M", ok: false, candidates: ["203.0.113.9:50000"] });
  assert.equal(parseReport('{"code":"K7QX2M"}'), null);
});

test("a room is full at its size", () => {
  const room = {
    game: "Nebula", version: "1", name: "A", mode: "", description: "", players: 7, max: 8, candidates: ["1.2.3.4:5"],
  };
  assert.ok(hasRoom(room));
  assert.ok(!hasRoom({ ...room, players: 8 }));
});
