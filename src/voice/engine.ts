import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRealtimeVoiceAgentContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  buildRealtimeVoiceSessionInstructions,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import * as realtimeVoice from "openclaw/plugin-sdk/realtime-voice";
import type { PhoundBridgeLog } from "../bridge.js";
import { getPhoundRuntime } from "../runtime.js";

/**
 * The conversation on a call, run entirely by OpenClaw's voice engine — the same
 * realtime voice runtime its Discord voice channel uses. The engine listens,
 * speaks, handles barge-in, and hands real work to the routed OpenClaw agent
 * (openclaw_agent_consult) with that agent's persona, tools and session.
 * The plugin around it only carries audio: PCM16 24 kHz both ways.
 */

export const ENGINE_SAMPLE_RATE = 24000;

export type VoiceEngineOutput = {
  sendAudio(pcm24k: Buffer): void;
  clearAudio(): void;
  /** End the call once what was said so far has been played. */
  hangup(): void;
};

export type VoiceEngineParams = {
  cfg: OpenClawConfig;
  log?: PhoundBridgeLog;
  /** Unique per call, for run ids. */
  callKey: string;
  route: { agentId: string; sessionKey: string };
  /** The other party as the agent sees them. */
  caller: { id: string; name: string };
  direction: "inbound" | "outbound";
  /** Outbound: the first thing to say. */
  opening?: string;
  /** Outbound: why the agent called. */
  purpose?: string;
  /** Say the opening (or greeting) and hang up; do not listen. */
  notifyOnly: boolean;
  toolPolicy: RealtimeVoiceToolPolicy;
  /** Inbound: how to greet, as an instruction to the engine. */
  greeting?: string;
  output: VoiceEngineOutput;
};

export type VoiceEngine = {
  sendAudio(pcm24k: Buffer): void;
  close(): void;
};

const END_CALL_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: "end_call",
  description: "Hang up the phone call. Call it after you have said goodbye.",
  parameters: { type: "object", properties: {}, required: [] },
};

type TalkRealtimeConfig = {
  provider?: string;
  providers?: Record<string, Record<string, unknown> | undefined>;
  model?: string;
  speakerVoice?: string;
  speakerVoiceId?: string;
  instructions?: string;
};

