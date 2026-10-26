import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  hasConfiguredSecretInput,
  resolveSecretInputString,
  type SecretInputStringResolution,
  type SecretInputStringResolutionMode,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeAllowEntry, normalizePhoneNumber } from "./targets.js";
import type { PhoundChannelConfig, ResolvedPhoundAccount } from "./types.js";

const CHANNEL_ID = "phound";
const DEFAULT_TEXT_CHUNK_LIMIT = 4000;

function getChannelConfig(cfg: OpenClawConfig): PhoundChannelConfig | undefined {
  return cfg?.channels?.[CHANNEL_ID] as PhoundChannelConfig | undefined;
}

function parseList(raw: unknown): string[] {
  if (!raw) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : String(raw).split(",");
  return entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
}

function hasBaseAccount(channelCfg: PhoundChannelConfig | undefined): boolean {
  return (
    hasConfiguredSecretInput(channelCfg?.token) ||
    hasConfiguredAccountValue(process.env.PHOUND_TOKEN)
  );
}

const {
  listAccountIds: listPhoundAccountIds,
  resolveDefaultAccountId: resolveDefaultPhoundAccountId,
  resolveAccountConfig: resolveMergedPhoundAccountConfig,
} = createAccountListHelpers<Record<string, unknown> & PhoundChannelConfig>(CHANNEL_ID, {
  fallbackAccountIdWhenEmpty: false,
  hasImplicitDefaultAccount: (cfg) => hasBaseAccount(getChannelConfig(cfg)),
  omitKeys: ["defaultAccount"],
});

export { listPhoundAccountIds, resolveDefaultPhoundAccountId };

export function resolvePhoundAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedPhoundAccount {
  return readPhoundAccount(cfg, accountId, "strict").account;
}

function readPhoundAccount(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  mode: SecretInputStringResolutionMode,
): { account: ResolvedPhoundAccount; tokenStatus: SecretInputStringResolution["status"] } {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultPhoundAccountId(cfg);
  const merged = resolveMergedPhoundAccountConfig(cfg, id);
  const accountEnabled = channelCfg.accounts?.[id]?.enabled;
  const useEnvFallbacks = id === DEFAULT_ACCOUNT_ID;

  const token = resolveSecretInputString({
    value: merged.token ?? (useEnvFallbacks ? process.env.PHOUND_TOKEN : undefined),
    path:
      id === DEFAULT_ACCOUNT_ID
        ? "channels.phound.token"
        : `channels.phound.accounts.${id}.token`,
    mode,
  });
  const voice = merged.voice ?? {};
  const account: ResolvedPhoundAccount = {
    accountId: id,
    enabled: channelCfg.enabled !== false && accountEnabled !== false,
    token: token.value ?? "",
    sbc: (merged.sbc ?? (useEnvFallbacks ? process.env.PHOUND_SBC : undefined) ?? "").trim(),
    personaUid: (merged.personaUid ?? "").trim(),
    pythonCommand: merged.pythonCommand?.filter(Boolean) ?? [],
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: parseList(merged.allowFrom),
    textChunkLimit: merged.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT,
    voice: {
      enabled: voice.enabled !== false,
      greeting: voice.greeting?.trim() ?? "",
      toolPolicy: voice.toolPolicy ?? "safe-read-only",
      phoneToolPolicy: voice.phoneToolPolicy ?? "none",
      callPolicy: voice.callPolicy ?? "allowlist",
      callAllow: (voice.callAllow ?? []).map(normalizePhoneNumber).filter(Boolean),
    },
  };
  return { account, tokenStatus: token.status };
}

export function inspectPhoundAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const { account, tokenStatus } = readPhoundAccount(cfg, accountId, "inspect");
  return {
    accountId: account.accountId,
    name: account.personaUid || "Phound",
    enabled: account.enabled,
    configured: tokenStatus !== "missing",
    tokenStatus,
  };
}

export function isPhoundAccountConfigured(account: ResolvedPhoundAccount): boolean {
  return Boolean(account.token);
}
