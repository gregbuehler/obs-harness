/**
 * One long-lived `pi --mode rpc` child process, wrapped as a broadcastable session.
 *
 * Everything pi emits is handed to `onMessage` verbatim, except responses to
 * requests the bridge itself issued (internal ids), which resolve promises
 * instead. This keeps the client-facing stream a faithful pi event stream.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { INTERNAL_ID_PREFIX, isRecord } from "../../shared/protocol.js";
import { JsonlSplitter, encodeJsonl } from "./jsonl.js";

export interface PiSessionOptions {
  /** Path to (or bare name of) the pi executable. */
  piPath: string;
  /** Working directory for the agent; also the bridge's session key. */
  cwd: string;
  /** Optional `provider/id` model selector passed as `--model`. */
  model?: string;
  /** Optional session display name passed as `--name`. */
  name?: string;
  /** Extra CLI args appended after the bridge's own. */
  extraArgs?: string[];
  onMessage: (message: Record<string, unknown>) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onLog: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** Tool executions started but not yet finished, so late joiners see spinners. */
export interface PendingTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class PiSession {
  readonly cwd: string;
  private readonly options: PiSessionOptions;
  private readonly child: ChildProcess;
  private readonly splitter = new JsonlSplitter();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private alive = true;

  constructor(options: PiSessionOptions) {
    this.options = options;
    this.cwd = options.cwd;

    const args = ["--mode", "rpc"];
    if (options.model) args.push("--model", options.model);
    if (options.name) args.push("--name", options.name);
    if (options.extraArgs?.length) args.push(...options.extraArgs);

    this.child = spawn(options.piPath, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_HARNESS: "obsidian" },
    });

    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) options.onLog(text);
    });
    this.child.on("error", (err) => {
      options.onLog(`spawn error: ${err.message}`);
      this.handleExit(null, null);
    });
    this.child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get livePendingTools(): PendingTool[] {
    return [...this.pendingTools.values()];
  }

  /** Fire-and-forget a pi RPC command. */
  send(command: Record<string, unknown>): void {
    if (!this.alive || !this.child.stdin?.writable) return;
    this.child.stdin.write(encodeJsonl(command));
  }

  /**
   * Issue a command under an internal id and await its response. The response
   * is consumed by the bridge and never broadcast to clients.
   */
  request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.alive)
      return Promise.reject(new Error("pi session is not running"));
    const id = `${INTERNAL_ID_PREFIX}${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi request timed out: ${String(command.type)}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    // Escalate if pi ignores the polite request.
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    kill.unref?.();
    this.rejectAllPending(new Error("pi session disposed"));
  }

  private onStdout(chunk: Buffer): void {
    for (const line of this.splitter.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // pi may emit non-JSON noise on stdout during early startup; surface it
        // as a log rather than tearing down the session.
        this.options.onLog(`unparseable stdout line: ${line.slice(0, 400)}`);
        continue;
      }
      if (!isRecord(parsed)) continue;
      this.dispatch(parsed);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = typeof message.id === "string" ? message.id : null;

    if (id?.startsWith(INTERNAL_ID_PREFIX)) {
      const waiting = this.pending.get(id);
      if (waiting) {
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.resolve(message);
      }
      return; // never leaks to clients
    }

    this.trackToolLifecycle(message);
    this.options.onMessage(message);
  }

  /** Maintain the in-flight tool set used to build attach snapshots. */
  private trackToolLifecycle(message: Record<string, unknown>): void {
    const type = message.type;
    const toolCallId =
      typeof message.toolCallId === "string" ? message.toolCallId : null;

    if (type === "tool_execution_start" && toolCallId) {
      this.pendingTools.set(toolCallId, {
        toolCallId,
        toolName:
          typeof message.toolName === "string" ? message.toolName : "tool",
        args: message.args,
      });
      return;
    }
    if (type === "tool_execution_end" && toolCallId) {
      this.pendingTools.delete(toolCallId);
      return;
    }
    if (type === "agent_settled") {
      // Defensive: a torn-down run must not leave phantom spinners behind.
      this.pendingTools.clear();
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    const wasAlive = this.alive;
    this.alive = false;
    const trailing = this.splitter.flush();
    if (trailing)
      this.options.onLog(
        `dropped partial stdout line: ${trailing.slice(0, 200)}`,
      );
    this.pendingTools.clear();
    this.rejectAllPending(new Error("pi session exited"));
    if (wasAlive) this.options.onExit(code, signal);
  }

  private rejectAllPending(reason: Error): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(reason);
    }
    this.pending.clear();
  }
}
