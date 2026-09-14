/**
 * Server discovery and optional autostart.
 *
 * Obsidian's desktop runtime is Electron with node integration, so the plugin
 * can read the bridge's handshake file and spawn the bundled server directly.
 * Everything here is desktop-only (the manifest declares isDesktopOnly).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WS_PATH, isRecord, type HandshakeFile } from "../shared/protocol.js";
import type { HarnessSettings } from "./settings.js";

export interface Endpoint {
  url: string;
  token: string;
  /** How the endpoint was resolved, for status messaging. */
  source: "handshake" | "settings";
}

function resolveStateDir(settings: HarnessSettings): string {
  const configured = settings.stateDir.trim();
  if (!configured) return path.join(os.homedir(), ".obs-harness");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/"))
    return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

export function handshakePath(settings: HarnessSettings): string {
  return path.join(resolveStateDir(settings), "server.json");
}

/** Read the handshake file, returning null when absent or malformed. */
export function readHandshake(settings: HarnessSettings): HandshakeFile | null {
  try {
    const raw = fs.readFileSync(handshakePath(settings), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { port, token, pid } = parsed;
    if (
      typeof port !== "number" ||
      typeof token !== "string" ||
      token.length === 0
    )
      return null;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      port,
      token,
      pid: typeof pid === "number" ? pid : -1,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** True when a process with this pid exists and we may signal it. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return isRecord(err) && err.code === "EPERM";
  }
}

/**
 * Resolve the endpoint to connect to. The handshake file wins when enabled and
 * its server still looks alive; otherwise fall back to the configured values.
 *
 * Plain `ws` is intentional throughout: the bridge binds loopback only and is
 * authenticated by a per-start token, so TLS to 127.0.0.1 would add certificate
 * management without changing the threat model.
 */
export function resolveEndpoint(settings: HarnessSettings): Endpoint | null {
  if (settings.useHandshakeFile) {
    const handshake = readHandshake(settings);
    if (handshake && (handshake.pid === -1 || pidAlive(handshake.pid))) {
      return {
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        url: `ws://${settings.host}:${handshake.port}${WS_PATH}`,
        token: handshake.token,
        source: "handshake",
      };
    }
  }
  if (!settings.token) return null;
  return {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    url: `ws://${settings.host}:${settings.port}${WS_PATH}`,
    token: settings.token,
    source: "settings",
  };
}

export interface StartServerResult {
  ok: boolean;
  detail: string;
}

/**
 * Spawn the bundled server.js, detached so it outlives plugin reloads — that
 * persistence is the whole reason for the server topology.
 */
export function startServer(
  settings: HarnessSettings,
  pluginDir: string,
): StartServerResult {
  const serverScript = path.join(pluginDir, "server.js");
  if (!fs.existsSync(serverScript)) {
    return {
      ok: false,
      detail: `server.js not found at ${serverScript} — run 'npm run build'`,
    };
  }

  const args = [
    serverScript,
    "--port",
    String(settings.port),
    "--pi",
    settings.piPath,
  ];
  const configuredStateDir = settings.stateDir.trim();
  if (configuredStateDir) args.push("--state-dir", resolveStateDir(settings));
  if (settings.token) args.push("--token", settings.token);

  try {
    // Obsidian's PATH frequently lacks node, so prefer the Electron runtime's
    // own binary via ELECTRON_RUN_AS_NODE.
    const execPath = process.execPath;
    const child = spawn(execPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      cwd: pluginDir,
    });
    child.unref();
    return {
      ok: true,
      detail: `started bridge server (pid ${String(child.pid ?? -1)})`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not start server: ${detail}` };
  }
}
