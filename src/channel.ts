import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectPhoundAccount,
  isPhoundAccountConfigured,
  listPhoundAccountIds,
  resolveDefaultPhoundAccountId,
  resolvePhoundAccount,
} from "./accounts.js";
import { PhoundChannelConfigSchema } from "./config-schema.js";
import { runPhoundAccount } from "./gateway.js";
import type { PhoundChannelRuntime } from "./inbound.js";
import { sendPhoundText } from "./send.js";
import { normalizeAllowEntry, normalizePhoundTarget, parsePhoundTarget } from "./targets.js";
import type { ResolvedPhoundAccount } from "./types.js";

const CHANNEL_ID = "phound";

const phoundConfigAdapter = createHybridChannelConfigAdapter<ResolvedPhoundAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listPhoundAccountIds,
  resolveAccount: resolvePhoundAccount,
  defaultAccountId: resolveDefaultPhoundAccountId,
  clearBaseFields: [
    "token",
    "sbc",
    "personaUid",
    "pythonCommand",
    "dmPolicy",
    "allowFrom",
    "textChunkLimit",
    "voice",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom.map((entry) => normalizeAllowEntry(String(entry)))),
});

const resolvePhoundDmPolicy = createScopedDmSecurityResolver<ResolvedPhoundAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: "openclaw pairing approve phound <code>",
  normalizeEntry: normalizeAllowEntry,
});

const SETUP_KEYS = ["token", "personaUid", "sbc", "dmPolicy", "allowFrom"] as const;

const phoundSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "Phound bot token (TOKEN from the Support Bot)" },
    },
    personaUid: {
      kind: "string",
      cli: { flags: "--persona-uid <uid>", description: "Persona the bot runs as (PERSONAS from the Support Bot)" },
    },
    sbc: {
      kind: "string",
      cli: { flags: "--sbc <url>", description: "Phound server; empty for production" },
    },
    dmPolicy: {
      kind: "choice",
      choices: ["pairing", "allowlist", "open", "disabled"],
      cli: { flags: "--dm-policy <policy>", description: "Who may talk to the bot" },
    },
    allowFrom: {
      kind: "string-list",
      cli: { flags: "--allow-from <ids>", description: "Allowed phone numbers or persona uids" },
    },
  },
  adapter: {
    applyAccountConfig: (params) => {
      const patch: Record<string, unknown> = {};
      for (const key of SETUP_KEYS) {
        if (params.input[key] !== undefined) {
          patch[key] = params.input[key];
        }
      }
      const channels = { ...params.cfg.channels };
      const current = { ...(channels[CHANNEL_ID] as Record<string, unknown> | undefined) };
      if (params.accountId === DEFAULT_ACCOUNT_ID) {
        channels[CHANNEL_ID] = { ...current, ...patch };
        return { ...params.cfg, channels };
      }
      const accounts = { ...(current.accounts as Record<string, unknown> | undefined) };
      accounts[params.accountId] = {
        ...(accounts[params.accountId] as Record<string, unknown> | undefined),
        ...patch,
      };
      channels[CHANNEL_ID] = { ...current, accounts };
      return { ...params.cfg, channels };
    },
  },
});

async function sendText(ctx: { cfg: Parameters<typeof resolvePhoundAccount>[0]; accountId?: string | null; to: string; text: string }) {
  const account = resolvePhoundAccount(ctx.cfg, ctx.accountId);
  const result = await sendPhoundText({ account, to: ctx.to, text: ctx.text });
  return { channel: CHANNEL_ID, messageId: result.messageId, conversationId: result.chatId };
}

export const phoundPlugin: ChannelPlugin<ResolvedPhoundAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Phound",
      selectionLabel: "Phound (chats, SMS, calls)",
      detailLabel: "Phound bot persona",
      docsPath: "/channels/phound",
      docsLabel: "phound",
      blurb: "Talk to the agent from the Phound app, by SMS, or by phone call.",
      order: 89,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: PhoundChannelConfigSchema,
    setupContract: phoundSetupContract,
    config: {
      ...phoundConfigAdapter,
      inspectAccount: inspectPhoundAccount,
      isConfigured: isPhoundAccountConfigured,
      unconfiguredReason: () => "Phound requires a bot token (channels.phound.token or PHOUND_TOKEN).",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.personaUid || "Phound",
        configured: isPhoundAccountConfigured(account),
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: normalizePhoundTarget,
      inferTargetChatType: ({ to }) => (parsePhoundTarget(to) ? "direct" : undefined),
      resolveOutboundSessionRoute: (params) => {
        const target = parsePhoundTarget(params.resolvedTarget?.to ?? params.target);
        if (!target) {
          return null;
        }
        const peerId =
          target.kind === "phone"
            ? target.number
            : target.kind === "persona"
              ? target.personaUid
              : target.chatId;
        const to = normalizePhoundTarget(params.resolvedTarget?.to ?? params.target);
        return buildChannelOutboundSessionRoute({
          cfg: params.cfg,
          agentId: params.agentId,
          channel: CHANNEL_ID,
          accountId: params.accountId,
          recipientSessionExact: target.kind !== "chat",
          peer: { kind: "direct", id: peerId },
          chatType: "direct",
          from: `${CHANNEL_ID}:${peerId}`,
          to: `${CHANNEL_ID}:${to}`,
        });
      },
      targetResolver: {
        looksLikeId: (raw) => Boolean(parsePhoundTarget(raw)),
        hint: "<chat:CHAT_ID | persona:PERSONA_UID | +15551234567>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("Phound channel runtime is not available; account not started");
          return;
        }
        const statusSink = createAccountStatusSink({
          accountId: ctx.account.accountId,
          setStatus: ctx.setStatus,
        });
        await runPhoundAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as PhoundChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          onConnected: () => statusSink({ connected: true, running: true, lastError: null }),
          onDisconnected: (error) => statusSink({ connected: false, lastError: error ?? null }),
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedPhoundAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      resolveAccountSnapshot: ({ account }) => {
        const configured = isPhoundAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.personaUid || "Phound",
          enabled: account.enabled,
          configured,
          extra: {
            statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured",
          },
        };
      },
    }),
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### Phound",
        "Phound app chats render markdown; SMS chats are plain text. To phone someone, use the phound_call tool.",
      ],
    },
  },
  pairing: {
    text: {
      idLabel: "phoundSender",
      message: "OpenClaw: your Phound access has been approved.",
      normalizeAllowEntry,
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolvePhoundAccount(cfg, accountId);
        const to = id.startsWith("+") ? id : `persona:${id}`;
        await sendPhoundText({ account, to, text: message });
      },
    },
  },
  security: {
    resolveDmPolicy: resolvePhoundDmPolicy,
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 4000,
    resolveEffectiveTextChunkLimit: ({ cfg, accountId }) =>
      resolvePhoundAccount(cfg, accountId).textChunkLimit,
    resolveTarget: ({ to }) => {
      const normalized = normalizePhoundTarget(to ?? "");
      if (normalized) {
        return { ok: true, to: normalized };
      }
      return {
        ok: false,
        error: new Error("Phound target must be chat:<id>, persona:<uid> or a +E.164 phone number."),
      };
    },
    sendText,
  },
});
