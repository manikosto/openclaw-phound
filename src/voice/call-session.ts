import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createStreamingPcmResampler } from "openclaw/plugin-sdk/realtime-voice-provider";
import WebSocket from "ws";
import type { PhoundBridge, PhoundBridgeLog } from "../bridge.js";
import type { PhoundChannelRuntime, PhoundSender } from "../inbound.js";
import { ENGINE_SAMPLE_RATE, startVoiceEngine, type VoiceEngine, type VoiceEngineParams } from "./engine.js";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

export type CallDirection = "inbound" | "outbound";

export type PhoundCallSessionParams = {
  cfg: OpenClawConfig;
  bridge: PhoundBridge;
  channelRuntime: PhoundChannelRuntime;
  log?: PhoundBridgeLog;
  callId: string;
  direction: CallDirection;
  peer: PhoundSender;
  /** False when the agent may only deliver `opening` and hang up (callee not allowed to talk to it). */
  conversational: boolean;
  /** Outbound calls: the first line the agent says. */
  opening?: string;
  /** Outbound calls: why the agent is calling, for its own context. */
  purpose?: string;
  /** Replaces OpenClaw's voice engine in tests. */
  startEngine?: (params: VoiceEngineParams) => Promise<VoiceEngine>;
};

/**
 * One live call, as a transport: audio from the Phound stream goes to OpenClaw's
 * voice engine and the engine's audio comes back into the stream, resampled
 * between the stream's rate and the engine's 24 kHz and paced as 20 ms frames.
 * Nothing here listens, transcribes or speaks — that is all the engine.
 */
export class PhoundCallSession {
  readonly callId: string;
  readonly peer: PhoundSender;
  sessionKey = "";
  chatId = "";

