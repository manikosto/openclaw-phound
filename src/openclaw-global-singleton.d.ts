/**
 * Types for OpenClaw's process-wide singleton helper. OpenClaw ships this SDK
 * subpath as JavaScript without declarations, so only what this plugin uses is
 * declared here, from OpenClaw 2026.10.7.
 */

declare module "openclaw/plugin-sdk/global-singleton" {
  /** One Map per key for the whole process, whichever copy of a module asks for it. */
  export function resolveGlobalMap<K, V>(key: symbol): Map<K, V>;
}
