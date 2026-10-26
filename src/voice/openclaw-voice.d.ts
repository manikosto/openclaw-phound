/**
 * Types for the parts of OpenClaw's voice engine this plugin uses. OpenClaw
 * ships these SDK subpaths as JavaScript without declarations (they are
 * "private-local": made for its own channel plugins, such as Discord voice), so
 * only what src/voice/engine.ts touches is declared here, from OpenClaw 2026.10.7.
 */

declare module "openclaw/plugin-sdk/realtime-voice" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

  export type RealtimeVoiceAudioFormat =
    | { encoding: "pcm16"; sampleRateHz: 24000; channels: 1 }
    | { encoding: "g711_ulaw"; sampleRateHz: 8000; channels: 1 };
  export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat;
  export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: string;

  export type RealtimeVoiceToolPolicy = "safe-read-only" | "owner" | "none";
  export type RealtimeVoiceTool = {
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };

  export type RealtimeVoiceProvider = { id: string; defaultModel?: string };
  export type RealtimeVoiceProviderCapabilities = {
    handlesAgentConsult?: boolean;
    supportsToolCalls?: boolean;
  };
  export function resolveConfiguredRealtimeVoiceProvider(params: {
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
    providerConfigOverrides?: Record<string, unknown>;
    cfg?: OpenClawConfig;
    agentId?: string;
    surface?: "browser-session" | "gateway-relay" | "bridge";
    useProviderDefaultModel?: boolean;
    autoRespondToAudio?: boolean;
    noRegisteredProviderMessage?: string;
  }): {
    provider: RealtimeVoiceProvider;
    providerConfig: Record<string, unknown>;
    capabilities?: RealtimeVoiceProviderCapabilities;
  };

  export type RealtimeVoiceToolCallEvent = {
    itemId?: string;
    callId: string;
    name: string;
    args: unknown;
  };
  export type RealtimeVoiceBridgeSession = {
    readonly bridge: { supportsToolResultContinuation?: boolean };
    connect(): Promise<void>;
    sendAudio(audio: Buffer): void;
    submitToolResult(
      callId: string,
      result: unknown,
      options?: { willContinue?: boolean; suppressResponse?: boolean },
    ): void | Promise<void>;
    triggerGreeting(instructions?: string): void;
    close(options?: { disposition?: "abort" | "detach" }): void | Promise<void>;
  };
  export function createRealtimeVoiceBridgeSession(params: {
    provider: RealtimeVoiceProvider;
    capabilities?: RealtimeVoiceProviderCapabilities;
    providerConfig: Record<string, unknown>;
    cfg?: OpenClawConfig;
    agentId?: string;
    audioFormat?: RealtimeVoiceAudioFormat;
    instructions?: string;
    autoRespondToAudio?: boolean;
    interruptResponseOnInputAudio?: boolean;
    tools?: RealtimeVoiceTool[];
    runAgentConsult?: (request: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
    audioSink: {
      isOpen?(): boolean;
      sendAudio(audio: Buffer): void;
      clearAudio?(reason?: string): void;
    };
    markStrategy?: "transport" | "ack-immediately" | "ignore";
    triggerGreetingOnReady?: boolean;
    initialGreetingInstructions?: string;
    onTranscript?(role: "user" | "assistant", text: string, isFinal: boolean): void;
    onToolCall?(event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession): void | Promise<void>;
    onReady?(session: RealtimeVoiceBridgeSession): void;
    onResponseDone?(outcome: unknown): void;
    onError?(error: Error): void;
    onClose?(reason: "completed" | "error"): void;
  }): RealtimeVoiceBridgeSession;

  export function resolveRealtimeVoiceAgentConsultTools(
    policy: RealtimeVoiceToolPolicy,
    customTools?: RealtimeVoiceTool[],
  ): RealtimeVoiceTool[];
  export function resolveRealtimeVoiceAgentConsultToolsAllow(
    policy: RealtimeVoiceToolPolicy,
  ): string[] | undefined;
  export function buildRealtimeVoiceSessionInstructions(params: {
    base: string;
    bootstrapContextInstructions?: string;
    isAgentProxy: boolean;
    toolPolicy: RealtimeVoiceToolPolicy;
    consultPolicy?: "auto" | "always";
  }): string;
  export function buildRealtimeVoiceAgentConsultWorkingResponse(audience: string): unknown;
  export function consultRealtimeVoiceAgent(params: {
    cfg: OpenClawConfig;
    agentRuntime: unknown;
    logger: { warn(message: string): void };
    agentId?: string;
    sessionKey: string;
    messageProvider: string;
    lane: string;
    runIdPrefix: string;
    args: unknown;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
    surface: string;
    userLabel: string;
    assistantLabel?: string;
    questionSourceLabel?: string;
    senderId?: string;
    senderIsOwner?: boolean;
    thinkLevel?: string;
    fastMode?: boolean;
    toolsAllow?: string[];
    extraSystemPrompt?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }>;
}

declare module "openclaw/plugin-sdk/realtime-voice-provider" {
  export function createStreamingPcmResampler(
    inputSampleRate: number,
    outputSampleRate: number,
  ): { process(chunk: Buffer): Buffer; flush(): Buffer };
}

declare module "openclaw/plugin-sdk/realtime-bootstrap-context" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

  export function resolveRealtimeVoiceAgentContextInstructions(params: {
    agentId: string;
    config: OpenClawConfig;
    sessionKey?: string;
    includeIdentity?: boolean;
    warn?(message: string): void;
  }): Promise<string>;
}
