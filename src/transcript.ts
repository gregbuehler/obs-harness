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
  /**
   * Note path used to resolve relative links and wikilinks in rendered
   * markdown. A function, not a string: the active note changes while a panel
   * stays open, and a value captured at construction silently resolves every
   * later link against a stale note.
   */
  sourcePath: () => string;
  /** Live display settings, re-read per render so toggles take effect at once. */
  display: () => TranscriptDisplayOptions;
  /** Send an extension_ui_response back through the bridge. */
  onDialogResponse: (response: Record<string, unknown>) => void;
  /** Copy text to the clipboard (host-provided so this stays DOM-only). */
  onCopy: (text: string) => void;
  /** Insert text into the active note. */
  onInsertIntoNote: (text: string) => void;
}

export interface TranscriptDisplayOptions {
  showThinking: boolean;
  expandTools: boolean;
  showTimestamps: boolean;
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

/** A rendered blocking dialog, retained so it can be retired remotely. */
interface DialogCard {
  card: HTMLElement;
  actionsEl: HTMLElement;
  inputEl: HTMLTextAreaElement | null;
  answered: boolean;
}

/**
 * One assistant turn: the several assistant messages pi emits for a single
 * response, sharing one header and one body container.
 */
interface AssistantGroup {
  wrapper: HTMLElement;
  contentEl: HTMLElement;
  renders: AssistantRender[];
}

/** Flatten pi's content-block arrays into display text. */
export function extractText(content: unknown): string {
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

/**
 * Argument preview for a tool row. Intentionally not truncated: CSS clamps the
 * collapsed row to two lines and reveals the rest when expanded, so clipping
 * here would destroy information the user could otherwise read.
 */
export function summarizeArgs(args: unknown): string {
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
      // Collapse newlines so a heredoc does not blow the row open.
      return value.replace(/\s*\n\s*/g, " ⏎ ");
    }
  }
  const keys = Object.keys(args);
  return keys.length > 0 ? keys.join(", ") : "";
}

/**
 * Body text for a tool's argument block. A lone dominant string argument (a
 * shell command, a file path) reads far better raw than wrapped in JSON.
 */
export function formatArgsBody(args: unknown): string {
  if (typeof args === "string") return args;
  if (!isRecord(args)) return prettyJson(args);
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const value = only === undefined ? undefined : args[only];
    if (typeof value === "string") return value;
  }
  return prettyJson(args);
}

export class Transcript {
  private readonly options: TranscriptOptions;
  private readonly container: HTMLElement;
  private readonly toolBlocks = new Map<string, ToolBlock>();
  private readonly dialogCards = new Map<string, DialogCard>();
  private current: AssistantRender | null = null;
  /** Open assistant turn, so successive messages share one header. */
  private currentGroup: AssistantGroup | null = null;
  private stickToBottom = true;
  /** Optimistic user echoes awaiting confirmation from pi's own event. */
  private unconfirmedUserEchoes: string[] = [];
  /**
   * Monotonic counter for tool rows that have no toolCallId (direct RPC bash,
   * replayed bashExecution messages). Keying those on the command text merged
   * two runs of the same command into one row.
   */
  private syntheticKeys = 0;
  private emptyStateEl: HTMLElement | null = null;

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

