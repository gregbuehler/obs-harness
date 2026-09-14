/**
 * Transcript rendering: turns pi's RPC event stream into DOM.
 *
 * Streaming text is appended as plain text for cheapness, then re-rendered
 * through Obsidian's markdown pipeline once a block completes, so the finished
 * transcript looks like the rest of the vault (callouts, code blocks, wikilinks).
 */
import { MarkdownRenderer, setIcon, type App, type Component } from "obsidian";

import { isRecord } from "../shared/protocol.js";

export interface TranscriptOptions {
  app: App;
  /** Lifecycle owner for markdown rendering (the view). */
  component: Component;
  container: HTMLElement;
  /** Note path used to resolve relative links in rendered markdown. */
  sourcePath: string;
  showThinking: boolean;
  expandTools: boolean;
  /** Send an extension_ui_response back through the bridge. */
  onDialogResponse: (response: Record<string, unknown>) => void;
}

type BlockKind = "text" | "thinking" | "toolcall";

interface StreamBlock {
  kind: BlockKind;
  buffer: string;
  bodyEl: HTMLElement;
  toolCallId: string | null;
}

interface ToolBlock {
  details: HTMLDetailsElement;
  labelEl: HTMLElement;
  statusEl: HTMLElement;
  argsEl: HTMLElement;
  resultEl: HTMLElement;
}

interface AssistantRender {
  wrapper: HTMLElement;
  contentEl: HTMLElement;
  blocks: Map<number, StreamBlock>;
}

/** Flatten pi's content-block arrays into display text. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (isRecord(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line argument preview for a collapsed tool row. */
function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return "";
  for (const key of [
    "command",
    "path",
    "file_path",
    "pattern",
    "query",
    "url",
    "subject",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 120 ? `${value.slice(0, 117)}…` : value;
    }
  }
  const keys = Object.keys(args);
  return keys.length > 0 ? keys.join(", ") : "";
}

export class Transcript {
  private readonly options: TranscriptOptions;
  private readonly container: HTMLElement;
  private readonly toolBlocks = new Map<string, ToolBlock>();
  private current: AssistantRender | null = null;
  private stickToBottom = true;
  /** Optimistic user echoes awaiting confirmation from pi's own event. */
  private unconfirmedUserEchoes: string[] = [];

  constructor(options: TranscriptOptions) {
    this.options = options;
    this.container = options.container;

    this.container.addEventListener("scroll", () => {
      const distance =
        this.container.scrollHeight -
        this.container.scrollTop -
        this.container.clientHeight;
      this.stickToBottom = distance < 48;
    });
  }

  clear(): void {
    this.container.empty();
    this.toolBlocks.clear();
    this.current = null;
    this.unconfirmedUserEchoes = [];
    this.stickToBottom = true;
  }

  // -------------------------------------------------------------------------
  // Simple rows
  // -------------------------------------------------------------------------

  system(text: string, kind: "info" | "warn" | "error" = "info"): void {
    const row = this.container.createDiv({
      cls: `oh-system oh-system--${kind}`,
    });
    row.createSpan({ cls: "oh-system__text", text });
    this.autoScroll();
  }

  /** Render a user message immediately, before pi echoes it back. */
  userEcho(text: string): void {
    this.unconfirmedUserEchoes.push(text);
    this.renderUser(text);
  }

