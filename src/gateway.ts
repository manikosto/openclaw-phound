import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PhoundBridge, setActiveBridge, type PhoundBridgeLog } from "./bridge.js";
import {
  handlePhoundChatMessage,
  isPhoundSenderAllowed,
  type PhoundChannelRuntime,
  type PhoundSender,
} from "./inbound.js";
import { isPhoundPersonaUid, looksLikePhoneNumber, normalizePhoneNumber, phoundSenderId } from "./targets.js";
import type {
  PhoundContact,
  PhoundIncomingCall,
  PhoundInboundMessage,
  PhoundVoiceSettings,
  ResolvedPhoundAccount,
} from "./types.js";
import {
  getCall,
  PhoundCallSession,
  registerCall,
  removeCall,
} from "./voice/call-session.js";

type OutboundCallRequest = { opening: string; purpose?: string; conversational: boolean; name?: string };

type AccountContext = {
  cfg: OpenClawConfig;
  bridge: PhoundBridge;
  channelRuntime: PhoundChannelRuntime;
  log?: PhoundBridgeLog;
  /** Dialled number -> what the agent wants from the call, until the platform reports the call. */
  pendingOutbound: Map<string, OutboundCallRequest>;
};

const contexts = new Map<string, AccountContext>();

/**
 * The other party of a call. A Phound app user is the persona Phound vouches for
 * and keeps their chat session; a phone number is only caller ID, which can be
 * spoofed, so its calls get a session of their own and no command-owner rights.
 */
export function callSender(params: { fromNumber?: string; fromUid?: string; name?: string }): PhoundSender {
  const id = phoundSenderId(params);
  const number = normalizePhoneNumber(params.fromNumber ?? "");
  const isPhoneCaller = !isPhoundPersonaUid(params.fromUid) && Boolean(number);
  return {
    id,
    name: params.name || number || id,
    ...(isPhoneCaller ? { sessionId: `call:${number}` } : {}),
  };
}

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function wireBridgeEvents(ctx: AccountContext): void {
  const { bridge, log } = ctx;
  const accountId = bridge.account.accountId;
  const guard = (what: string, task: Promise<unknown>) =>
    task.catch((error: unknown) => log?.warn?.(`Phound ${what} failed: ${String(error)}`));

  const onChatEvent = (msg: PhoundInboundMessage) =>
    guard(
      "inbound message",
      handlePhoundChatMessage({
        cfg: ctx.cfg,
        account: bridge.account,
        channelRuntime: ctx.channelRuntime,
        bridge,
        msg,
        log,
      }),
    );
  bridge.on("message", onChatEvent);
  bridge.on("voice_message", onChatEvent);

  bridge.on("call_incoming", (call: PhoundIncomingCall) => {
    void guard("incoming call", handleIncomingCall(ctx, call));
  });

  bridge.on("call_outgoing", (event: { call_id: string; persona_uid: string; number: string }) => {
    const number = normalizePhoneNumber(event.number);
    const request = ctx.pendingOutbound.get(number);
    ctx.pendingOutbound.delete(number);
    registerCall(
      accountId,
      new PhoundCallSession({
        cfg: ctx.cfg,
        bridge,
        channelRuntime: ctx.channelRuntime,
        log,
        callId: event.call_id,
        direction: "outbound",
        peer: callSender({ fromNumber: number, name: request?.name }),
        conversational: request?.conversational ?? false,
        opening: request?.opening,
        purpose: request?.purpose,
      }),
    );
  });

  bridge.on("call_chat", (event: { call_id: string; chat_id: string }) => {
    const session = getCall(accountId, event.call_id);
    if (!session || !event.chat_id) {
      return;
    }
    session.chatId = event.chat_id;
    // In a one-to-one call with a phone, the call's chat is that number's SMS chat.
    if (session.peer.id.startsWith("+")) {
      bridge.chatByNumber.set(session.peer.id, event.chat_id);
    }
  });

  bridge.on("call_stream", (event: { call_id: string; url: string; rate: number; samples: number }) => {
    getCall(accountId, event.call_id)?.attachStream(event.url, event.rate, event.samples);
  });

  const onCallEnd = (event: { call_id: string; reason?: string | null }) => {
    removeCall(accountId, event.call_id)?.close();
    if (event.reason) {
      log?.info?.(`Phound call ${event.call_id} ended: ${event.reason}`);
    }
  };
  bridge.on("call_hangup", onCallEnd);
  bridge.on("call_failed", onCallEnd);
}

async function handleIncomingCall(ctx: AccountContext, call: PhoundIncomingCall): Promise<void> {
  const { bridge, log } = ctx;
  const account = bridge.account;
  const sender = callSender({ fromNumber: call.from_number, fromUid: call.from_persona_uid, name: call.from_name });
  bridge.lastPersonaUid = call.persona_uid || bridge.lastPersonaUid;
  let accept = account.voice.enabled && Boolean(sender.id);
  if (accept) {
    accept = await isPhoundSenderAllowed({
      cfg: ctx.cfg,
      account,
      channelRuntime: ctx.channelRuntime,
      sender,
      log,
    });
    if (!accept) {
      log?.info?.(`Phound: rejecting call from ${sender.id}, who is not allowed to talk to the agent`);
    }
  }
  if (accept) {
    registerCall(
      account.accountId,
      new PhoundCallSession({
        cfg: ctx.cfg,
        bridge,
        channelRuntime: ctx.channelRuntime,
        log,
        callId: call.call_id,
        direction: "inbound",
        peer: sender,
        conversational: true,
      }),
    );
  }
  await bridge.request("call_decision", { call_id: call.call_id, accept });
}

/**
 * A call costs money and speaks in the bot's name, and the agent may have been
 * talked into it by text it read: by default it only dials numbers the operator allowed.
 */
