import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
// ws ships with openclaw; it stands in for the Phound call stream here.
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { PhoundBridge } from "../src/bridge.js";
import type { ResolvedPhoundAccount } from "../src/types.js";
import { PhoundCallSession } from "../src/voice/call-session.js";
import type { VoiceEngineParams } from "../src/voice/engine.js";

const RATE = 16000;
const FRAME = 320;

const account: ResolvedPhoundAccount = {
  accountId: "test",
  enabled: true,
  token: "x",
  sbc: "",
  personaUid: "bot",
  pythonCommand: [],
  dmPolicy: "pairing",
  allowFrom: [],
  textChunkLimit: 4000,
  voice: { enabled: true, greeting: "", toolPolicy: "safe-read-only", phoneToolPolicy: "none", callPolicy: "allowlist", callAllow: [] },
};

function tone(samples: number, rate: number, amplitude = 6000): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  return buf;
}

function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

test("a call only carries audio between the Phound stream and OpenClaw's voice engine", async () => {
  let engineParams: VoiceEngineParams | undefined;
  let engineInBytes = 0;
  let engineClosed = false;
  const routedPeers: string[] = [];
  const bridgeCommands: string[] = [];
  const bridge = {
    account,
    request: async (cmd: string) => {
      bridgeCommands.push(cmd);
      return {};
    },
  } as unknown as PhoundBridge;
  const channelRuntime = {
    routing: {
      resolveAgentRoute: ({ peer }: { peer: { id: string } }) => {
        routedPeers.push(peer.id);
        return { agentId: "main", sessionKey: `agent:main:phound:direct:${peer.id}` };
      },
    },
  };

  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const connected = once(server, "connection");
  const outFrames: Buffer[] = [];
  const commands: string[] = [];

  const session = new PhoundCallSession({
    cfg: {} as never,
    bridge,
    channelRuntime: channelRuntime as never,
    callId: "2",
    direction: "inbound",
    peer: { id: "+15551234567", name: "Alice", sessionId: "call:+15551234567" },
    conversational: true,
    startEngine: async (params) => {
      engineParams = params;
      return {
        sendAudio: (pcm24k) => {
          engineInBytes += pcm24k.length;
        },
        close: () => {
          engineClosed = true;
        },
      };
    },
  });
  session.attachStream(`ws://127.0.0.1:${port}/2`, RATE, FRAME);
  const [socket] = (await connected) as [ServerSocket];
  socket.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "audio") {
      outFrames.push(Buffer.from(msg.payload, "base64"));
    } else if (msg.type === "command") {
      commands.push(msg.payload);
    }
  });

  try {
    await waitFor(() => engineParams !== undefined);
    // Caller ID is not identity: a call from a number is its own session and sender.
    assert.deepEqual(routedPeers, ["call:+15551234567"]);
    assert.equal(engineParams!.route.sessionKey, "agent:main:phound:direct:call:+15551234567");
    assert.equal(engineParams!.caller.id, "call:+15551234567");
    assert.equal(engineParams!.notifyOnly, false);
    // ...and gets none of the agent's tools: its caller ID could be spoofed.
    assert.equal(engineParams!.toolPolicy, "none");

    // One second of caller audio at 16 kHz reaches the engine as ~one second at 24 kHz.
    for (let n = 0; n < 50; n++) {
      socket.send(JSON.stringify({ type: "audio", payload: tone(FRAME, RATE).toString("base64") }));
    }
    await waitFor(() => engineInBytes > 0.9 * 24000 * 2);

    // Half a second of engine speech at 24 kHz comes out as 20 ms frames at 16 kHz.
    engineParams!.output.sendAudio(tone(12000, 24000));
    await waitFor(() => outFrames.some((f) => f.readInt16LE(200) !== 0));
    await session.drained();
    assert.ok(outFrames.every((f) => f.length === FRAME * 2), "every frame is 20 ms of 16 kHz PCM16");
    const voiced = outFrames.filter((f) => f.some((byte) => byte !== 0)).length;
    assert.ok(voiced >= 22 && voiced <= 26, `~25 voiced frames, got ${voiced}`);

    // Barge-in from the engine: playback stops here and on the platform.
    engineParams!.output.sendAudio(tone(48000, 24000));
    await waitFor(() => outFrames.slice(-3).some((f) => f.some((byte) => byte !== 0)));
    engineParams!.output.clearAudio();
    await waitFor(() => commands.includes("reset-audio"));
    const sentAfterClear = outFrames.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(outFrames.slice(sentAfterClear + 1).every((f) => f.every((byte) => byte === 0)), "silence after barge-in");

    // The engine ends the call: the bridge is told to hang up.
    engineParams!.output.hangup();
    await waitFor(() => bridgeCommands.includes("hangup"), 3000);
  } finally {
    session.close();
    server.close();
  }
  assert.equal(engineClosed, true);
});