  private renderUser(text: string): void {
    const wrapper = this.container.createDiv({ cls: "oh-msg oh-msg--user" });
    wrapper.createDiv({ cls: "oh-msg__role", text: "you" });
    const body = wrapper.createDiv({ cls: "oh-msg__body" });
    void MarkdownRenderer.render(
      this.options.app,
      text,
      body,
      this.options.sourcePath,
      this.options.component,
    );
    this.autoScroll();
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  /** Handle one pi event. Unknown event types are ignored on purpose. */
  handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "message_start":
        this.onMessageStart(event);
        return;
      case "message_update":
        this.onMessageUpdate(event);
        return;
      case "message_end":
        this.onMessageEnd(event);
        return;
      case "tool_execution_start":
        this.onToolStart(event);
        return;
      case "tool_execution_update":
        this.onToolUpdate(event);
        return;
      case "tool_execution_end":
        this.onToolEnd(event);
        return;
      case "bash_execution_update":
        this.onBashUpdate(event);
        return;
      case "compaction_end":
        this.system("context compacted", "info");
        return;
      case "auto_retry_start":
        this.system(
          `retrying after transient error${this.retryDetail(event)}`,
          "warn",
        );
        return;
      case "extension_error": {
        const message =
          typeof event.error === "string" ? event.error : "extension error";
        this.system(message, "error");
        return;
      }
      case "extension_ui_request":
        this.onExtensionUi(event);
        return;
      default:
        return;
    }
  }

  private retryDetail(event: Record<string, unknown>): string {
    const attempt = event.attempt;
    return typeof attempt === "number" ? ` (attempt ${String(attempt)})` : "";
  }

  private onMessageStart(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : null;
    const role =
      message && typeof message.role === "string" ? message.role : null;

    if (role === "user") {
      // Deduplicate against the optimistic echo rendered on send.
      const text = extractText(message?.content);
      const index = this.unconfirmedUserEchoes.indexOf(text);
      if (index !== -1) {
        this.unconfirmedUserEchoes.splice(index, 1);
        return;
      }
      this.renderUser(text);
      return;
    }
    if (role === "assistant") this.beginAssistant();
  }

  private beginAssistant(): AssistantRender {
    const wrapper = this.container.createDiv({
      cls: "oh-msg oh-msg--assistant",
    });
    wrapper.createDiv({ cls: "oh-msg__role", text: "pi" });
    const contentEl = wrapper.createDiv({ cls: "oh-msg__body" });
    const render: AssistantRender = { wrapper, contentEl, blocks: new Map() };
    this.current = render;
    this.autoScroll();
    return render;
  }

  /**
   * `message_end.message` is authoritative. Any block still streaming (e.g. the
   * turn ended without a matching text_end) gets its final render here before
   * the assistant row is sealed off.
   */
  private onMessageEnd(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : null;
    const role =
      message && typeof message.role === "string" ? message.role : null;
    if (role !== null && role !== "assistant") return;

    const render = this.current;
    if (render) {
      for (const block of render.blocks.values()) {
        if (!block.bodyEl.hasClass("oh-stream")) continue;
        block.bodyEl.removeClass("oh-stream");
        if (block.kind !== "text") continue;
        const text = block.buffer;
        block.bodyEl.empty();
        void MarkdownRenderer.render(
          this.options.app,
          text,
          block.bodyEl,
          this.options.sourcePath,
          this.options.component,
        );
      }
      this.current = null;
    }

    const stopReason =
      message && typeof message.stopReason === "string"
        ? message.stopReason
        : "";
    if (stopReason === "aborted") this.system("aborted", "warn");
    if (stopReason === "error")
      this.system("the model returned an error", "error");
    if (stopReason === "length")
      this.system("response truncated at the token limit", "warn");
    this.autoScroll();
  }

  private onMessageUpdate(event: Record<string, unknown>): void {
    const delta = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : null;
    if (!delta || typeof delta.type !== "string") return;
    const contentIndex =
      typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
    const render = this.current ?? this.beginAssistant();

    switch (delta.type) {
      case "text_start":
        this.openBlock(render, contentIndex, "text");
        return;
      case "text_delta":
        this.appendDelta(render, contentIndex, "text", delta.delta);
        return;
      case "text_end":
        this.closeTextBlock(render, contentIndex, delta.content, "text");
        return;
      case "thinking_start":
        if (this.options.showThinking)
          this.openBlock(render, contentIndex, "thinking");
        return;
      case "thinking_delta":
        if (this.options.showThinking) {
          this.appendDelta(render, contentIndex, "thinking", delta.delta);
        }
        return;
      case "thinking_end":
        if (this.options.showThinking) {
          this.closeTextBlock(render, contentIndex, delta.content, "thinking");
        }
        return;
      case "toolcall_start":
        this.openBlock(render, contentIndex, "toolcall");
        return;
      case "toolcall_delta":
        this.appendDelta(render, contentIndex, "toolcall", delta.delta);
        return;
      case "toolcall_end":
        this.finishToolCall(render, contentIndex, delta.toolCall);
        return;
      default:
        return;
    }
  }

  private openBlock(
    render: AssistantRender,
    index: number,
    kind: BlockKind,
  ): StreamBlock {
    const existing = render.blocks.get(index);
    if (existing) return existing;

    let bodyEl: HTMLElement;
    if (kind === "thinking") {
      const details = render.contentEl.createEl("details", {
        cls: "oh-thinking",
      });
      details.createEl("summary", { text: "thinking" });
      bodyEl = details.createDiv({ cls: "oh-thinking__body oh-stream" });
    } else if (kind === "toolcall") {
      // Provisional block: the real tool id only arrives with toolcall_end.
      const details = render.contentEl.createEl("details", { cls: "oh-tool" });
      details.open = this.options.expandTools;
      const summary = details.createEl("summary", { cls: "oh-tool__summary" });
      const icon = summary.createSpan({ cls: "oh-tool__icon" });
      setIcon(icon, "wrench");
      summary.createSpan({ cls: "oh-tool__label", text: "tool call" });
      summary.createSpan({ cls: "oh-tool__status", text: "…" });
      bodyEl = details.createEl("pre", { cls: "oh-tool__args oh-stream" });
    } else {
      bodyEl = render.contentEl.createDiv({ cls: "oh-text oh-stream" });
    }

    const block: StreamBlock = { kind, buffer: "", bodyEl, toolCallId: null };
    render.blocks.set(index, block);
    return block;
  }

  private appendDelta(
    render: AssistantRender,
    index: number,
    kind: BlockKind,
    delta: unknown,
  ): void {
    if (typeof delta !== "string" || delta.length === 0) return;
    const block =
      render.blocks.get(index) ?? this.openBlock(render, index, kind);
    block.buffer += delta;
    block.bodyEl.setText(block.buffer);
    this.autoScroll();
  }

  /**
   * Finalize a streamed block. Assistant prose is re-rendered through the
   * markdown pipeline; thinking stays verbatim, since it is frequently full of
   * half-formed markdown that renders as noise.
   */
  private closeTextBlock(
    render: AssistantRender,
    index: number,
    content: unknown,
    kind: BlockKind,
  ): void {
    const block = render.blocks.get(index);
    if (!block) return;
    const finalText = typeof content === "string" ? content : block.buffer;
    block.buffer = finalText;
    block.bodyEl.removeClass("oh-stream");

    if (kind === "thinking") {
      block.bodyEl.setText(finalText);
      this.autoScroll();
      return;
    }

    block.bodyEl.empty();
    void MarkdownRenderer.render(
      this.options.app,
      finalText,
      block.bodyEl,
      this.options.sourcePath,
      this.options.component,
    );
    this.autoScroll();
  }

  /**
   * Promote the provisional streaming block into a tool block keyed by
   * toolCallId, so later execution events land in the same element.
   */
  private finishToolCall(
    render: AssistantRender,
    index: number,
    toolCall: unknown,
  ): void {
    const block = render.blocks.get(index);
    if (!block) return;

    const call = isRecord(toolCall) ? toolCall : {};
    const toolCallId = typeof call.id === "string" ? call.id : null;
    const name = typeof call.name === "string" ? call.name : "tool";
    const args = call.arguments;

    const details = block.bodyEl.closest("details.oh-tool");
    if (!(details instanceof HTMLDetailsElement)) return;

    const labelEl = details.querySelector<HTMLElement>(".oh-tool__label");
    const statusEl = details.querySelector<HTMLElement>(".oh-tool__status");
    if (labelEl) {
      labelEl.setText(name);
      const summary = summarizeArgs(args);
      if (summary)
        labelEl.createSpan({ cls: "oh-tool__preview", text: ` ${summary}` });
    }
    if (statusEl) statusEl.setText("queued");

    block.bodyEl.removeClass("oh-stream");
    block.bodyEl.setText(prettyJson(args ?? block.buffer));
    block.toolCallId = toolCallId;

    if (toolCallId && labelEl && statusEl) {
      this.toolBlocks.set(toolCallId, {
        details,
        labelEl,
        statusEl,
        argsEl: block.bodyEl,
        resultEl: details.createEl("pre", { cls: "oh-tool__result" }),
      });
    }
    this.autoScroll();
  }

  // -------------------------------------------------------------------------
  // Tool execution
  // -------------------------------------------------------------------------

  /** Reuse the streamed block when present; otherwise synthesize one. */
  private ensureToolBlock(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): ToolBlock {
    const existing = this.toolBlocks.get(toolCallId);
    if (existing) return existing;

    const host = this.current?.contentEl ?? this.container;
    const details = host.createEl("details", { cls: "oh-tool" });
    details.open = this.options.expandTools;
    const summary = details.createEl("summary", { cls: "oh-tool__summary" });
    const icon = summary.createSpan({ cls: "oh-tool__icon" });
    setIcon(icon, "wrench");
    const labelEl = summary.createSpan({
      cls: "oh-tool__label",
      text: toolName,
    });
    const preview = summarizeArgs(args);
    if (preview)
      labelEl.createSpan({ cls: "oh-tool__preview", text: ` ${preview}` });
    const statusEl = summary.createSpan({ cls: "oh-tool__status", text: "…" });
    const argsEl = details.createEl("pre", {
      cls: "oh-tool__args",
      text: prettyJson(args),
    });
    const resultEl = details.createEl("pre", { cls: "oh-tool__result" });

    const block: ToolBlock = { details, labelEl, statusEl, argsEl, resultEl };
    this.toolBlocks.set(toolCallId, block);
    return block;
  }

  private onToolStart(event: Record<string, unknown>): void {
    const toolCallId =
      typeof event.toolCallId === "string" ? event.toolCallId : null;
    if (!toolCallId) return;
    const toolName =
      typeof event.toolName === "string" ? event.toolName : "tool";
    const block = this.ensureToolBlock(toolCallId, toolName, event.args);
    block.details.addClass("is-running");
    block.statusEl.setText("running");
    this.autoScroll();
  }

  private onToolUpdate(event: Record<string, unknown>): void {
    const toolCallId =
      typeof event.toolCallId === "string" ? event.toolCallId : null;
    if (!toolCallId) return;
    const block = this.toolBlocks.get(toolCallId);
    if (!block) return;
    const partial = isRecord(event.partialResult) ? event.partialResult : null;
    // partialResult is cumulative, so replacing the text is correct.
    block.resultEl.setText(extractText(partial?.content));
    this.autoScroll();
  }

  private onToolEnd(event: Record<string, unknown>): void {
    const toolCallId =
      typeof event.toolCallId === "string" ? event.toolCallId : null;
    if (!toolCallId) return;
    const toolName =
      typeof event.toolName === "string" ? event.toolName : "tool";
    const block = this.ensureToolBlock(toolCallId, toolName, event.args);
    const result = isRecord(event.result) ? event.result : null;
    const isError = event.isError === true;

    block.details.removeClass("is-running");
    block.details.toggleClass("is-error", isError);
    block.statusEl.setText(isError ? "error" : "done");
    const text = extractText(result?.content);
    block.resultEl.setText(text);
    if (isError) block.details.open = true;
    this.autoScroll();
  }

  private onBashUpdate(event: Record<string, unknown>): void {
    if (typeof event.delta !== "string") return;
    const id = typeof event.id === "string" ? event.id : "bash";
    const key = `bash:${id}`;
    const block = this.ensureToolBlock(key, "bash", undefined);
    block.resultEl.setText(block.resultEl.getText() + event.delta);
    this.autoScroll();
  }

  // -------------------------------------------------------------------------
  // Extension UI
  // -------------------------------------------------------------------------

  /**
   * Render inline cards for extension dialogs. These block the agent until
   * answered — most notably tool-approval prompts — so they must be visible.
   */
  private onExtensionUi(event: Record<string, unknown>): void {
    const method = typeof event.method === "string" ? event.method : "";
    const id = typeof event.id === "string" ? event.id : null;

    if (method === "notify" || method === "setStatus") {
      const message = typeof event.message === "string" ? event.message : "";
      if (message) this.system(message, "info");
      return;
    }
    if (!id) return;

    if (method === "select" || method === "confirm") {
      const title =
        typeof event.title === "string"
          ? event.title
          : typeof event.message === "string"
            ? event.message
            : "pi needs an answer";
      const options =
        method === "confirm"
          ? ["Yes", "No"]
          : Array.isArray(event.options)
            ? event.options.filter((o): o is string => typeof o === "string")
            : [];
      this.renderDialog(id, title, options, method === "confirm");
      return;
    }
    if (method === "input" || method === "editor") {
      const title =
        typeof event.title === "string" ? event.title : "pi needs input";
      this.renderInputDialog(
        id,
        title,
        typeof event.value === "string" ? event.value : "",
      );
    }
  }

  private renderDialog(
    id: string,
    title: string,
    options: string[],
    isConfirm: boolean,
  ): void {
    const card = this.container.createDiv({ cls: "oh-dialog" });
    card.createDiv({ cls: "oh-dialog__title", text: title });
    const row = card.createDiv({ cls: "oh-dialog__actions" });

    const answer = (payload: Record<string, unknown>): void => {
      this.options.onDialogResponse({
        type: "extension_ui_response",
        id,
        ...payload,
      });
      card.addClass("is-answered");
      row.empty();
      row.createSpan({
        cls: "oh-dialog__answered",
        text: describeAnswer(payload),
      });
    };

    for (const option of options.length > 0 ? options : ["OK"]) {
      const button = row.createEl("button", {
        cls: "oh-dialog__button",
        text: option,
      });
      button.addEventListener("click", () => {
        if (isConfirm) {
          answer({ value: option === "Yes" });
        } else {
          answer({ value: option });
        }
      });
    }

    const cancel = row.createEl("button", {
      cls: "oh-dialog__button mod-muted",
      text: "Cancel",
    });
    cancel.addEventListener("click", () => answer({ cancelled: true }));
    this.autoScroll();
  }

  private renderInputDialog(id: string, title: string, initial: string): void {
    const card = this.container.createDiv({ cls: "oh-dialog" });
    card.createDiv({ cls: "oh-dialog__title", text: title });
    const input = card.createEl("textarea", { cls: "oh-dialog__input" });
    input.value = initial;
    const row = card.createDiv({ cls: "oh-dialog__actions" });

    const answer = (payload: Record<string, unknown>): void => {
      this.options.onDialogResponse({
        type: "extension_ui_response",
        id,
        ...payload,
      });
      card.addClass("is-answered");
      input.disabled = true;
      row.empty();
      row.createSpan({
        cls: "oh-dialog__answered",
        text: describeAnswer(payload),
      });
    };

    const submit = row.createEl("button", {
      cls: "oh-dialog__button mod-cta",
      text: "Send",
    });
    submit.addEventListener("click", () => answer({ value: input.value }));
    const cancel = row.createEl("button", {
      cls: "oh-dialog__button mod-muted",
      text: "Cancel",
    });
    cancel.addEventListener("click", () => answer({ cancelled: true }));
    input.focus();
    this.autoScroll();
  }

  // -------------------------------------------------------------------------
  // Snapshot replay
  // -------------------------------------------------------------------------

  /** Rebuild a transcript from `get_messages` output after attach/reconnect. */
  renderSnapshot(messages: unknown[], pendingTools: unknown[]): void {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      switch (message.role) {
        case "user":
          this.renderUser(extractText(message.content));
          break;
        case "assistant":
          this.renderStaticAssistant(message);
          break;
        case "toolResult":
          this.renderStaticToolResult(message);
          break;
        case "bashExecution": {
          const command =
            typeof message.command === "string" ? message.command : "";
          const block = this.ensureToolBlock(`bash:${command}`, "bash", {
            command,
          });
          block.statusEl.setText(message.exitCode === 0 ? "done" : "error");
          block.resultEl.setText(
            typeof message.output === "string" ? message.output : "",
          );
          break;
        }
        default:
          break;
      }
    }

    for (const pending of pendingTools) {
      if (!isRecord(pending)) continue;
      const toolCallId =
        typeof pending.toolCallId === "string" ? pending.toolCallId : null;
      if (!toolCallId) continue;
      const toolName =
        typeof pending.toolName === "string" ? pending.toolName : "tool";
      const block = this.ensureToolBlock(toolCallId, toolName, pending.args);
      block.details.addClass("is-running");
      block.statusEl.setText("running");
    }

    this.current = null;
    this.scrollToBottom();
  }

  private renderStaticAssistant(message: Record<string, unknown>): void {
    const content = message.content;
    if (!Array.isArray(content)) return;
    const render = this.beginAssistant();

    let index = 0;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const stream = this.openBlock(render, index, "text");
        stream.bodyEl.removeClass("oh-stream");
        void MarkdownRenderer.render(
          this.options.app,
          block.text,
          stream.bodyEl,
          this.options.sourcePath,
          this.options.component,
        );
      } else if (block.type === "thinking" && this.options.showThinking) {
        const stream = this.openBlock(render, index, "thinking");
        stream.bodyEl.removeClass("oh-stream");
        stream.bodyEl.setText(
          typeof block.thinking === "string" ? block.thinking : "",
        );
      } else if (block.type === "toolCall") {
        const toolCallId =
          typeof block.id === "string" ? block.id : `call-${String(index)}`;
        const name = typeof block.name === "string" ? block.name : "tool";
        this.ensureToolBlock(toolCallId, name, block.arguments);
      }
      index += 1;
    }
    this.current = null;
  }

  private renderStaticToolResult(message: Record<string, unknown>): void {
    const toolCallId =
      typeof message.toolCallId === "string" ? message.toolCallId : null;
    if (!toolCallId) return;
    const toolName =
      typeof message.toolName === "string" ? message.toolName : "tool";
    const block = this.ensureToolBlock(toolCallId, toolName, undefined);
    const isError = message.isError === true;
    block.statusEl.setText(isError ? "error" : "done");
    block.details.toggleClass("is-error", isError);
    block.resultEl.setText(extractText(message.content));
  }

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  /** Follow new output only while the user is already parked at the bottom. */
  private autoScroll(): void {
    if (this.stickToBottom) this.scrollToBottom();
  }

  scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
    this.stickToBottom = true;
  }
}

function describeAnswer(payload: Record<string, unknown>): string {
  if (payload.cancelled === true) return "cancelled";
  const value = payload.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string")
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  return "answered";
}
