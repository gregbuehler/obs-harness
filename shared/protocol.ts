/**
 * Wire protocol between the Obsidian panel (client) and the local bridge server.
 *
 * The bridge is deliberately thin: pi's own RPC commands and events pass through
 * verbatim, and bridge-specific concerns are namespaced with a `bridge_` prefix
 * so they can never collide with pi's vocabulary.
 *
 * See docs/rpc.md in @earendil-works/pi-coding-agent for the pass-through half.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Default loopback port. Overridable via CLI flag and plugin settings. */
export const DEFAULT_PORT = 8787;

/** WebSocket path served by the bridge. */
export const WS_PATH = "/ws";

/** Prefix reserved for server-originated RPC ids, which are never forwarded to clients. */
export const INTERNAL_ID_PREFIX = "__bridge:";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Attach to (or lazily create) the pi session for a working directory. */
export interface BridgeAttach {
 type: "bridge_attach";
 /** Absolute path used as the pi process cwd; also the session key. */
 cwd: string;
 /** Optional `provider/id` model override, applied only when spawning. */
 model?: string;
 /** Human-readable session name, applied only when spawning. */
 name?: string;
}

/** Ask the server to discard a session's pi process (next attach respawns). */
export interface BridgeReset {
 type: "bridge_reset";
}

/** Liveness probe; the server replies with `bridge_pong`. */
export interface BridgePing {
 type: "bridge_ping";
 id?: string;
}

/** Any pi RPC command, forwarded verbatim to the pi process stdin. */
export interface PiCommandEnvelope {
 type: string;
 id?: string;
 [key: string]: unknown;
}

export type ClientMessage =
 | BridgeAttach
 | BridgeReset
 | BridgePing
 | PiCommandEnvelope;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface BridgeHello {
 type: "bridge_hello";
 protocol: number;
 serverVersion: string;
 piVersion: string | null;
 sessions: string[];
}

/**
 * Full session state on attach, so a panel opened mid-conversation (or
 * reopened after a plugin reload) renders the existing transcript.
 */
export interface BridgeSnapshot {
 type: "bridge_snapshot";
 cwd: string;
 spawned: boolean;
 state: Record<string, unknown> | null;
 messages: unknown[];
 /** Live tool executions started but not yet finished, keyed by toolCallId. */
 pendingTools: { toolCallId: string; toolName: string; args: unknown }[];
}

export type BridgeStatusPhase = "spawning" | "ready" | "exited" | "error";

export interface BridgeStatus {
 type: "bridge_status";
 phase: BridgeStatusPhase;
 cwd?: string;
 detail?: string;
 exitCode?: number | null;
}

export interface BridgeError {
 type: "bridge_error";
 message: string;
 /** Echoes the id of the offending client message, when it had one. */
 id?: string;
}

export interface BridgePong {
 type: "bridge_pong";
 id?: string;
}

/** Anything emitted by pi (events and command responses) passes through as-is. */
export interface PiPassThrough {
 type: string;
 [key: string]: unknown;
}

export type ServerMessage =
 | BridgeHello
 | BridgeSnapshot
 | BridgeStatus
 | BridgeError
 | BridgePong
 | PiPassThrough;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** pi RPC commands the bridge will forward. Anything else is rejected. */
export const FORWARDABLE_COMMANDS: ReadonlySet<string> = new Set([
 "prompt",
 "steer",
 "follow_up",
 "abort",
 "new_session",
 "get_state",
 "get_messages",
 "set_model",
 "cycle_model",
 "get_available_models",
 "set_thinking_level",
 "cycle_thinking_level",
 "get_available_thinking_levels",
 "set_steering_mode",
 "set_follow_up_mode",
 "compact",
 "set_auto_compaction",
 "set_auto_retry",
 "abort_retry",
 "bash",
 "get_session_stats",
 "export_html",
 "set_session_name",
 "list_sessions",
 "load_session",
 "get_commands",
 "extension_ui_response",
]);

/**
 * Runtime handshake state written by the server so the plugin can discover the
 * port and token without the user copying anything by hand.
 */
export interface HandshakeFile {
 version: number;
 port: number;
 token: string;
 pid: number;
 startedAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown parsed payload to something with a string `type`. */
export function messageType(value: unknown): string | null {
 if (!isRecord(value)) return null;
 return typeof value.type === "string" ? value.type : null;
}