export function assertCallAllowed(
  voice: Pick<PhoundVoiceSettings, "callPolicy" | "callAllow">,
  number: string,
  senderAllowed: boolean,
): void {
  if (voice.callPolicy !== "any" && !senderAllowed && !voice.callAllow.includes(number)) {
    throw new Error(
      `Calling ${number} is not allowed: add it to channels.phound.contacts, approve it with pairing, or set voice.callPolicy to "any".`,
    );
  }
}

/**
 * What phound_call's `to` names: a phone number, or a contact by name. A number
 * that belongs to a contact is that contact too.
 */
export function resolveCallTarget(
  contacts: PhoundContact[],
  to: string,
): { number: string; contact?: PhoundContact } {
  const wanted = to.trim().toLowerCase();
  const byName = contacts.find((contact) => contact.name.toLowerCase() === wanted);
  if (byName) {
    return { number: byName.number, contact: byName };
  }
  if (!looksLikePhoneNumber(to) || !/^[\s+\d().-]+$/.test(to.trim())) {
    const names = contacts.map((contact) => contact.name);
    throw new Error(
      names.length > 0
        ? `"${to}" is neither a phone number in E.164 format nor a contact. Contacts: ${names.join(", ")}.`
        : `"${to}" is not a phone number in E.164 format, and no contacts are set in channels.phound.contacts.`,
    );
  }
  const number = normalizePhoneNumber(to);
  return { number, contact: contacts.find((contact) => contact.number === number) };
}

/** Place a call on behalf of the agent. */
export async function placePhoundCall(params: {
  accountId: string;
  to: string;
  opening: string;
  purpose?: string;
}): Promise<{ number: string; name?: string; conversational: boolean }> {
  const ctx = contexts.get(params.accountId);
  if (!ctx || !ctx.bridge.running) {
    throw new Error(`Phound account "${params.accountId}" is not connected`);
  }
  const account = ctx.bridge.account;
  const { number, contact } = resolveCallTarget(account.contacts, params.to);
  const fromPersona = account.personaUid || ctx.bridge.lastPersonaUid;
  if (!fromPersona) {
    throw new Error(
      "Phound does not know which persona to call from: set channels.phound.personaUid.",
    );
  }
  // The operator's contacts and anyone who may talk to the agent anyway get a
  // conversation; anyone else hears the opening line and the call ends.
  const conversational =
    Boolean(contact) ||
    (await isPhoundSenderAllowed({
      cfg: ctx.cfg,
      account,
      channelRuntime: ctx.channelRuntime,
      sender: { id: number, name: number },
      log: ctx.log,
    }));
  assertCallAllowed(account.voice, number, conversational);
  const purpose = [params.purpose, contact?.note ? `About ${contact.name}: ${contact.note}` : ""]
    .filter(Boolean)
    .join("\n");
  ctx.pendingOutbound.set(number, {
    opening: params.opening,
    purpose: purpose || undefined,
    conversational,
    name: contact?.name,
  });
  await ctx.bridge.request("call", { from_persona_uid: fromPersona, number });
  return { number, name: contact?.name, conversational };
}

/** The contacts of a connected account, for the agent. */
export function listPhoundContacts(accountId: string): PhoundContact[] {
  const ctx = contexts.get(accountId);
  if (!ctx) {
    throw new Error(`Phound account "${accountId}" is not connected`);
  }
  return ctx.bridge.account.contacts;
}

export function listConnectedAccountIds(): string[] {
  return [...contexts.entries()].filter(([, ctx]) => ctx.bridge.running).map(([id]) => id);
}

/**
 * Keep the account's bridge process alive until the gateway stops the account:
 * restart it with backoff when it dies, stop it cleanly on abort.
 */
export async function runPhoundAccount(params: {
  cfg: OpenClawConfig;
  account: ResolvedPhoundAccount;
  channelRuntime: PhoundChannelRuntime;
  abortSignal: AbortSignal;
  log?: PhoundBridgeLog;
  onConnected: () => void;
  onDisconnected: (error?: string) => void;
}): Promise<void> {
  const { account, abortSignal, log } = params;
  const bridge = new PhoundBridge(account, log);
  const ctx: AccountContext = {
    cfg: params.cfg,
    bridge,
    channelRuntime: params.channelRuntime,
    log,
    pendingOutbound: new Map(),
  };
  wireBridgeEvents(ctx);
  contexts.set(account.accountId, ctx);
  setActiveBridge(account.accountId, bridge);

  const stopOnAbort = () => void bridge.stop();
  abortSignal.addEventListener("abort", stopOnAbort, { once: true });
  let backoff = RESTART_MIN_MS;
  try {
    while (!abortSignal.aborted) {
      const exited = new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
      const startedAt = Date.now();
      try {
        await bridge.start();
        log?.info?.(`Phound account ${account.accountId} connected`);
        params.onConnected();
        await exited;
      } catch (error) {
        log?.warn?.(`Phound bridge for ${account.accountId} failed to start: ${String(error)}`);
        params.onDisconnected(String(error));
      }
      if (abortSignal.aborted) {
        break;
      }
      params.onDisconnected("bridge process exited");
      backoff = Date.now() - startedAt > RESTART_MAX_MS ? RESTART_MIN_MS : Math.min(backoff * 2, RESTART_MAX_MS);
      log?.warn?.(`Phound bridge for ${account.accountId} stopped; restarting in ${backoff / 1000}s`);
      await sleep(backoff, abortSignal);
    }
  } finally {
    abortSignal.removeEventListener("abort", stopOnAbort);
    await bridge.stop();
    contexts.delete(account.accountId);
    setActiveBridge(account.accountId, undefined);
    bridge.removeAllListeners();
  }
}
