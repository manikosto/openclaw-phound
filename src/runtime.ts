import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setPhoundRuntime, getRuntime: getPhoundRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "phound",
    errorMessage: "Phound runtime not initialized - plugin not registered",
  });

export { getPhoundRuntime, setPhoundRuntime };