  private ws?: WebSocket;
  private rate = 16000;
  private frameBytes = 640;
  private frameMs = 20;
  private silence = Buffer.alloc(640);
  private frames: Buffer[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private toEngine = createStreamingPcmResampler(16000, ENGINE_SAMPLE_RATE);
  private fromEngine = createStreamingPcmResampler(ENGINE_SAMPLE_RATE, 16000);
  private engine?: VoiceEngine;
  private pumpTimer?: NodeJS.Timeout;
  private nextSendAt = 0;
  private drainWaiters: Array<() => void> = [];
  private hangingUp = false;
  private ended = false;
  /** What crossed the stream, for the log line when it closes. */
  private readonly stats = { inFrames: 0, otherMessages: 0, outVoiceFrames: 0, clears: 0 };
  /** PHOUND_DEBUG_AUDIO_DIR: raw PCM of both directions, for diagnosing line audio. */
  private readonly debugAudio = process.env.PHOUND_DEBUG_AUDIO_DIR
    ? join(process.env.PHOUND_DEBUG_AUDIO_DIR, `call-${Date.now()}`)
    : undefined;

  constructor(private readonly params: PhoundCallSessionParams) {
    this.callId = params.callId;
    this.peer = params.peer;
  }

  private get log() {
    return this.params.log;
  }

  attachStream(url: string, rate: number, frameSamples: number): void {
    if (this.ended || this.ws) {
      return;
    }
    this.rate = rate;
    this.frameBytes = frameSamples * 2;
    this.frameMs = (frameSamples / rate) * 1000;
    this.silence = Buffer.alloc(this.frameBytes);
    this.toEngine = createStreamingPcmResampler(rate, ENGINE_SAMPLE_RATE);
    this.fromEngine = createStreamingPcmResampler(ENGINE_SAMPLE_RATE, rate);

    this.log?.info?.(`Phound call ${this.callId}: connecting to audio stream ${streamOrigin(url)}`);
    // The `ws` client, not Node's built-in WebSocket: uccrobot's stream server never
    // completes the built-in client's handshake (seen live: the connection hangs, then 1006).
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.log?.info?.(`Phound call ${this.callId}: audio stream open`);
      this.nextSendAt = performance.now();
      this.pumpTimer = setInterval(() => this.pump(), Math.max(5, this.frameMs / 2));
      void this.startEngine();
    });
    ws.on("message", (data) => this.onStreamMessage(data));
    ws.on("error", (error) => {
      this.log?.warn?.(`Phound call ${this.callId}: stream error at ${streamOrigin(url)}: ${error.message}`);
    });
    ws.on("close", (code, reason) => {
      this.stopPump();
      const s = this.stats;
      this.log?.info?.(
        `Phound call ${this.callId}: stream closed (${code}${reason.length ? ` ${reason.toString()}` : ""}); ` +
          `in ${s.inFrames} frames, ${s.otherMessages} other messages; out ${s.outVoiceFrames} voice frames, ${s.clears} barge-ins`,
      );
    });
  }

  /** Resolves when everything queued has been sent into the call. */
  drained(): Promise<void> {
    if (this.frames.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  async hangup(afterPlayback = true): Promise<void> {
    if (this.hangingUp) {
      return;
    }
    this.hangingUp = true;
    if (afterPlayback) {
      await this.drained();
      // Let the last frames leave the platform's jitter buffer before the line drops.
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await this.params.bridge.request("hangup", { call_id: this.callId }).catch(() => undefined);
  }

  close(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.engine?.close();
    this.stopPump();
    this.frames = [];
    for (const resolve of this.drainWaiters.splice(0)) {
      resolve();
    }
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }

  private async startEngine(): Promise<void> {
    const { cfg, channelRuntime, bridge, direction, peer } = this.params;
    const route = channelRuntime.routing.resolveAgentRoute({
      cfg,
      channel: "phound",
      accountId: bridge.account.accountId,
      peer: { kind: "direct", id: peer.sessionId ?? peer.id },
    });
    this.sessionKey = route.sessionKey;
    try {
      const engine = await (this.params.startEngine ?? startVoiceEngine)({
        cfg,
        log: this.log,
        callKey: `${this.callId}-${randomUUID()}`,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        caller: { id: peer.sessionId ?? peer.id, name: peer.name },
        direction,
        opening: this.params.opening,
        purpose: this.params.purpose,
        notifyOnly: !this.params.conversational,
        // Phound vouches for a persona; a phone number is only caller ID, which can be spoofed.
        toolPolicy: peer.sessionId ? bridge.account.voice.phoneToolPolicy : bridge.account.voice.toolPolicy,
        greeting: bridge.account.voice.greeting,
        output: {
          sendAudio: (pcm24k) => this.enqueueEngineAudio(pcm24k),
          clearAudio: () => this.clearPlayback(),
          hangup: () => void this.hangup(),
        },
      });
      if (this.ended) {
        engine.close();
        return;
      }
      this.engine = engine;
    } catch (error) {
      this.log?.warn?.(`Phound call ${this.callId}: voice engine failed to start: ${String(error)}`);
      void this.hangup(false);
    }
  }

  private onStreamMessage(data: unknown): void {
    if (this.ended) {
      return;
    }
    let frame: { type?: string; payload?: string };
    try {
      frame = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    if (frame.type === "audio" && frame.payload) {
      this.stats.inFrames++;
      const raw = Buffer.from(frame.payload, "base64");
      this.dumpAudio("in", raw);
      const pcm = this.toEngine.process(raw);
      if (pcm.length > 0) {
        this.engine?.sendAudio(pcm);
      }
    } else {
      this.stats.otherMessages++;
    }
  }

  private enqueueEngineAudio(pcm24k: Buffer): void {
    if (this.ended) {
      return;
    }
    this.pending = Buffer.concat([this.pending, this.fromEngine.process(pcm24k)]);
    while (this.pending.length >= this.frameBytes) {
      this.frames.push(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
  }

  /** Barge-in: drop what is queued here and what the platform still has buffered. */
  private clearPlayback(): void {
    this.stats.clears++;
    this.frames = [];
    this.pending = Buffer.alloc(0);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "command", payload: "reset-audio" }));
    }
    for (const resolve of this.drainWaiters.splice(0)) {
      resolve();
    }
  }

  private pump(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const now = performance.now();
    if (now - this.nextSendAt > 200) {
      // The event loop stalled; do not burst the backlog into the call.
      this.nextSendAt = now;
    }
    while (now >= this.nextSendAt) {
      const queued = this.frames.shift();
      if (queued) {
        this.stats.outVoiceFrames++;
      }
      this.dumpAudio("out", queued ?? this.silence);
      ws.send(JSON.stringify({ type: "audio", payload: (queued ?? this.silence).toString("base64") }));
      this.nextSendAt += this.frameMs;
    }
    if (this.frames.length === 0 && this.drainWaiters.length > 0) {
      for (const resolve of this.drainWaiters.splice(0)) {
        resolve();
      }
    }
  }

  private dumpAudio(direction: "in" | "out", pcm: Buffer): void {
    if (!this.debugAudio) {
      return;
    }
    try {
      mkdirSync(this.debugAudio, { recursive: true });
      appendFileSync(join(this.debugAudio, `${direction}-${this.rate}hz.pcm`), pcm);
    } catch {
      // debugging aid only
    }
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString();
  }
  return Buffer.from(data as ArrayBuffer).toString();
}

/** Scheme, host and path of a stream URL; its query may carry an access token. */
function streamOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable stream URL)";
  }
}

// OpenClaw can load this plugin more than once in one gateway process (the channel and the
// agent tools get separate module copies), so live state sits on a process-wide key that
// every copy shares; a plain module-level Map would be empty in the agent tools' copy.
const calls = resolveGlobalMap<string, PhoundCallSession>(Symbol.for("openclaw.phound.calls"));

export function registerCall(accountId: string, session: PhoundCallSession): void {
  calls.set(`${accountId}:${session.callId}`, session);
}

export function getCall(accountId: string, callId: string): PhoundCallSession | undefined {
  return calls.get(`${accountId}:${callId}`);
}

export function removeCall(accountId: string, callId: string): PhoundCallSession | undefined {
  const key = `${accountId}:${callId}`;
  const session = calls.get(key);
  calls.delete(key);
  return session;
}

export function findCall(params: { sessionKey?: string; callId?: string }): PhoundCallSession | undefined {
  const all = [...calls.values()];
  if (params.callId) {
    return all.find((call) => call.callId === params.callId);
  }
  if (params.sessionKey) {
    const bySession = all.find((call) => call.sessionKey === params.sessionKey);
    if (bySession) {
      return bySession;
    }
  }
  return all.length === 1 ? all[0] : undefined;
}

export function listCalls(): PhoundCallSession[] {
  return [...calls.values()];
}
