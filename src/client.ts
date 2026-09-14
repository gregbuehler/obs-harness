/**
 * WebSocket client for the bridge, with reconnect and re-attach.
 *
 * Uses the renderer's native WebSocket rather than `ws`, so the plugin bundle
 * stays free of node dependencies. Tokens travel as a query parameter because
 * the browser WebSocket API cannot set request headers.
 */
import { isRecord, messageType } from "../shared/protocol.js";
import type { Endpoint } from "./discovery.js";

export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface BridgeClientHandlers {
  /** Any server message, including pass-through pi events. */
  onMessage: (message: Record<string, unknown>) => void;
  /** Connection phase changed; `detail` is human-readable. */
  onPhase: (phase: ConnectionPhase, detail: string) => void;
  /** Socket opened: the caller should now send bridge_attach. */
  onReady: () => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export class BridgeClient {
  private socket: WebSocket | null = null;
  private readonly handlers: BridgeClientHandlers;
  private endpointFactory: () => Endpoint | null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private phase: ConnectionPhase = "idle";
  /** Commands sent before the socket opened, replayed on ready. */
  private readonly outbox: Record<string, unknown>[] = [];

  constructor(endpointFactory: () => Endpoint | null, handlers: BridgeClientHandlers) {
    this.endpointFactory = endpointFactory;
    this.handlers = handlers;
  }

  get connectionPhase(): ConnectionPhase {
    return this.phase;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();

    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const endpoint = this.endpointFactory();
    if (!endpoint) {
      this.setPhase("failed", "no server found — start the bridge or set a token in settings");
      return;
    }

    this.setPhase(this.backoff === INITIAL_BACKOFF_MS ? "connecting" : "reconnecting", endpoint.url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setPhase("failed", detail);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.setPhase("connected", endpoint.url);
      this.handlers.onReady();
      this.flushOutbox();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(parsed) || !messageType(parsed)) return;
      this.handlers.onMessage(parsed);
    };

    socket.onerror = () => {
      // Detail is intentionally vague: browser WebSocket errors carry no reason.
      if (this.phase !== "connected") this.setPhase("reconnecting", "connection error");
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.disposed) return;
      const reason =
        event.code === 1006
          ? "server unreachable"
          : `closed (${String(event.code)}${event.reason ? `: ${event.reason}` : ""})`;
      this.setPhase("reconnecting", reason);
      this.scheduleReconnect();
    };
  }

  /** Queue a command, sending immediately when the socket is open. */
  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    // Bound the outbox so a long outage cannot grow without limit.
    if (this.outbox.length < 100) this.outbox.push(message);
    this.connect();
  }

  /** Force an immediate reconnect, e.g. after settings change. */
  reconnect(): void {
    this.backoff = INITIAL_BACKOFF_MS;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "reconnecting");
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close(1000, "panel closed");
    }
    this.outbox.length = 0;
    this.setPhase("idle", "closed");
  }

  private flushOutbox(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const queued = this.outbox.splice(0, this.outbox.length);
    for (const message of queued) this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    // Jitter avoids a thundering herd when several panels reconnect together.
    const delay = this.backoff + Math.floor(Math.random() * 250);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setPhase(phase: ConnectionPhase, detail: string): void {
    this.phase = phase;
    this.handlers.onPhase(phase, detail);
  }
}
