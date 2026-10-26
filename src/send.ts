import { getActiveBridge, type PhoundBridge } from "./bridge.js";
import { parsePhoundTarget } from "./targets.js";
import type { ResolvedPhoundAccount } from "./types.js";

export type PhoundSendResult = { chatId: string; messageId: string };

/** SMS chats get plain text; Phound app chats render markdown. */
function isSmsChat(bridge: PhoundBridge, chatId: string): boolean {
  for (const smsChatId of bridge.chatByNumber.values()) {
    if (smsChatId === chatId) {
      return true;
    }
  }
  return false;
}

export function toPlainText(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, "$1 ($2)");
}

function senderPersona(bridge: PhoundBridge, account: ResolvedPhoundAccount, chatId: string): string {
  const persona =
    (chatId && bridge.personaByChat.get(chatId)) || account.personaUid || bridge.lastPersonaUid;
  if (!persona) {
    throw new Error(
      "Phound does not know which persona to send from yet: set channels.phound.personaUid, or wait for someone to message the bot first.",
    );
  }
  return persona;
}

export async function sendPhoundText(params: {
  account: ResolvedPhoundAccount;
  to: string;
  text: string;
}): Promise<PhoundSendResult> {
  const { account, text } = params;
  const bridge = getActiveBridge(account.accountId);
  const target = parsePhoundTarget(params.to);
  if (!target) {
    throw new Error(
      `Invalid Phound target "${params.to}": use chat:<chatId>, persona:<personaUid> or a +E.164 phone number.`,
    );
  }

  let chatId = "";
  let personaUid = "";
  if (target.kind === "chat") {
    chatId = target.chatId;
  } else if (target.kind === "persona") {
    personaUid = target.personaUid;
  } else {
    chatId = bridge.chatByNumber.get(target.number) ?? "";
    if (!chatId) {
      throw new Error(
        `Phound can text ${target.number} only after a conversation with it (an SMS or a call) since the gateway started.`,
      );
    }
  }

  const markdown = !chatId || !isSmsChat(bridge, chatId);
  const result = await bridge.request("send", {
    chat_id: chatId,
    persona_uid: personaUid,
    from_persona_uid: senderPersona(bridge, account, chatId),
    text: markdown ? text : toPlainText(text),
    markdown,
  });
  return { chatId: String(result.chat_id ?? chatId), messageId: `${Date.now()}` };
}
