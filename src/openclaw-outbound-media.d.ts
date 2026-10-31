/**
 * Types for OpenClaw's outbound media loader. OpenClaw ships this SDK subpath as
 * JavaScript without declarations, so only what src/send.ts uses is declared
 * here, from OpenClaw 2026.10.7.
 */

declare module "openclaw/plugin-sdk/outbound-media" {
  export type OutboundMedia = {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
    kind?: string;
  };

  /** Loads a remote URL or an approved local path under OpenClaw's media policy. */
  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: {
      maxBytes?: number;
      mediaAccess?: object;
      mediaLocalRoots?: readonly string[];
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
    },
  ): Promise<OutboundMedia>;
}
