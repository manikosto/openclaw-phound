import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { toInboundMediaFactsWithMetadata } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PhoundBridge, PhoundBridgeLog } from "./bridge.js";
import { sendPhoundText } from "./send.js";
import { normalizePhoneNumber, phoundSenderId } from "./targets.js";
import type { PhoundInboundMessage, ResolvedPhoundAccount } from "./types.js";

const CHANNEL_ID = "phound";

export type PhoundChannelRuntime = Pick<
  PluginRuntime["channel"],
  "commands" | "inbound" | "media" | "pairing" | "routing"
>;

export type PhoundSender = {
  /** Who is checked against allowFrom and pairing: phone number or persona uid. */
  id: string;
  name: string;
  /**
   * The identity the agent sees and its session is keyed by, when it must differ
   * from `id`. A phone call from a number uses its own (`call:+1555…`): caller ID
   * can be spoofed, so a call must not inherit that number's chat history or
   * command-owner rights.
   */
  sessionId?: string;
};

type TurnParams = {
  cfg: OpenClawConfig;
  account: ResolvedPhoundAccount;
  channelRuntime: PhoundChannelRuntime;
  sender: PhoundSender;
  log?: PhoundBridgeLog;
};

async function authorizeSender(
  params: TurnParams & {
    text: string;
    mayPair: boolean;
    allowCommands: boolean;
    contextBinding?: ChannelIngressContextBinding;
  },
) {
  const { cfg, account, channelRuntime, sender } = params;
  const commandRequested =
    params.allowCommands && channelRuntime.commands.shouldComputeCommandAuthorized(params.text, cfg);
  return await channelRuntime.inbound.ingress.resolveStable({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    cfg,
    identity: { key: "phound-sender", entryIdPrefix: "phound-entry" },
    readStoreAllowFrom: async () =>
      await channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: account.accountId,
      }),
    subject: { stableId: sender.id },
    conversation: { kind: "direct", id: sender.sessionId ?? sender.id },
    contextBinding: params.contextBinding,
    event: { mayPair: params.mayPair },
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom,
    command: commandRequested ? { cfg, modeWhenAccessGroupsOff: "configured" } : undefined,
  });
}

/** Whether a sender may talk to the agent at all, without starting a pairing request. */
export async function isPhoundSenderAllowed(params: TurnParams): Promise<boolean> {
  const auth = await authorizeSender({ ...params, text: "", mayPair: false, allowCommands: false });
  return auth.senderAccess.allowed;
}

export type PhoundTurnOutcome = "dispatched" | "denied" | "pairing";

/**
 * One chat message into the agent. The session is keyed by the sender (phone
 * number or persona uid). Calls do not come through here: OpenClaw's voice engine
 * runs them (src/voice/engine.ts).
 */
