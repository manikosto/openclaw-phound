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
