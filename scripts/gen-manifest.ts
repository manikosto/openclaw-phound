/** Regenerate openclaw.plugin.json#channelConfigs.phound from the zod config schema. */
import { readFileSync, writeFileSync } from "node:fs";
import { PhoundChannelConfigSchema } from "../src/config-schema.js";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { schema, uiHints } = PhoundChannelConfigSchema as { schema: unknown; uiHints?: unknown };
manifest.channelConfigs = {
  phound: {
    schema,
    ...(uiHints ? { uiHints } : {}),
    label: "Phound",
    description: "Phound chats, SMS and phone calls through a Phound bot persona.",
  },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
