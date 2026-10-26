import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { phoundPlugin } from "./src/channel.js";
import { setPhoundRuntime } from "./src/runtime.js";
import { registerPhoundTools } from "./src/tools.js";

export default defineChannelPluginEntry({
  id: "phound",
  name: "Phound",
  description: "Phound chats, SMS and phone calls for OpenClaw, through a Phound bot persona.",
  plugin: phoundPlugin,
  setRuntime: setPhoundRuntime,
  registerFull: registerPhoundTools,
});
