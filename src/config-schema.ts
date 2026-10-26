import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
  DmPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const SecretInputSchema = buildSecretInputSchema();

const PhoundVoiceConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    greeting: z.string().optional(),
    toolPolicy: z.enum(["safe-read-only", "owner", "none"]).optional(),
    phoneToolPolicy: z.enum(["safe-read-only", "owner", "none"]).optional(),
    callPolicy: z.enum(["allowlist", "any"]).optional(),
    callAllow: z.array(z.string()).optional(),
  })
  .strict();

export const PhoundAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: SecretInputSchema.optional(),
    sbc: z.string().optional(),
    personaUid: z.string().optional(),
    pythonCommand: z.array(z.string()).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: AllowFromListSchema,
    textChunkLimit: z.number().int().positive().optional(),
    voice: PhoundVoiceConfigSchema.optional(),
  })
  .strict();

export const PhoundConfigSchema = buildMultiAccountChannelSchema(PhoundAccountConfigSchema, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "phound",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  },
});

export const PhoundChannelConfigSchema = buildChannelConfigSchema(PhoundConfigSchema, {
  uiHints: {
    "": {
      label: "Phound",
      help: "Phound chats, SMS and phone calls through a Phound bot persona.",
    },
    token: {
      label: "Phound Bot Token",
      help: "TOKEN from the Phound Support Bot (Home page of the Phound app, at the bottom).",
      sensitive: true,
      placeholder: "12345678.0123456789abcdef…",
    },
    "accounts.*.token": { sensitive: true },
    sbc: {
      advanced: true,
      label: "Phound Server",
      help: "Phound SBC websocket the bot connects to. Defaults to production (wss://ow-sbc.phound.app/ucp); set it for a QA stand.",
    },
    personaUid: {
      label: "Persona",
      help: "PERSONAS from the Support Bot: the persona the bot answers as, and calls and writes from. Empty: every persona on the account.",
      placeholder: "12345678",
    },
    pythonCommand: {
      advanced: true,
      label: "Bridge Python Command",
      help: 'Command that runs the bridge script, e.g. ["/path/to/venv/bin/python"]. Defaults to "uv run" with the bundled bridge project.',
    },
    dmPolicy: {
      label: "Phound DM Policy",
      help: 'Who may talk to the bot ("pairing" recommended). "open" requires channels.phound.allowFrom=["*"].',
    },
    allowFrom: {
      label: "Phound Allow From",
      help: "Allowed senders: phone numbers in E.164 format or Phound persona uids, or * when dmPolicy is open.",
    },
    "voice.enabled": { label: "Answer Calls", help: "Answer phone calls with the agent. Default true." },
    "voice.greeting": {
      label: "Call Greeting",
      help: "How the agent greets an incoming caller, as an instruction to OpenClaw's voice engine. Default: a short greeting as itself.",
    },
    "voice.toolPolicy": {
      label: "Agent Tools on Calls",
      help: '"safe-read-only" (default): the agent can read and search. "owner": every tool. "none": voice only, no agent.',
    },
    "voice.phoneToolPolicy": {
      label: "Agent Tools for Phone-Number Callers",
      help: 'Same choices, for calls from a phone number. Default "none": caller ID can be spoofed, so such calls get the voice persona but not the agent\'s files, memory or tools.',
    },
    "voice.callPolicy": {
      label: "Who the Agent May Call",
      help: '"allowlist" (default): only people who may talk to the agent, plus voice.callAllow. "any": any number, at your account\'s cost.',
    },
    "voice.callAllow": {
      label: "Extra Numbers to Call",
      help: "Phone numbers (E.164) the agent may call without being allowed to talk to it; they only hear the agent's message.",
    },
  },
});
