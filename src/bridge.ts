import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ResolvedPhoundAccount } from "./types.js";

/**
 * The Node side of bridge/phound_bridge.py: one Python process per account,
 * newline-delimited JSON both ways. Events arrive as `event` emissions named
 * after the bridge's event field; commands are `request(cmd, fields)`.
 */

/** The package root: from source (src/) or from the build (dist/src/), the folder with the manifest. */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "openclaw.plugin.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Phound plugin: openclaw.plugin.json not found above the plugin code");
    }
    dir = parent;
  }
  return dir;
}

const BRIDGE_DIR = join(findPackageRoot(), "bridge");
const BRIDGE_SCRIPT = join(BRIDGE_DIR, "phound_bridge.py");
const REQUEST_TIMEOUT_MS = 20_000;

export type PhoundBridgeLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export type PhoundBridgeEvent = { event: string; [key: string]: unknown };

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * What the bridge inherits from the gateway: enough to find Python, uv and the
 * network, nothing more. The gateway's environment holds model keys and other
 * channels' tokens; the bridge and the closed-source uccrobot it runs need none.
 */
const BRIDGE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SYSTEMROOT", "SystemRoot", "PATHEXT", "COMSPEC",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "PYTHONPATH", "VIRTUAL_ENV", "XDG_CACHE_HOME",
  "UV_PROJECT_ENVIRONMENT", "UV_PYTHON_DOWNLOADS", "UV_CACHE_DIR", "UV_PYTHON",
  "PHOUND_LOG_DIR", "PHOUND_REPLY_TIMEOUT", "PHOUND_BRIDGE_LOG_LEVEL", "UCCROBOT_QUIET", "UCCROBOT_DEBUG",
];

function bridgeBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BRIDGE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function resolveBridgeCommand(account: ResolvedPhoundAccount): [string, string[]] {
  if (account.pythonCommand.length > 0) {
    const [command, ...args] = account.pythonCommand;
    return [command!, [...args, BRIDGE_SCRIPT]];
  }
  return ["uv", ["run", "--quiet", "--project", BRIDGE_DIR, "python", BRIDGE_SCRIPT]];
}

export class PhoundBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyPromise?: Promise<void>;
  /** Last stderr line: on a failed start it names the cause (a Python exception). */
  private lastStderr = "";

  /** Persona that last received something; the sender for proactive messages. */
  lastPersonaUid = "";
  /** Phone number -> chat id, learnt from SMS chats and phone calls. */
  readonly chatByNumber = new Map<string, string>();
  /** Chat id -> the bot persona that lives in it. */
  readonly personaByChat = new Map<string, string>();

  constructor(
    readonly account: ResolvedPhoundAccount,
    private readonly log?: PhoundBridgeLog,
  ) {
    super();
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start(): Promise<void> {
    const [command, args] = resolveBridgeCommand(this.account);
    // A private working directory, so the SDK's .env lookup cannot pick up a stray file.
    const cwd = join(tmpdir(), `openclaw-phound-${this.account.accountId}`);
    mkdirSync(cwd, { recursive: true });
    this.lastStderr = "";
    const child = spawn(command, args, {
      cwd,
      env: {
        ...bridgeBaseEnv(),
        TOKEN: this.account.token,
        ...(this.account.sbc ? { SBC: this.account.sbc } : {}),
        // A plain token (uid.key) listens to the persona set here, as PERSONAS= does next to
        // TOKEN= in the Support Bot's reply; a packed token already names its personas.
        PERSONAS: this.account.token.includes(".") ? this.account.personaUid : "",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onEarlyExit = (code: number | null) =>
        reject(
          new Error(
            `Phound bridge exited before it was ready (code ${code})${this.lastStderr ? `: ${this.lastStderr}` : ""}`,
          ),
        );
      // "close", not "exit": by then stderr is drained, so lastStderr holds the cause.
      child.once("close", onEarlyExit);
      child.once("error", reject);
      this.once("ready", () => {
        child.off("close", onEarlyExit);
        child.off("error", reject);
        resolve();
      });
    });

    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      this.lastStderr = line.trim();
      if (/\b(ERROR|CRITICAL)\b/.test(line)) {
        this.log?.warn?.(`[phound:${this.account.accountId}] ${line}`);
      } else {
        this.log?.debug?.(`[phound:${this.account.accountId}] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.failPending(new Error(`Phound bridge exited (code ${code}, signal ${signal})`));
      this.emit("exit", code, signal);
    });
    return this.readyPromise;
  }

  /** Ask the bridge to stop: closing stdin ends it cleanly, a kill follows if it hangs. */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), graceMs);
    await exited;
    clearTimeout(timer);
  }

  request(cmd: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !this.running) {
      return Promise.reject(new Error("Phound bridge is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Phound bridge did not answer "${cmd}" in time`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...fields })}\n`);
    });
  }

  private onLine(line: string): void {
    let message: PhoundBridgeEvent;
    try {
      message = JSON.parse(line) as PhoundBridgeEvent;
    } catch {
      this.log?.warn?.(`[phound:${this.account.accountId}] unreadable bridge output: ${line}`);
      return;
    }
    if (message.event === "reply") {
      const pending = this.pending.get(message.id as number);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve((message.result as Record<string, unknown>) ?? {});
      } else {
        pending.reject(new Error(String(message.error ?? "Phound bridge command failed")));
      }
      return;
    }
    this.emit(message.event, message);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

const bridges = new Map<string, PhoundBridge>();

export function setActiveBridge(accountId: string, bridge: PhoundBridge | undefined): void {
  if (bridge) {
    bridges.set(accountId, bridge);
  } else {
    bridges.delete(accountId);
  }
}

export function getActiveBridge(accountId: string): PhoundBridge {
  const bridge = bridges.get(accountId);
  if (!bridge || !bridge.running) {
    throw new Error(`Phound account "${accountId}" is not connected`);
  }
  return bridge;
}

export function listActiveBridges(): PhoundBridge[] {
  return [...bridges.values()];
}