type TalkConfig = {
  realtime?: TalkRealtimeConfig;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

/** A display name from the network, made safe to put into the engine's instructions. */
function displayName(params: VoiceEngineParams): string {
  const name = params.caller.name.replace(/[\r\n"`<>\[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return name || params.caller.id;
}

function callInstructions(params: VoiceEngineParams): string {
  const who = displayName(params);
  const lines =
    params.direction === "outbound"
      ? [`You placed this phone call to ${who} through Phound.`]
      : [`You are answering a phone call from ${who} through Phound.`];
  if (params.purpose) {
    lines.push(`Purpose of the call: ${params.purpose}`);
  }
  lines.push("This is a phone line: keep every answer to one to three short spoken sentences.");
  lines.push("When the conversation is over, say goodbye and call end_call.");
  return lines.join("\n");
}

function greetingInstructions(params: VoiceEngineParams): string {
  if (params.direction === "outbound") {
    const opening = params.opening?.trim() || "Hello!";
    return `Say exactly this, then wait for the reply: "${opening}"`;
  }
  return params.greeting?.trim() || "Greet the caller briefly as yourself and ask how you can help.";
}

/**
 * OpenClaw replaces the synchronous provider resolver with an async one: the async
 * one ships from 2026.10.10, the sync one is removed in January 2027. Use whichever
 * the running OpenClaw has. A namespace read, so a missing export is undefined
 * rather than a module-linking error.
 */
async function resolveRealtimeVoiceProvider(params: realtimeVoice.RealtimeVoiceProviderSelection) {
  const resolveAsync = realtimeVoice.resolveConfiguredRealtimeVoiceProviderAsync;
  return resolveAsync ? await resolveAsync(params) : realtimeVoice.resolveConfiguredRealtimeVoiceProvider(params);
}

export async function startVoiceEngine(params: VoiceEngineParams): Promise<VoiceEngine> {
  const { cfg, route, log, output } = params;
  const talk = ((cfg as { talk?: TalkConfig }).talk ?? {}) as TalkConfig;
  const realtime = talk.realtime ?? {};
  const voice = realtime.speakerVoice ?? realtime.speakerVoiceId;
  const resolved = await resolveRealtimeVoiceProvider({
    configuredProviderId: realtime.provider,
    providerConfigs: realtime.providers ?? {},
    providerConfigOverrides: {
      ...(realtime.model ? { model: realtime.model } : {}),
      ...(voice ? { voice } : {}),
    },
    cfg,
    agentId: route.agentId,
    surface: "gateway-relay",
    useProviderDefaultModel: true,
    noRegisteredProviderMessage:
      "Phone calls need OpenClaw's realtime voice: set talk.realtime.provider (e.g. openai) and its API key.",
  });

  const persona = await resolveRealtimeVoiceAgentContextInstructions({
    agentId: route.agentId,
    config: cfg,
    sessionKey: route.sessionKey,
    includeIdentity: true,
    warn: (message) => log?.warn?.(`Phound voice: ${message}`),
  }).catch(() => "");

  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  const consult = (args: unknown, signal?: AbortSignal) =>
    consultRealtimeVoiceAgent({
      cfg,
      agentRuntime: getPhoundRuntime().agent,
      logger: { warn: (message) => log?.warn?.(`Phound voice: ${message}`) },
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageProvider: "phound",
      lane: "phound-voice",
      runIdPrefix: `phound-call:${params.callKey}`,
      args,
      transcript,
      surface: "a live phone call",
      userLabel: "Caller",
      questionSourceLabel: "caller",
      senderId: params.caller.id,
      // Caller identity on a phone line is never proof of ownership.
      senderIsOwner: false,
      thinkLevel: talk.consultThinkingLevel ?? "low",
      fastMode: talk.consultFastMode,
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.toolPolicy),
      abortSignal: signal,
    });

  // A timeline of the call for the log (no words, only timings), to see where latency goes.
  const startedAt = Date.now();
  const since = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  let callerDoneAt = 0;
  let replyStarted = true;
  const timeline = (event: string) => log?.info?.(`Phound voice ${params.callKey.split("-")[0]} ${since()}: ${event}`);

  const listening = !params.notifyOnly;
  const nativeConsult = resolved.capabilities?.handlesAgentConsult === true;
  let closed = false;
  let greeted = false;

  const session = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    capabilities: resolved.capabilities,
    providerConfig: resolved.providerConfig,
    cfg,
    agentId: route.agentId,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: buildRealtimeVoiceSessionInstructions({
      base: [realtime.instructions, callInstructions(params)].filter(Boolean).join("\n\n"),
      bootstrapContextInstructions: persona,
      isAgentProxy: listening,
      toolPolicy: listening ? params.toolPolicy : "none",
      consultPolicy: "auto",
    }),
    autoRespondToAudio: listening,
    interruptResponseOnInputAudio: listening,
    tools: listening
      ? resolveRealtimeVoiceAgentConsultTools(nativeConsult ? "none" : params.toolPolicy, [END_CALL_TOOL])
      : [],
    ...(listening && nativeConsult
      ? { runAgentConsult: ({ prompt, signal }) => consult({ question: prompt }, signal) }
      : {}),
    audioSink: {
      isOpen: () => !closed,
      sendAudio: (audio) => {
        if (!replyStarted) {
          replyStarted = true;
          timeline(callerDoneAt ? `reply audio ${Date.now() - callerDoneAt} ms after the caller's turn` : "first audio");
        }
        output.sendAudio(audio);
      },
      clearAudio: () => {
        timeline("barge-in: caller speech detected, playback cleared");
        output.clearAudio();
      },
    },
    markStrategy: "ack-immediately",
    triggerGreetingOnReady: true,
    initialGreetingInstructions: greetingInstructions(params),
    onTranscript: (role, text, isFinal) => {
      if (isFinal && text.trim()) {
        transcript.push({ role, text: text.trim() });
        if (role === "user") {
          callerDoneAt = Date.now();
          replyStarted = false;
          timeline(`caller turn transcribed (${text.trim().length} chars)`);
        }
      }
    },
    onToolCall: async (event, active) => {
      if (event.name === END_CALL_TOOL.name) {
        await active.submitToolResult(event.callId, { ok: true });
        output.hangup();
        return;
      }
      if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        await active.submitToolResult(event.callId, { error: `Unknown tool ${event.name}` });
        return;
      }
      if (active.bridge.supportsToolResultContinuation) {
        await active.submitToolResult(event.callId, buildRealtimeVoiceAgentConsultWorkingResponse("caller"), {
          willContinue: true,
        });
      }
      try {
        const result = await consult(event.args);
        await active.submitToolResult(event.callId, { text: result.text });
      } catch (error) {
        log?.warn?.(`Phound voice: agent consult failed: ${String(error)}`);
        await active.submitToolResult(event.callId, { error: String(error) });
      }
    },
    onResponseDone: () => {
      timeline("response done");
      // A notify-only call says its line once and ends.
      if (params.notifyOnly && !greeted) {
        greeted = true;
        output.hangup();
      }
    },
    onError: (error) => log?.warn?.(`Phound voice: ${error.message}`),
    onClose: () => {
      if (!closed) {
        output.hangup();
      }
    },
  });

  replyStarted = false;
  await session.connect();
  timeline("realtime session connected");
  log?.info?.(
    `Phound voice: ${resolved.provider.id} realtime session up for ${params.caller.id} (agent ${route.agentId})`,
  );

  return {
    sendAudio: (pcm24k) => {
      if (listening && !closed) {
        session.sendAudio(pcm24k);
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        void Promise.resolve(session.close()).catch(() => undefined);
      } catch {
        // already closed by the provider
      }
    },
  };
}
