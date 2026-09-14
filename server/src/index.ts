/**
 * CLI entry point for the obs-harness bridge server.
 *
 * Generates a loopback token, writes a handshake file the Obsidian plugin reads
 * for auto-discovery, and serves WebSocket clients until interrupted.
 *
 *   node server.js [--port 8787] [--pi pi] [--idle-timeout 0]
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { DEFAULT_PORT, WS_PATH, type HandshakeFile } from "../../shared/protocol.js";
import { HarnessServer } from "./server.js";

const SERVER_VERSION = "0.1.0";
const HANDSHAKE_VERSION = 1;

interface Args {
  port: number;
  host: string;
  piPath: string;
  token: string | null;
  stateDir: string;
  idleTimeoutMs: number;
  quiet: boolean;
}

function usage(): string {
  return [
    "usage: node server.js [options]",
    "",
    "  --port <n>            listen port (default 8787, 0 = ephemeral)",
    "  --host <addr>         bind address (default 127.0.0.1)",
    "  --pi <path>           pi executable (default 'pi', or $OBS_HARNESS_PI)",
    "  --token <str>         shared token (default: random per start)",
    "  --state-dir <path>    handshake dir (default ~/.obs-harness)",
    "  --idle-timeout <min>  reclaim a session N minutes after its last panel",
    "                        closes; 0 keeps it warm forever (default 0)",
    "  --quiet               suppress logging",
    "  -h, --help            show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.OBS_HARNESS_PORT ?? DEFAULT_PORT),
    host: "127.0.0.1",
    piPath: process.env.OBS_HARNESS_PI ?? "pi",
    token: process.env.OBS_HARNESS_TOKEN ?? null,
    stateDir: process.env.OBS_HARNESS_STATE_DIR ?? path.join(os.homedir(), ".obs-harness"),
    idleTimeoutMs: 0,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        process.stderr.write(`missing value for ${String(flag)}\n`);
        process.exit(2);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case "--port":
        args.port = Number(next());
        break;
      case "--host":
        args.host = next();
        break;
      case "--pi":
        args.piPath = next();
        break;
      case "--token":
        args.token = next();
        break;
      case "--state-dir":
        args.stateDir = next();
        break;
      case "--idle-timeout":
        args.idleTimeoutMs = Math.max(0, Number(next())) * 60_000;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
      // falls through to default is impossible: process.exit never returns
      default:
        process.stderr.write(`unknown option: ${String(flag)}\n${usage()}\n`);
        process.exit(2);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    process.stderr.write(`invalid --port: ${args.port}\n`);
    process.exit(2);
  }
  return args;
}

function detectPiVersion(piPath: string): string | null {
  try {
    return execFileSync(piPath, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (message: string): void => {
    if (!args.quiet) process.stderr.write(`[obs-harness] ${message}\n`);
  };

  const piVersion = detectPiVersion(args.piPath);
  if (piVersion) {
    log(`pi ${piVersion} (${args.piPath})`);
  } else {
    log(`warning: could not run '${args.piPath} --version'; is pi on PATH?`);
  }

  const token = args.token ?? randomBytes(32).toString("base64url");

  const server = new HarnessServer({
    port: args.port,
    host: args.host,
    token,
    piPath: args.piPath,
    serverVersion: SERVER_VERSION,
    piVersion,
    idleTimeoutMs: args.idleTimeoutMs,
    log,
  });

  try {
    await server.listen();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[obs-harness] cannot listen on ${args.host}:${args.port}: ${detail}\n`);
    if (detail.includes("EADDRINUSE")) {
      process.stderr.write("[obs-harness] another bridge is probably already running.\n");
    }
    process.exit(1);
  }

  // The handshake file is how the plugin finds us without the user copying a
  // token. It holds a credential, so it is owner-only.
  const handshakePath = path.join(args.stateDir, "server.json");
  const handshake: HandshakeFile = {
    version: HANDSHAKE_VERSION,
    port: args.port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  };
  try {
    fs.mkdirSync(args.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(handshakePath, `${JSON.stringify(handshake, null, 2)}\n`, { mode: 0o600 });
    log(`handshake written to ${handshakePath}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`warning: could not write handshake file: ${detail}`);
    log(`set the token manually in plugin settings: ${token}`);
  }

  // Plain ws is intentional: the bridge binds loopback only and is authenticated
  // by a per-start token. TLS to 127.0.0.1 would add certificate management
  // without changing the threat model.
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  log(`listening on ws://${args.host}:${args.port}${WS_PATH}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    try {
      // Only remove the handshake if it is still ours; a newer server may have
      // replaced it.
      const onDisk: unknown = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
      if (typeof onDisk === "object" && onDisk !== null && (onDisk as HandshakeFile).pid === process.pid) {
        fs.unlinkSync(handshakePath);
      }
    } catch {
      // Nothing to clean up.
    }
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