    this.renderEmptyState();
  }

  clear(): void {
    this.container.empty();
    this.toolBlocks.clear();
    this.dialogCards.clear();
    this.current = null;
    this.currentGroup = null;
    this.unconfirmedUserEchoes = [];
    this.syntheticKeys = 0;
    this.emptyStateEl = null;
    this.stickToBottom = true;
    this.renderEmptyState();
  }

  /** True once anything other than the placeholder has been rendered. */
  private renderEmptyState(): void {
    if (this.container.childElementCount > 0) return;
    const empty = this.container.createDiv({ cls: "oh-empty" });
    empty.createDiv({ cls: "oh-empty__title", text: "No messages yet" });
    empty.createDiv({
      cls: "oh-empty__hint",
      text: "Ask a question below, or run \u201cAsk pi about the active note\u201d from the command palette.",
    });
    this.emptyStateEl = empty;
  }

  /** Remove the placeholder the first time real content arrives. */
  private clearEmptyState(): void {
    if (!this.emptyStateEl) return;
    this.emptyStateEl.remove();
    this.emptyStateEl = null;
  }

  /**
   * Apply changed display settings to content already on screen. New rows read
   * the live getter, but existing ones need explicit updating or a toggle looks
   * like it did nothing.
   */
  applyDisplayOptions(): void {
    const display = this.options.display();
    this.container.toggleClass("is-hiding-thinking", !display.showThinking);
    this.container.toggleClass("is-hiding-timestamps", !display.showTimestamps);
    for (const [, block] of this.toolBlocks) {
      block.details.open = display.expandTools;
    }
  }

  // -------------------------------------------------------------------------
  // Simple rows
  // -------------------------------------------------------------------------

  system(text: string, kind: "info" | "warn" | "error" = "info"): void {
    this.clearEmptyState();
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

  /**
   * Populate a message header: role, timestamp, and hover actions.
   *
   * Takes the header element rather than creating it, so a caller can put the
   * header in the DOM first and still pass a `getText` closure over state that
   * only exists afterwards.
   */
  private buildHeader(
    header: HTMLElement,
    role: string,
    getText: () => string,
  ): void {
    header.createSpan({ cls: "oh-msg__role", text: role });
    header.createSpan({
      cls: "oh-msg__time",
      text: new Date().toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
    header.createDiv({ cls: "oh-msg__spacer" });

    const actions = header.createDiv({ cls: "oh-msg__actions" });
    const action = (icon: string, tooltip: string, run: () => void): void => {
      const button = actions.createEl("button", {
        cls: "oh-msg__action",
        attr: { "aria-label": tooltip, title: tooltip },
      });
      setIcon(button, icon);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        run();
      });
    };

    action("copy", "Copy message", () => this.options.onCopy(getText()));
    action("between-horizontal-start", "Insert into active note", () => {
      this.options.onInsertIntoNote(getText());
    });
  }

  private renderUser(text: string): void {
    this.clearEmptyState();
    // A user message ends the assistant turn.
    this.currentGroup = null;
    const wrapper = this.container.createDiv({ cls: "oh-msg oh-msg--user" });
    const header = wrapper.createDiv({ cls: "oh-msg__header" });
    this.buildHeader(header, "you", () => text);
    const body = wrapper.createDiv({ cls: "oh-msg__body" });
    void MarkdownRenderer.render(
      this.options.app,
      text,
      body,
      this.options.sourcePath(),
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

  /**
   * Start (or extend) an assistant turn.
   *
   * pi emits a separate message per thinking block, so a single logical turn
   * arrives as several assistant messages. They are grouped under one header
   * instead of one header each: that removes the repeated "PI" labels, and it
   * keeps copy/insert acting on the whole turn's prose, which usually lives in
   * the last message of the run rather than the first.
   */
  private beginAssistant(): AssistantRender {
    this.clearEmptyState();

    const group = this.currentGroup;
    if (group) {
      const render: AssistantRender = {
        wrapper: group.wrapper,
        contentEl: group.contentEl,
        blocks: new Map(),
      };
      group.renders.push(render);
      this.current = render;
      this.autoScroll();
      return render;
    }

    const wrapper = this.container.createDiv({
      cls: "oh-msg oh-msg--assistant",
    });
    // Header goes into the DOM first for ordering, but is populated after the
    // group exists so its actions can read the turn's text.
    const header = wrapper.createDiv({ cls: "oh-msg__header" });
    const contentEl = wrapper.createDiv({ cls: "oh-msg__body" });
    const render: AssistantRender = { wrapper, contentEl, blocks: new Map() };
    const newGroup = { wrapper, contentEl, renders: [render] };
    this.currentGroup = newGroup;
    // Copy/insert act on visible prose only: thinking and tool JSON are noise
    // in a note.
    this.buildHeader(header, "pi", () => this.groupProse(newGroup));
    this.current = render;
    this.autoScroll();
    return render;
  }

  /** Concatenated prose of every message in an assistant turn. */
  private groupProse(group: AssistantGroup): string {
    const parts: string[] = [];
    for (const render of group.renders) {
      for (const block of render.blocks.values()) {
        if (block.kind === "text" && block.buffer.trim()) {
          parts.push(block.buffer);
        }
      }
    }
    return parts.join("\n\n").trim();
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
          this.options.sourcePath(),
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
        if (this.options.display().showThinking)
          this.openBlock(render, contentIndex, "thinking");
        return;
      case "thinking_delta":
        if (this.options.display().showThinking) {
          this.appendDelta(render, contentIndex, "thinking", delta.delta);
        }
        return;
      case "thinking_end":
        if (this.options.display().showThinking) {
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
      details.open = this.options.display().expandTools;
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
      this.options.sourcePath(),
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
    block.bodyEl.setText(
      args === undefined ? block.buffer : formatArgsBody(args),
    );
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
    details.open = this.options.display().expandTools;
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
      text: formatArgsBody(args),
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
    // Keyed on the originating command id, which must stay stable so successive
    // deltas accumulate into one row. Only the id-less fallback is shared.
    const id = typeof event.id === "string" ? event.id : "unkeyed";
    const key = `bash:rpc:${id}`;
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

  /** Retire a dialog card after this panel answered it. */
  private markDialogAnswered(id: string, answer: string): void {
    const entry = this.dialogCards.get(id);
    if (!entry || entry.answered) return;
    entry.answered = true;
    entry.card.addClass("is-answered");
    if (entry.inputEl) entry.inputEl.disabled = true;
    entry.actionsEl.empty();
    entry.actionsEl.createSpan({ cls: "oh-dialog__answered", text: answer });
    this.autoScroll();
  }

  /**
   * Retire a dialog resolved somewhere else: another panel answered it, or the
   * server auto-cancelled it because nothing was attached. Without this a
   * second panel keeps offering live buttons for a decision pi has already
   * moved past, and clicking them does nothing.
   */
  resolveDialogRemotely(id: string, reason: string, answer?: string): void {
    const entry = this.dialogCards.get(id);
    if (!entry || entry.answered) return;
    let label: string;
    if (reason === "no-clients") {
      label = "cancelled \u2014 no panel was attached";
    } else if (answer) {
      label = `${answer} \u2014 answered in another panel`;
    } else {
      label = "resolved in another panel";
    }
    this.markDialogAnswered(id, label);
    entry.card.addClass("is-remote");
  }

  private renderDialog(
    id: string,
    title: string,
    options: string[],
    isConfirm: boolean,
  ): void {
    this.clearEmptyState();
    const card = this.container.createDiv({ cls: "oh-dialog" });
    card.createDiv({ cls: "oh-dialog__title", text: title });
    const row = card.createDiv({ cls: "oh-dialog__actions" });
    this.dialogCards.set(id, {
      card,
      actionsEl: row,
      inputEl: null,
      answered: false,
    });

    const answer = (payload: Record<string, unknown>): void => {
      this.options.onDialogResponse({
        type: "extension_ui_response",
        id,
        ...payload,
      });
      this.markDialogAnswered(id, describeAnswer(payload));
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
    this.clearEmptyState();
    const card = this.container.createDiv({ cls: "oh-dialog" });
    card.createDiv({ cls: "oh-dialog__title", text: title });
    const input = card.createEl("textarea", { cls: "oh-dialog__input" });
    input.value = initial;
    const row = card.createDiv({ cls: "oh-dialog__actions" });
    this.dialogCards.set(id, {
      card,
      actionsEl: row,
      inputEl: input,
      answered: false,
    });

    const answer = (payload: Record<string, unknown>): void => {
      this.options.onDialogResponse({
        type: "extension_ui_response",
        id,
        ...payload,
      });
      this.markDialogAnswered(id, describeAnswer(payload));
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
          // Unique per replayed message: keying on the command text merged two
          // runs of the same command into a single row, losing the first's
          // output.
          const block = this.ensureToolBlock(
            `bash:replay:${String(this.syntheticKeys++)}`,
            "bash",
            { command },
          );
          block.statusEl.setText(message.exitCode === 0 ? "done" : "error");
          block.resultEl.setText(
            typeof message.output === "string" ? message.output : "",
          );
          break;
        }
        default: {
          // Extensions can persist `custom` (and future) roles. Dropping them
          // silently makes a reattached transcript disagree with the live one,
          // so surface them as a labelled row rather than nothing.
          const role =
            typeof message.role === "string" ? message.role : "unknown";
          const text = extractText(message.content);
          this.system(text ? `[${role}] ${text}` : `[${role}] message`, "info");
          break;
        }
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
          this.options.sourcePath(),
          this.options.component,
        );
      } else if (
        block.type === "thinking" &&
        this.options.display().showThinking
      ) {
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

/**
 * Label for an answered dialog card. Not truncated — the whole point of the
 * card is to record what was chosen, and the CSS lets it wrap.
 */
export function describeAnswer(payload: Record<string, unknown>): string {
  if (payload.cancelled === true) return "cancelled";
  const value = payload.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  return "answered";
}