export async function dispatchPhoundTurn(
  params: TurnParams & {
    messageId: string;
    text: string;
    bodyForAgent?: string;
    /** Attachments handed to OpenClaw as they are; it transcribes or describes them itself. */
    media?: Awaited<ReturnType<typeof toInboundMediaFactsWithMetadata>>;
    replyTo: string;
    deliver: (text: string) => Promise<void>;
    onReplyStart?: () => void;
    onRoute?: (route: { agentId: string; sessionKey: string }) => void;
    sendPairingReply?: (text: string) => Promise<void>;
    extra?: Record<string, string>;
  },
): Promise<PhoundTurnOutcome> {
  const { cfg, account, channelRuntime, sender, log } = params;
  const allowCommands = true;
  const mayPair = Boolean(params.sendPairingReply);
  let auth = await authorizeSender({ ...params, mayPair, allowCommands });
  if (!auth.senderAccess.allowed) {
    if (auth.senderAccess.decision === "pairing" && params.sendPairingReply) {
      const sendPairingReply = params.sendPairingReply;
      const issueChallenge = createChannelPairingChallengeIssuer({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        upsertPairingRequest: async (input) =>
          await channelRuntime.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            ...input,
          }),
      });
      await issueChallenge({
        senderId: sender.id,
        senderIdLine: `Your Phound id: ${sender.id}`,
        sendPairingReply,
        onCreated: () => log?.info?.(`Phound pairing request created for ${sender.id}`),
        onReplyError: (err) => log?.warn?.(`Phound pairing reply failed for ${sender.id}: ${String(err)}`),
      });
      return "pairing";
    }
    log?.warn?.(`Phound sender ${sender.id} is not authorized`);
    return "denied";
  }

  const agentSenderId = sender.sessionId ?? sender.id;
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: agentSenderId },
  });
  const sessionKey = route.sessionKey;
  params.onRoute?.({ agentId: route.agentId, sessionKey });
  auth = await authorizeSender({
    ...params,
    mayPair: false,
    allowCommands,
    contextBinding: {
      agentId: route.agentId,
      sessionKey,
      messageId: params.messageId,
      inboundEventKind: "user_request",
    },
  });
  if (!auth.senderAccess.allowed) {
    log?.warn?.(`Phound sender ${sender.id} authorization changed before dispatch`);
    return "denied";
  }
  const commandRequested = auth.commandAccess.requested;
  const commandAuthorized = auth.commandAccess.authorized;
  const isTextCommand =
    allowCommands && channelRuntime.commands.isControlCommandMessage(params.text, cfg);

  await channelRuntime.inbound.run({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    raw: { id: params.messageId, text: params.text },
    adapter: {
      ingest: (raw) => ({
        id: raw.id,
        timestamp: Date.now(),
        rawText: raw.text,
        textForAgent: params.bodyForAgent ?? raw.text,
        textForCommands: raw.text,
        raw,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = channelRuntime.inbound.buildContext({
          channelIngress: auth,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `${CHANNEL_ID}:${agentSenderId}`,
          sender: { id: agentSenderId, name: sender.name || agentSenderId },
          conversation: { kind: "direct", id: agentSenderId, label: sender.name || agentSenderId },
          route: {
            agentId: route.agentId,
            accountId: account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: { to: `${CHANNEL_ID}:${params.replyTo}` },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          ...(params.media?.length ? { media: params.media } : {}),
          access: commandRequested
            ? { commands: { authorized: commandAuthorized } }
            : undefined,
          command: isTextCommand
            ? { kind: "text-slash", body: input.textForCommands, authorized: commandAuthorized }
            : undefined,
          extra: params.extra,
        });
        return {
          cfg,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          route: { agentId: route.agentId, sessionKey },
          ctxPayload,
          delivery: {
            durable: () => ({ to: params.replyTo }),
            deliver: async (payload) => {
              const text = payload.text;
              if (!text) {
                return { visibleReplySent: false };
              }
              await params.deliver(text);
              return { visibleReplySent: true };
            },
          },
          dispatcherOptions: {
            onReplyStart: () => params.onReplyStart?.(),
          },
        };
      },
    },
  });
  return "dispatched";
}

/**
 * A voice message goes to OpenClaw as an audio attachment: the plugin only
 * fetches it into OpenClaw's media store, OpenClaw transcribes it (tools.media.audio).
 */
async function saveVoiceMessage(
  channelRuntime: PhoundChannelRuntime,
  url: string,
  messageId: string,
  log?: PhoundBridgeLog,
) {
  try {
    const saved = await channelRuntime.media.saveRemoteMedia({
      url,
      filePathHint: "phound-voice-message.ogg",
      fallbackContentType: "audio/ogg",
      maxBytes: VOICE_MESSAGE_MAX_BYTES,
      timeoutMs: 30_000,
    });
    return await toInboundMediaFactsWithMetadata([
      { path: saved.path, contentType: saved.contentType ?? "audio/ogg", messageId },
    ]);
  } catch (error) {
    log?.warn?.(`Phound voice message download failed: ${String(error)}`);
    return [];
  }
}

const VOICE_MESSAGE_MAX_BYTES = 20 * 1024 * 1024;

function describeAttachments(msg: PhoundInboundMessage): string {
  return msg.attachments.map((a) => `[Attachment: ${a.name} ${a.url}]`).join("\n");
}

/** A chat message (Phound app or SMS) or a voice message from the bridge. */
export async function handlePhoundChatMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedPhoundAccount;
  channelRuntime: PhoundChannelRuntime;
  bridge: PhoundBridge;
  msg: PhoundInboundMessage;
  log?: PhoundBridgeLog;
}): Promise<void> {
  const { cfg, account, bridge, msg, log } = params;
  // The bot's own persona writing means a person took the chat over from the Phound app.
  if (!msg.chat_id || msg.from_uid === msg.persona_uid) {
    return;
  }
  bridge.lastPersonaUid = msg.persona_uid;
  bridge.personaByChat.set(msg.chat_id, msg.persona_uid);
  const number = normalizePhoneNumber(msg.from_number ?? "");
  if (number) {
    bridge.chatByNumber.set(number, msg.chat_id);
  }

  const sender = {
    id: phoundSenderId({ fromNumber: msg.from_number, fromUid: msg.from_uid }),
    name: msg.from_name,
  };
  let text = msg.text ?? "";
  let media: Awaited<ReturnType<typeof saveVoiceMessage>> = [];
  if (msg.audio_url) {
    // Only for senders who may talk to the agent: anyone else still reaches dispatch
    // below, which answers with a pairing code, without the audio being fetched.
    const allowed = await isPhoundSenderAllowed({
      cfg,
      account,
      channelRuntime: params.channelRuntime,
      sender,
      log,
    });
    if (allowed) {
      media = await saveVoiceMessage(params.channelRuntime, msg.audio_url, msg.message_id, log);
    }
    // The platform's own transcript is not used: OpenClaw transcribes the audio.
    text = media.length ? "" : "[Voice message]";
  }
  const attachments = describeAttachments(msg);
  const bodyForAgent = [text, attachments].filter(Boolean).join("\n");
  if (!bodyForAgent && media.length === 0) {
    return;
  }

  const chatTarget = `chat:${msg.chat_id}`;
  const reply = (replyText: string) =>
    sendPhoundText({ account, to: chatTarget, text: replyText }).then(() => undefined);
  await dispatchPhoundTurn({
    cfg,
    account,
    channelRuntime: params.channelRuntime,
    sender,
    messageId: msg.message_id,
    text,
    bodyForAgent,
    media,
    replyTo: chatTarget,
    deliver: reply,
    sendPairingReply: reply,
    onReplyStart: () => {
      void bridge.request("typing", { chat_id: msg.chat_id }).catch(() => undefined);
    },
    log,
    extra: {
      PhoundChatId: msg.chat_id,
      PhoundPersonaUid: msg.persona_uid,
      ...(number ? { SenderE164: number } : { PhoundSenderUid: msg.from_uid }),
    },
  });
}
