import assert from "node:assert/strict";
import { test } from "node:test";

test("phound_call only dials allowed numbers unless the operator opens it up", async () => {
  const { assertCallAllowed } = await import("../src/gateway.js");
  const strict = { callPolicy: "allowlist" as const, callAllow: ["+15550001111"] };
  assert.throws(() => assertCallAllowed(strict, "+19005550000", false), /not allowed/);
  assert.doesNotThrow(() => assertCallAllowed(strict, "+15550001111", false));
  assert.doesNotThrow(() => assertCallAllowed(strict, "+15552223333", true));
  assert.doesNotThrow(() => assertCallAllowed({ callPolicy: "any", callAllow: [] }, "+19005550000", false));
});

test("persona uids are digits too: only a leading + makes a phone number", async () => {
  const { normalizeAllowEntry, parsePhoundTarget, phoundSenderId } = await import("../src/targets.js");
  assert.equal(normalizeAllowEntry("123456789012"), "123456789012");
  assert.equal(normalizeAllowEntry("persona:123456789012"), "123456789012");
  assert.equal(normalizeAllowEntry("+1 (555) 123-4567"), "+15551234567");
  // What pairing stores must be what a chat message from that persona is checked as.
  assert.equal(normalizeAllowEntry(phoundSenderId({ fromUid: "123456789012" })), "123456789012");
  assert.deepEqual(parsePhoundTarget("123456789013"), { kind: "persona", personaUid: "123456789013" });
  assert.deepEqual(parsePhoundTarget("+15551234567"), { kind: "phone", number: "+15551234567" });
  assert.deepEqual(parsePhoundTarget("phound:chat:abc"), { kind: "chat", chatId: "abc" });
});

test("phound_call finds contacts by name or number, and nothing else by name", async () => {
  const { resolveCallTarget } = await import("../src/gateway.js");
  const mom = { name: "Mom", number: "+15550001111", note: "Lives in Boston" };
  const contacts = [mom];
  assert.deepEqual(resolveCallTarget(contacts, " mom "), { number: "+15550001111", contact: mom });
  assert.deepEqual(resolveCallTarget(contacts, "+1 (555) 000-1111"), { number: "+15550001111", contact: mom });
  assert.deepEqual(resolveCallTarget(contacts, "+15552223333"), { number: "+15552223333", contact: undefined });
  assert.throws(() => resolveCallTarget(contacts, "Dad"), /Contacts: Mom/);
  assert.throws(() => resolveCallTarget([], "Dad 15552223333"), /no contacts are set/);
});

test("contacts from the config are normalized, and unusable ones dropped", async () => {
  const { resolvePhoundAccount } = await import("../src/accounts.js");
  const account = resolvePhoundAccount({
    channels: {
      phound: {
        token: "1.abc",
        contacts: [
          { name: " Mom ", number: "+1 (555) 000-1111", note: " Lives in Boston " },
          { name: "Nobody", number: "call me" },
          { name: " ", number: "+15552223333" },
        ],
      },
    },
  } as never);
  assert.deepEqual(account.contacts, [{ name: "Mom", number: "+15550001111", note: "Lives in Boston" }]);
});

test("a Phound app caller with a number is known by persona; only PSTN callers by number", async () => {
  const { callSender } = await import("../src/gateway.js");
  const { phoundSenderId } = await import("../src/targets.js");
  // The platform sends RemoteNumber for a persona that has a number assigned.
  const app = callSender({ fromUid: "23559744", fromNumber: "+15551234567", name: "Owner" });
  assert.equal(app.id, "23559744");
  assert.equal(app.sessionId, undefined);
  // A PSTN caller has remote uid "0".
  const pstn = callSender({ fromUid: "0", fromNumber: "+15551234567" });
  assert.equal(pstn.id, "+15551234567");
  assert.equal(pstn.sessionId, "call:+15551234567");
  // An SMS sender without a persona is still known by number.
  assert.equal(phoundSenderId({ fromUid: "", fromNumber: "+1 555 123 4567" }), "+15551234567");
});

test("outbound media lands in a private temp file the SDK can type by extension", async () => {
  const { readFile, stat } = await import("node:fs/promises");
  const { writeMediaFile } = await import("../src/send.js");
  const jpg = await writeMediaFile({ buffer: Buffer.from("jpeg-bytes"), contentType: "image/jpeg", fileName: "cat---414616e9.jpeg" });
  assert.match(jpg, /cat---414616e9\.jpg$/);
  assert.equal(await readFile(jpg, "utf8"), "jpeg-bytes");
  assert.equal((await stat(jpg)).mode & 0o777, 0o600);
  // No usable name: a generic one, still with the extension of its content type.
  assert.match(await writeMediaFile({ buffer: Buffer.from("x"), contentType: "image/png; q=1", fileName: "../../" }), /\/attachment\.png$/);
  // Unknown content type keeps the original extension; path separators never survive.
  assert.match(await writeMediaFile({ buffer: Buffer.from("x"), fileName: "../evil/report.pdf" }), /\/report\.pdf$/);
});

