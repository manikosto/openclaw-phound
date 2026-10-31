/**
 * Phound addresses. A chat is reached by its id; a person by their persona uid
 * (Phound app users) or phone number (SMS). The same person keys allowFrom and
 * the agent session: phone number when they write from a phone, persona uid
 * when they write from the Phound app.
 *
 * Persona uids are all digits too (123456789012), so a phone number is only ever
 * one written with its leading "+"; bare digits are a persona uid.
 */

export type PhoundTarget =
  | { kind: "chat"; chatId: string }
  | { kind: "persona"; personaUid: string }
  | { kind: "phone"; number: string };

const PHONE_RE = /^\+\d{7,15}$/;

export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) {
    return "";
  }
  return `+${digits}`;
}

export function looksLikePhoneNumber(raw: string): boolean {
  return PHONE_RE.test(normalizePhoneNumber(raw));
}

function stripChannelPrefix(raw: string): string {
  return raw.trim().replace(/^phound:/i, "");
}

export function parsePhoundTarget(raw: string): PhoundTarget | undefined {
  const value = stripChannelPrefix(raw);
  if (!value) {
    return undefined;
  }
  const match = /^(chat|persona):(.+)$/i.exec(value);
  if (match) {
    const id = match[2]!.trim();
    return match[1]!.toLowerCase() === "chat"
      ? { kind: "chat", chatId: id }
      : { kind: "persona", personaUid: id };
  }
  if (isWrittenPhoneNumber(value)) {
    return { kind: "phone", number: normalizePhoneNumber(value) };
  }
  if (/^\d+$/.test(value)) {
    return { kind: "persona", personaUid: value };
  }
  return undefined;
}

function isWrittenPhoneNumber(value: string): boolean {
  return /^\+[\d\s().-]+$/.test(value) && looksLikePhoneNumber(value);
}

export function formatPhoundTarget(target: PhoundTarget): string {
  switch (target.kind) {
    case "chat":
      return `chat:${target.chatId}`;
    case "persona":
      return `persona:${target.personaUid}`;
    case "phone":
      return target.number;
  }
}

export function normalizePhoundTarget(raw: string): string {
  const target = parsePhoundTarget(raw);
  return target ? formatPhoundTarget(target) : "";
}

/** allowFrom entries: phone numbers, persona uids (optionally persona:-prefixed) or "*". */
export function normalizeAllowEntry(raw: string): string {
  const value = stripChannelPrefix(raw).replace(/^persona:/i, "");
  if (value === "*") {
    return "*";
  }
  return isWrittenPhoneNumber(value) ? normalizePhoneNumber(value) : value;
}

/** Who a chat message or call comes from, as allowFrom and session routing see them. */
/** A Phound persona uid; PSTN callers and SMS senders carry "0" or nothing. */
export function isPhoundPersonaUid(uid?: string): boolean {
  const trimmed = (uid ?? "").trim();
  return trimmed !== "" && trimmed !== "0";
}

/**
 * A Phound app user is known by their persona uid even when the persona has a
 * number assigned (the platform sends RemoteNumber for those too); only a sender
 * without a persona is known by phone number.
 */
export function phoundSenderId(params: { fromNumber?: string; fromUid?: string }): string {
  if (isPhoundPersonaUid(params.fromUid)) {
    return params.fromUid!.trim();
  }
  return normalizePhoneNumber(params.fromNumber ?? "");
}
