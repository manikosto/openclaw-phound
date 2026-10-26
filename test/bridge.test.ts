import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PhoundBridge } from "../src/bridge.js";
import type { ResolvedPhoundAccount } from "../src/types.js";

// The real bridge script, run against test/fake_phound instead of the SDK.
process.env.PYTHONPATH = fileURLToPath(new URL("./fake_phound/", import.meta.url));

const account: ResolvedPhoundAccount = {
  accountId: "test",
  enabled: true,
  token: "fake",
  sbc: "",
  personaUid: "",
  pythonCommand: ["python3"],
  dmPolicy: "pairing",
  allowFrom: [],
  textChunkLimit: 4000,
  voice: { enabled: true, greeting: "", toolPolicy: "safe-read-only", phoneToolPolicy: "none", callPolicy: "allowlist", callAllow: [] },
};

test("bridge carries chat and call events and commands both ways", async () => {
  process.env.OPENAI_API_KEY = "must-not-reach-the-bridge";
  const stderr: string[] = [];
  const bridge = new PhoundBridge(account, { debug: (line) => stderr.push(line) });
  const message = once(bridge, "message");
  const incoming = once(bridge, "call_incoming");
  const stream = once(bridge, "call_stream");
  await bridge.start();

  const [msg] = await message;
  assert.equal(msg.text, "hello bot");
  assert.equal(msg.chat_id, "chat-1");
  assert.equal(msg.from_number, "+15551234567");

  const [call] = await incoming;
  assert.equal(call.call_id, "call-1");
  await bridge.request("call_decision", { call_id: call.call_id, accept: true });
  const [streamEvent] = await stream;
  assert.equal(streamEvent.url, "ws://127.0.0.1:1/fake-stream");
  assert.equal(streamEvent.rate, 16000);

  await bridge.request("send", { chat_id: "chat-1", from_persona_uid: "bot-persona", text: "hi", markdown: true });
  await bridge.request("send", { chat_id: "chat-x", from_persona_uid: "bot-persona", text: "hey", markdown: false });
  await bridge.request("call", { from_persona_uid: "bot-persona", number: "+15557654321" });
  await assert.rejects(bridge.request("nope"), /unknown command/);
  await assert.rejects(bridge.request("hangup", { call_id: "missing" }), /call not found/);
  await bridge.request("hangup", { call_id: "call-1" });
  await bridge.stop();

  const log = stderr.join("\n");
  assert.match(log, /FAKE env-openai False/, "gateway secrets stay out of the bridge");
  assert.match(log, /FAKE answer/);
  assert.match(log, /FAKE start-stream pcm 16000 320/);
  assert.match(log, /FAKE handler-send chat-1 'hi' 3/);
  assert.match(log, /FAKE process-send 'hey' bot-persona chat-x {2}1/);
  assert.match(log, /FAKE make-call bot-persona \+15557654321/);
  assert.match(log, /FAKE hangup/);
  assert.equal(bridge.running, false);
});
