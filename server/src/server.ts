/**
 * Bridge server: owns pi sessions, fans their event streams out to any number
 * of Obsidian panels, and forwards panel commands back into pi.
 *
 * Session identity is the resolved working directory, so every panel opened on
 * the same vault shares one agent — and a plugin reload reattaches to the
 * running conversation instead of starting over.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";

import {
  BRIDGE_PROTOCOL_VERSION,
  FORWARDABLE_COMMANDS,
  INTERNAL_ID_PREFIX,
  WS_PATH,
  isRecord,
  messageType,
  type BridgeSnapshot,
  type BridgeStatusPhase,
  type ServerMessage,
} from "../../shared/protocol.js";
import { PiSession } from "./pi-session.js";

/** Extension UI methods that block pi until the client answers. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Short description of a dialog answer, broadcast to the panels that did not
 * answer it.
 *
 * Bounded on purpose, unlike the answering panel's own card: this is a
 * cross-panel notification rather than the authoritative record, and an
 * `editor` dialog's value can be arbitrarily large.
 */
function describeDialogAnswer(
  message: Record<string, unknown>,
): string | undefined {
  if (message.cancelled === true) return "cancelled";
  const value = message.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 497)}\u2026` : value;
  }
  return undefined;
}

export interface HarnessServerOptions {
  port: number;
  host: string;
  token: string;
  piPath: string;
  serverVersion: string;
  piVersion: string | null;
  /** Drop a session this many ms after its last client leaves. 0 disables. */
  idleTimeoutMs: number;
  log: (message: string) => void;
}

interface ClientState {
  socket: WebSocket;
  /** Session key (resolved cwd) this client is attached to, if any. */
  cwd: string | null;
}

interface SessionEntry {
  session: PiSession;
  clients: Set<WebSocket>;
  /** Dialog requests pi is blocked on, so exactly one response is forwarded. */
  pendingDialogs: Set<string>;
  idleTimer: NodeJS.Timeout | null;
}

export class HarnessServer {
  private readonly options: HarnessServerOptions;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(options: HarnessServerOptions) {
    this.options = options;
    this.http = createServer((req, res) => {
      // A tiny health endpoint lets the plugin probe liveness before connecting.
      if (req.url?.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, sessions: [...this.sessions.keys()] }),
        );
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      if (!this.isAuthorized(req)) {
        this.options.log(
          `rejected upgrade from ${req.socket.remoteAddress ?? "?"}`,
        );
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.removeListener("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const [, entry] of this.sessions) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.session.dispose();
    }
    this.sessions.clear();
    for (const socket of this.clients.keys())
      socket.close(1001, "server shutting down");
    this.clients.clear();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * Loopback binding plus a shared token. The token is compared in constant
   * time; length mismatch is rejected before comparison since timingSafeEqual
   * throws on unequal buffers.
   */
  private isAuthorized(req: IncomingMessage): boolean {
    if (!req.url) return false;
    let provided: string | null = null;
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== WS_PATH) return false;
      provided = url.searchParams.get("token");
    } catch {
      return false;
    }
    const header = req.headers["authorization"];
    if (
      !provided &&
      typeof header === "string" &&
      header.startsWith("Bearer ")
    ) {
      provided = header.slice("Bearer ".length);
    }
    if (!provided) return false;

    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(this.options.token, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    this.clients.set(socket, { socket, cwd: null });
    this.options.log(`client connected (${this.clients.size} total)`);

    this.sendTo(socket, {
      type: "bridge_hello",
      protocol: BRIDGE_PROTOCOL_VERSION,
      serverVersion: this.options.serverVersion,
      piVersion: this.options.piVersion,
      sessions: [...this.sessions.keys()],
    });

    socket.on("message", (raw) => {
      void this.onClientMessage(socket, raw.toString());
    });
    socket.on("close", () => this.onClientClose(socket));
    socket.on("error", (err) =>
      this.options.log(`client socket error: ${err.message}`),
    );
  }

  private onClientClose(socket: WebSocket): void {
    const state = this.clients.get(socket);
    this.clients.delete(socket);
    if (state?.cwd) this.detach(state.cwd, socket);
    this.options.log(`client disconnected (${this.clients.size} remain)`);
  }

  private async onClientMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendTo(socket, { type: "bridge_error", message: "invalid JSON" });
      return;
    }

    const type = messageType(parsed);
    if (!type || !isRecord(parsed)) {
      this.sendTo(socket, {
        type: "bridge_error",
        message: "message needs a string 'type'",
      });
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : undefined;

    // Clients must never be able to impersonate a bridge-internal request and
    // steal a response the server is awaiting.
    if (id?.startsWith(INTERNAL_ID_PREFIX)) {
      this.sendTo(socket, {
        type: "bridge_error",
        id,
        message: "reserved id prefix",
      });
      return;
    }

    switch (type) {
      case "bridge_ping":
        this.sendTo(socket, { type: "bridge_pong", id });
        return;
      case "bridge_attach":
        await this.handleAttach(socket, parsed);
        return;
      case "bridge_reset":
        this.handleReset(socket);
        return;
      default:
        this.handleForward(socket, type, parsed, id);
    }
  }

  // -------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------

  private async handleAttach(
    socket: WebSocket,
    message: Record<string, unknown>,
  ): Promise<void> {
    const requested = typeof message.cwd === "string" ? message.cwd : null;
    if (!requested) {
      this.sendTo(socket, {
        type: "bridge_error",
        message: "bridge_attach requires 'cwd'",
      });
      return;
    }

    let key: string;
    try {
      key = await realpath(requested);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.sendTo(socket, {
        type: "bridge_error",
        message: `unusable cwd: ${detail}`,
      });
      return;
    }

    const state = this.clients.get(socket);
    if (!state) return;
    if (state.cwd && state.cwd !== key) this.detach(state.cwd, socket);

    let entry = this.sessions.get(key);
    const spawned = !entry || !entry.session.isAlive;

    if (entry && !entry.session.isAlive) {
      this.sessions.delete(key);
      entry = undefined;
    }

    if (!entry) {
      this.status(socket, "spawning", { cwd: key });
      try {
        entry = this.createSession(key, message);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.status(socket, "error", { cwd: key, detail });
        return;
      }
      this.sessions.set(key, entry);
    }

    entry.clients.add(socket);
    state.cwd = key;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    this.status(socket, "ready", { cwd: key });
    await this.sendSnapshot(socket, entry, key, spawned);
  }

  private createSession(
    key: string,
    message: Record<string, unknown>,
  ): SessionEntry {
    const entry: SessionEntry = {
      clients: new Set(),
      pendingDialogs: new Set(),
      idleTimer: null,
      session: new PiSession({
        piPath: this.options.piPath,
        cwd: key,
        model: typeof message.model === "string" ? message.model : undefined,
        name: typeof message.name === "string" ? message.name : undefined,
        onMessage: (piMessage) => this.onPiMessage(key, piMessage),
        onExit: (code, signal) => {
          this.options.log(
            `pi exited for ${key} (code=${code} signal=${signal ?? "none"})`,
          );
          const dead = this.sessions.get(key);
          if (dead) {
            this.broadcast(key, {
              type: "bridge_status",
              phase: "exited",
              cwd: key,
              exitCode: code,
              detail: signal ? `signal ${signal}` : undefined,
            });
            if (dead.idleTimer) clearTimeout(dead.idleTimer);
            this.sessions.delete(key);
          }
        },
        onLog: (line) => this.options.log(`[pi ${key}] ${line}`),
      }),
    };
    this.options.log(`spawned pi session for ${key}`);
    return entry;
  }

  /**
   * Rebuild client-visible state from pi itself rather than from a replay
   * buffer, so a reattaching panel is authoritative even after compaction.
   */
  private async sendSnapshot(
    socket: WebSocket,
    entry: SessionEntry,
    key: string,
    spawned: boolean,
  ): Promise<void> {
    let state: Record<string, unknown> | null = null;
    let messages: unknown[] = [];

    try {
      const [stateRes, messagesRes] = await Promise.all([
        entry.session.request({ type: "get_state" }),
        entry.session.request({ type: "get_messages" }),
      ]);
      const stateData = stateRes.data;
      if (isRecord(stateData)) state = stateData;
      const messageData = messagesRes.data;
      if (isRecord(messageData) && Array.isArray(messageData.messages)) {
        messages = messageData.messages;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.options.log(`snapshot for ${key} degraded: ${detail}`);
    }

    const snapshot: BridgeSnapshot = {
      type: "bridge_snapshot",
      cwd: key,
      spawned,
      state,
      messages,
      pendingTools: entry.session.livePendingTools,
    };
    this.sendTo(socket, snapshot);
  }

  private detach(key: string, socket: WebSocket): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    entry.clients.delete(socket);
    if (entry.clients.size > 0 || this.options.idleTimeoutMs <= 0) return;

    // Last panel closed: keep the agent warm briefly, then reclaim it.
    entry.idleTimer = setTimeout(() => {
      const current = this.sessions.get(key);
      if (!current || current.clients.size > 0) return;
      this.options.log(`reclaiming idle session ${key}`);
      current.session.dispose();
      this.sessions.delete(key);
    }, this.options.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private handleReset(socket: WebSocket): void {
    const state = this.clients.get(socket);
    if (!state?.cwd) {
      this.sendTo(socket, { type: "bridge_error", message: "not attached" });
      return;
    }
    const key = state.cwd;
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.options.log(`reset requested for ${key}`);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.session.dispose();
    this.sessions.delete(key);
    this.broadcast(key, {
      type: "bridge_status",
      phase: "exited",
      cwd: key,
      detail: "reset",
    });
  }

  // -------------------------------------------------------------------------
  // Command forwarding
  // -------------------------------------------------------------------------

  private handleForward(
    socket: WebSocket,
    type: string,
    message: Record<string, unknown>,
    id: string | undefined,
  ): void {
    const state = this.clients.get(socket);
    const key = state?.cwd;
    if (!key) {
      this.sendTo(socket, {
        type: "bridge_error",
        id,
        message: "send bridge_attach first",
      });
      return;
    }
    const entry = this.sessions.get(key);
    if (!entry?.session.isAlive) {
      this.sendTo(socket, {
        type: "bridge_error",
        id,
        message: "pi session is not running",
      });
      return;
    }
    if (!FORWARDABLE_COMMANDS.has(type)) {
      this.sendTo(socket, {
        type: "bridge_error",
        id,
        message: `command not allowed: ${type}`,
      });
      return;
    }

    // Dialog answers are single-use: whichever panel replies first wins, and
    // late duplicates are dropped so pi never sees two answers for one prompt.
    if (type === "extension_ui_response") {
      const dialogId = typeof message.id === "string" ? message.id : null;
      if (!dialogId || !entry.pendingDialogs.delete(dialogId)) return;
      entry.session.send(message);
      // Tell every panel the dialog is retired, so the ones that did not answer
      // stop showing live buttons for a decision pi has already moved past.
      this.broadcast(key, {
        type: "bridge_dialog_resolved",
        dialogId,
        reason: message.cancelled === true ? "cancelled" : "answered",
        answer: describeDialogAnswer(message),
      });
      return;
    }

    entry.session.send(message);
  }

  // -------------------------------------------------------------------------
  // pi -> clients
  // -------------------------------------------------------------------------

  private onPiMessage(key: string, message: Record<string, unknown>): void {
    if (message.type === "extension_ui_request") {
      this.routeDialog(key, message);
      return;
    }
    this.broadcast(key, message);
  }

  /**
   * Blocking dialogs must be answered or pi stalls forever. With no panel
   * attached there is nobody to ask, so cancel immediately.
   */
  private routeDialog(key: string, message: Record<string, unknown>): void {
    const entry = this.sessions.get(key);
    if (!entry) return;

    const method = typeof message.method === "string" ? message.method : "";
    const dialogId = typeof message.id === "string" ? message.id : null;
    const blocking = DIALOG_METHODS.has(method);

    if (blocking && dialogId) {
      if (entry.clients.size === 0) {
        this.options.log(
          `auto-cancelling '${method}' dialog for ${key}: no clients attached`,
        );
        entry.session.send({
          type: "extension_ui_response",
          id: dialogId,
          cancelled: true,
        });
        // A panel can attach moments later and would otherwise render a card
        // for an already-cancelled dialog.
        this.broadcast(key, {
          type: "bridge_dialog_resolved",
          dialogId,
          reason: "no-clients",
        });
        return;
      }
      entry.pendingDialogs.add(dialogId);
    }

    this.broadcast(key, message);
  }

  private broadcast(
    key: string,
    message: ServerMessage | Record<string, unknown>,
  ): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    const payload = JSON.stringify(message);
    for (const socket of entry.clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  private status(
    socket: WebSocket,
    phase: BridgeStatusPhase,
    extra: { cwd?: string; detail?: string } = {},
  ): void {
    this.sendTo(socket, { type: "bridge_status", phase, ...extra });
  }
}
