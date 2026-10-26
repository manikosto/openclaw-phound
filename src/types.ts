import type { z } from "zod";
import type { PhoundAccountConfigSchema, PhoundConfigSchema } from "./config-schema.js";

type PhoundAccountSchemaInput = z.input<typeof PhoundAccountConfigSchema>;

export type PhoundChannelConfig = Omit<z.input<typeof PhoundConfigSchema>, "accounts"> &
  PhoundAccountSchemaInput & {
    accounts?: Record<string, PhoundAccountSchemaInput>;
    defaultAccount?: string;
  };

export type PhoundVoiceSettings = {
  enabled: boolean;
  /** Instruction for OpenClaw's voice engine on how to greet; empty = its default. */
  greeting: string;
  /** Which agent tools a call may reach through the voice engine. */
  toolPolicy: "safe-read-only" | "owner" | "none";
  /** The same for calls from a phone number, whose caller ID can be spoofed. */
  phoneToolPolicy: "safe-read-only" | "owner" | "none";
  /** Who phound_call may dial: "allowlist" = allowed senders plus callAllow. */
  callPolicy: "allowlist" | "any";
  callAllow: string[];
};

export interface ResolvedPhoundAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  /** Phound SBC websocket; empty means the SDK's default (production). */
  sbc: string;
  personaUid: string;
  pythonCommand: string[];
  dmPolicy: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom: string[];
  textChunkLimit: number;
  voice: PhoundVoiceSettings;
}

/** A chat message as the bridge reports it. */
export type PhoundInboundMessage = {
  message_id: string;
  chat_id: string;
  chat_type: string;
  chat_title: string;
  persona_uid: string;
  from_uid: string;
  from_name: string;
  from_number: string;
  text: string;
  attachments: Array<{ name: string; url: string; size: number }>;
  audio_url?: string;
};

export type PhoundIncomingCall = {
  call_id: string;
  persona_uid: string;
  from_persona_uid: string;
  from_name: string;
  from_number: string;
  local_number: string;
};
