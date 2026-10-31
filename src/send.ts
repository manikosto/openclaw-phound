import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { loadOutboundMediaFromUrl, type OutboundMedia } from "openclaw/plugin-sdk/outbound-media";
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
  return await sendToPhound(params);
}

/** Largest attachment the plugin hands to Phound. */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** uccrobot uploads the file after the send command returns, so the copy outlives it. */
const MEDIA_FILE_TTL_MS = 10 * 60_000;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

/**
 * Writes loaded media to a private temp file for the Phound SDK, which takes file
 * paths and tells images from other files by the extension.
 */
export async function writeMediaFile(media: OutboundMedia): Promise<string> {
  const original = basename(media.fileName ?? "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  const contentType = (media.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType] ?? extname(original);
  const stem = (extname(original) ? original.slice(0, -extname(original).length) : original) || "attachment";
  const dir = await mkdtemp(join(tmpdir(), "openclaw-phound-media-"));
  const path = join(dir, `${stem}${extension}`);
  await writeFile(path, media.buffer, { mode: 0o600 });
  setTimeout(() => void rm(dir, { recursive: true, force: true }), MEDIA_FILE_TTL_MS).unref();
  return path;
}

export async function sendPhoundMedia(params: {
  account: ResolvedPhoundAccount;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: object;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<PhoundSendResult> {
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: MEDIA_MAX_BYTES,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });
  const path = await writeMediaFile(media);
  return await sendToPhound({ account: params.account, to: params.to, text: params.text, attachments: [path] });
}

async function sendToPhound(params: {
  account: ResolvedPhoundAccount;
  to: string;
  text: string;
  attachments?: string[];
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
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
  });
  return { chatId: String(result.chat_id ?? chatId), messageId: `${Date.now()}` };
}
