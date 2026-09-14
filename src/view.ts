/**
 * The harness panel itself: an ItemView that can live in either sidebar or as a
 * main-area tab. Each panel is a thin client — all agent state lives in the
 * bridge server, so closing and reopening the panel resumes the conversation.
 */
import {
  FileSystemAdapter,
  ItemView,
  Notice,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";

import { isRecord } from "../shared/protocol.js";
import { BridgeClient, type ConnectionPhase } from "./client.js";
import { resolveEndpoint, startServer } from "./discovery.js";
import { Transcript } from "./transcript.js";
import type HarnessPlugin from "./main.js";

export const VIEW_TYPE_HARNESS = "obs-harness-panel";

export class HarnessView extends ItemView {
  private readonly plugin: HarnessPlugin;
  private client: BridgeClient | null = null;
  private transcript: Transcript | null = null;

  private statusDotEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private modelEl: HTMLElement | null = null;
  private queueEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private abortButtonEl: HTMLButtonElement | null = null;
  private sendButtonEl: HTMLButtonElement | null = null;

  private isStreaming = false;
  private attachedCwd: string | null = null;
  /** Autostart is attempted at most once per panel, to avoid spawn storms. */
  private autoStartAttempted = false;

  constructor(leaf: WorkspaceLeaf, plugin: HarnessPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  override getViewType(): string {
    return VIEW_TYPE_HARNESS;
  }

  override getDisplayText(): string {
    return "Pi Harness";
  }

  override getIcon(): string {
    return "bot";
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override async onOpen(): Promise<void> {
    // onOpen can run again on layout restore, so build from a clean slate.
    this.contentEl.empty();
    this.contentEl.addClass("obs-harness");

    this.buildToolbar();
    const scroller = this.contentEl.createDiv({ cls: "oh-transcript" });
    this.buildComposer();

    this.transcript = new Transcript({
      app: this.app,
      component: this,
      container: scroller,
      sourcePath: this.plugin.activeSourcePath(),
      showThinking: this.plugin.settings.showThinking,
      expandTools: this.plugin.settings.expandTools,
      onDialogResponse: (response) => this.client?.send(response),
    });

    this.client = new BridgeClient(
      () => resolveEndpoint(this.plugin.settings),
      {
        onMessage: (message) => this.onServerMessage(message),
        onPhase: (phase, detail) => this.onPhase(phase, detail),
        onReady: () => this.attach(),
      },
    );

    this.client.connect();
    // A missing server is the common first-run case; offer to fix it silently.
    if (this.client.connectionPhase === "failed") this.tryAutoStart();
  }

  override async onClose(): Promise<void> {
    this.client?.dispose();
    this.client = null;
    this.transcript = null;
    this.attachedCwd = null;
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  private buildToolbar(): void {
    const bar = this.contentEl.createDiv({ cls: "oh-toolbar" });

    const status = bar.createDiv({ cls: "oh-status" });
    this.statusDotEl = status.createSpan({ cls: "oh-status__dot" });
    this.statusTextEl = status.createSpan({
      cls: "oh-status__text",
      text: "connecting…",
    });

    bar.createDiv({ cls: "oh-toolbar__spacer" });
    this.queueEl = bar.createSpan({ cls: "oh-queue" });

    const iconButton = (
      icon: string,
      tooltip: string,
      onClick: () => void,
    ): void => {
      const button = bar.createEl("button", {
        cls: "oh-icon-button",
        attr: { "aria-label": tooltip },
      });
      setIcon(button, icon);
      button.setAttribute("title", tooltip);
      this.registerDomEvent(button, "click", onClick);
    };

    iconButton("rotate-ccw", "New session", () => this.newSession());
    iconButton("plug-zap", "Reconnect", () => this.reconnect());
    iconButton("arrow-down-to-line", "Scroll to bottom", () =>
      this.transcript?.scrollToBottom(),
    );
  }

  private buildComposer(): void {
    const composer = this.contentEl.createDiv({ cls: "oh-composer" });

    const input = composer.createEl("textarea", {
      cls: "oh-composer__input",
      attr: {
        rows: "3",
        // Short placeholder: the long form clipped in a narrow sidebar. The
        // key hint lives in the tooltip instead.
        placeholder: "Ask pi…",
        title: "Enter to send · Shift+Enter for a newline · Esc to stop",
      },
    });
    this.inputEl = input;

    this.registerDomEvent(input, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
        return;
      }
      // Escape is the fastest possible "stop" while output is scrolling past.
      if (event.key === "Escape" && this.isStreaming) {
        event.preventDefault();
        this.abort();
      }
    });
    this.registerDomEvent(input, "input", () => this.autoGrow());

    const actions = composer.createDiv({ cls: "oh-composer__actions" });
    this.modelEl = actions.createSpan({ cls: "oh-model", text: "—" });
    actions.createDiv({ cls: "oh-toolbar__spacer" });

    const abort = actions.createEl("button", {
      cls: "oh-button mod-warning",
      text: "Stop",
    });
    abort.hide();
    this.registerDomEvent(abort, "click", () => this.abort());
    this.abortButtonEl = abort;

    const send = actions.createEl("button", {
      cls: "oh-button mod-cta",
      text: "Send",
    });
    this.registerDomEvent(send, "click", () => this.submit());
    this.sendButtonEl = send;
  }

  private autoGrow(): void {
    const input = this.inputEl;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${String(Math.min(input.scrollHeight, 240))}px`;
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /** The agent's cwd, which doubles as the bridge session key. */
  private resolveCwd(): string | null {
    const settings = this.plugin.settings;
    if (settings.cwdMode === "custom") return settings.customCwd || null;
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  private attach(): void {
    const cwd = this.resolveCwd();
    if (!cwd) {
      this.transcript?.system(
        "cannot determine a working directory — set one in plugin settings",
        "error",
      );
      return;
    }
    const payload: Record<string, unknown> = { type: "bridge_attach", cwd };
    if (this.plugin.settings.model) payload.model = this.plugin.settings.model;
    payload.name = "obsidian";
    this.client?.send(payload);
  }

  reconnect(): void {
    this.autoStartAttempted = false;
    this.client?.reconnect();
    if (this.client?.connectionPhase === "failed") this.tryAutoStart();
  }

  /** Spawn the bundled server when nothing is listening and the user allows it. */
  private tryAutoStart(): void {
    if (this.autoStartAttempted || !this.plugin.settings.autoStartServer)
      return;
    this.autoStartAttempted = true;

    const pluginDir = this.plugin.absolutePluginDir();
    if (!pluginDir) {
      this.transcript?.system(
        "cannot locate the plugin directory to start the server",
        "error",
      );
      return;
    }
    const result = startServer(this.plugin.settings, pluginDir);
    this.transcript?.system(result.detail, result.ok ? "info" : "error");
    if (!result.ok) return;

    // Give the server a moment to bind and write its handshake file.
    window.setTimeout(() => this.client?.reconnect(), 900);
  }

  private onPhase(phase: ConnectionPhase, detail: string): void {
    const label: Record<ConnectionPhase, string> = {
      idle: "disconnected",
      connecting: "connecting…",
      connected: "connected",
      reconnecting: "reconnecting…",
      failed: "no server",
    };
    this.setStatus(
      label[phase],
      phase === "connected" ? "ok" : phase === "failed" ? "error" : "warn",
    );
    if (phase === "failed") {
      this.transcript?.system(detail, "error");
      this.tryAutoStart();
    }
    if (phase !== "connected") {
      this.setStreaming(false);
      this.attachedCwd = null;
    }
  }

  private setStatus(text: string, kind: "ok" | "warn" | "error"): void {
    this.statusTextEl?.setText(text);
    const dot = this.statusDotEl;
    if (!dot) return;
    dot.removeClass("is-ok", "is-warn", "is-error");
    dot.addClass(`is-${kind}`);
  }

  // -------------------------------------------------------------------------
  // Server messages
  // -------------------------------------------------------------------------

  private onServerMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "bridge_hello": {
        const piVersion =
          typeof message.piVersion === "string" ? message.piVersion : null;
        if (piVersion) this.setStatus(`connected · pi ${piVersion}`, "ok");
        return;
      }
      case "bridge_snapshot":
        this.onSnapshot(message);
        return;
      case "bridge_status":
        this.onBridgeStatus(message);
        return;
      case "bridge_error":
        this.transcript?.system(
          typeof message.message === "string"
            ? message.message
            : "bridge error",
          "error",
        );
        return;
      case "bridge_pong":
        return;
      case "response":
        this.onCommandResponse(message);
        return;
      case "agent_start":
        this.setStreaming(true);
        return;
      case "agent_settled":
        this.setStreaming(false);
        return;
      case "queue_update":
        this.onQueueUpdate(message);
        return;
      default:
        this.transcript?.handleEvent(message);
    }
  }

  private onSnapshot(message: Record<string, unknown>): void {
    const transcript = this.transcript;
    if (!transcript) return;

    this.attachedCwd = typeof message.cwd === "string" ? message.cwd : null;
    // Rebuild from scratch: the snapshot is authoritative for this session.
    transcript.clear();

    const spawned = message.spawned === true;
    if (this.attachedCwd) {
      transcript.system(
        `${spawned ? "started" : "reattached to"} session in ${this.attachedCwd}`,
        "info",
      );
    }

    const messages = Array.isArray(message.messages) ? message.messages : [];
    const pendingTools = Array.isArray(message.pendingTools)
      ? message.pendingTools
      : [];
    transcript.renderSnapshot(messages, pendingTools);

    const state = isRecord(message.state) ? message.state : null;
    this.applyState(state);
  }

  private applyState(state: Record<string, unknown> | null): void {
    if (!state) return;
    const model = isRecord(state.model) ? state.model : null;
    const name = model && typeof model.name === "string" ? model.name : null;
    const thinking =
      typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
    if (name) {
      this.modelEl?.setText(
        thinking && thinking !== "off" ? `${name} · ${thinking}` : name,
      );
    }
    if (state.isStreaming === true) this.setStreaming(true);
  }

  private onBridgeStatus(message: Record<string, unknown>): void {
    const phase = typeof message.phase === "string" ? message.phase : "";
    if (phase === "spawning") {
      this.setStatus("starting agent…", "warn");
      return;
    }
    if (phase === "exited") {
      this.setStreaming(false);
      const code =
        typeof message.exitCode === "number"
          ? ` (exit ${String(message.exitCode)})`
          : "";
      const detail =
        typeof message.detail === "string" ? `: ${message.detail}` : "";
      this.transcript?.system(`agent stopped${code}${detail}`, "warn");
      this.setStatus("agent stopped", "warn");
      this.attachedCwd = null;
      return;
    }
    if (phase === "error") {
      const detail =
        typeof message.detail === "string" ? message.detail : "unknown error";
      this.transcript?.system(`could not start agent: ${detail}`, "error");
      this.setStatus("agent failed", "error");
    }
  }

  private onCommandResponse(message: Record<string, unknown>): void {
    const command = typeof message.command === "string" ? message.command : "";
    if (message.success !== true) {
      const error =
        typeof message.error === "string" ? message.error : "command failed";
      this.transcript?.system(`${command || "command"}: ${error}`, "error");
      return;
    }

    const data = isRecord(message.data) ? message.data : null;
    if (command === "new_session") {
      if (data?.cancelled === true) {
        this.transcript?.system(
          "new session cancelled by an extension",
          "warn",
        );
        return;
      }
      this.transcript?.clear();
      this.transcript?.system("new session", "info");
      return;
    }
    if (command === "cycle_model" || command === "set_model") {
      const model = isRecord(data?.model) ? data.model : data;
      const name = model && typeof model.name === "string" ? model.name : null;
      if (name) this.modelEl?.setText(name);
      return;
    }
    if (command === "get_state") this.applyState(data);
  }

  private onQueueUpdate(message: Record<string, unknown>): void {
    const steering = Array.isArray(message.steering)
      ? message.steering.length
      : 0;
    const followUp = Array.isArray(message.followUp)
      ? message.followUp.length
      : 0;
    const total = steering + followUp;
    this.queueEl?.setText(total > 0 ? `${String(total)} queued` : "");
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private submit(): void {
    const input = this.inputEl;
    const client = this.client;
    if (!input || !client) return;

    const text = input.value.trim();
    if (!text) return;
    if (!client.isConnected) {
      new Notice("Pi Harness: not connected to the bridge server.");
      return;
    }
    if (!this.attachedCwd) {
      new Notice("Pi Harness: no agent session attached yet.");
      return;
    }

    this.transcript?.userEcho(text);
    // Mid-run input becomes steering, which pi delivers at the next safe point.
    client.send(
      this.isStreaming
        ? { type: "steer", message: text }
        : { type: "prompt", message: text },
    );

    input.value = "";
    this.autoGrow();
    this.transcript?.scrollToBottom();
  }

  private abort(): void {
    this.client?.send({ type: "abort" });
  }

  private newSession(): void {
    if (!this.client?.isConnected) {
      new Notice("Pi Harness: not connected to the bridge server.");
      return;
    }
    this.client.send({ type: "new_session" });
  }

  private setStreaming(streaming: boolean): void {
    if (this.isStreaming === streaming) return;
    this.isStreaming = streaming;
    this.contentEl.toggleClass("is-streaming", streaming);
    if (streaming) {
      this.abortButtonEl?.show();
      this.sendButtonEl?.setText("Steer");
      this.setStatus("working…", "warn");
    } else {
      this.abortButtonEl?.hide();
      this.sendButtonEl?.setText("Send");
      if (this.client?.isConnected) this.setStatus("ready", "ok");
    }
  }
}
