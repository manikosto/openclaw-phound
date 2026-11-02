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

test("the agent tools' copy of the plugin sees the channel copy's connected account", async () => {
  // OpenClaw loads the plugin into separate module copies for the channel and for the agent
  // tools; a query string gives this test a second copy of each module the same way.
  const channelCopy = await import("../src/bridge.js?copy=channel");
  const toolsCopy = await import("../src/bridge.js?copy=tools");
  assert.notEqual(channelCopy.setActiveBridge, toolsCopy.setActiveBridge, "two module copies");
  const fakeBridge = { running: true } as unknown as Parameters<typeof channelCopy.setActiveBridge>[1];
  channelCopy.setActiveBridge("acct-shared", fakeBridge);
  try {
    assert.equal(toolsCopy.getActiveBridge("acct-shared"), fakeBridge);
    assert.ok(toolsCopy.listActiveBridges().includes(fakeBridge!));
  } finally {
    channelCopy.setActiveBridge("acct-shared", undefined);
  }
  assert.throws(() => toolsCopy.getActiveBridge("acct-shared"), /not connected/);
});

