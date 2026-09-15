/**
 * Plugin entry point.
 *
 * Registers the harness view and the commands that place it, and owns settings.
 * Agent state deliberately lives in the bridge server, not here, so reloading
 * the plugin never loses a conversation.
 */
import path from "node:path";

import {
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";

import { collectNoteMetadata, formatNoteContext } from "./note-context.js";
import {
  DEFAULT_SETTINGS,
  HarnessSettingTab,
  type HarnessSettings,
  type PanelLocation,
} from "./settings.js";
import { HarnessView, VIEW_TYPE_HARNESS } from "./view.js";

/**
 * Wrap text in a code fence long enough to survive backticks inside it.
 *
 * A note selection frequently contains fenced code of its own, and a bare
 * three-backtick fence would terminate early and mangle the prompt.
 */
function fenceCode(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

export default class HarnessPlugin extends Plugin {
  /** Obsidian's Plugin base class declares `settings?: unknown`; narrow it here. */
  override settings: HarnessSettings = { ...DEFAULT_SETTINGS };

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_HARNESS, (leaf) => new HarnessView(leaf, this));

    this.addRibbonIcon("bot", "Open Pi Harness", () => {
      void this.openPanel();
    });

    this.addCommand({
      id: "open-panel",
      name: "Open harness",
      callback: () => {
        void this.openPanel();
      },
    });
    this.addCommand({
      id: "open-panel-right",
      name: "Open harness in right sidebar",
      callback: () => {
        void this.openPanel("right", { reuse: false });
      },
    });
    this.addCommand({
      id: "open-panel-left",
      name: "Open harness in left sidebar",
      callback: () => {
        void this.openPanel("left", { reuse: false });
      },
    });
    this.addCommand({
      id: "open-panel-tab",
      name: "Open harness in a new tab",
      callback: () => {
        void this.openPanel("tab", { reuse: false });
      },
    });
    this.addCommand({
      id: "focus-input",
      name: "Focus harness input",
      callback: () => {
        void this.focusPanel();
      },
    });
    this.addCommand({
      id: "reconnect",
      name: "Reconnect to bridge server",
      callback: () => this.reconnectAll(),
    });

    this.addCommand({
      id: "ask-about-note",
      name: "Ask pi about the active note",
      callback: () => {
        void this.askAboutActiveNote({ withSelection: false });
      },
    });
    this.addCommand({
      id: "ask-about-selection",
      name: "Ask pi about the selection",
      editorCallback: () => {
        void this.askAboutActiveNote({ withSelection: true });
      },
    });
    this.addCommand({
      id: "insert-last-response",
      name: "Insert pi's last response into the note",
      editorCallback: () => this.insertLastResponse(),
    });

    this.addSettingTab(new HarnessSettingTab(this.app, this));
  }

  // -------------------------------------------------------------------------
  // Vault integration
  // -------------------------------------------------------------------------

  /**
   * Prefill the composer with the active note as context.
   *
   * This is the whole point of embedding the agent in Obsidian: without it the
   * user types "this document" and pi has to hunt for the file (or stop and ask
   * which one), burning turns on something the panel already knows.
   */
  async askAboutActiveNote(options: { withSelection: boolean }): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Pi Harness: no active note.");
      return;
    }

    const selection = options.withSelection
      ? (this.targetEditor()?.getSelection() ?? "")
      : "";

    const lines: string[] = [];
    if (this.settings.includeNoteMetadata) {
      // Frontmatter, outline and backlinks cost a few tokens and save pi a read
      // (or, for backlinks, a vault-wide grep it would probably not attempt).
      lines.push(formatNoteContext(collectNoteMetadata(this.app, file)));
    } else {
      lines.push(
        `Context: the note \`${file.path}\`, relative to your working directory.`,
      );
    }
    if (selection.trim()) {
      lines.push("", "Selected text:", "", fenceCode(selection));
    }
    lines.push("", "");

    await this.openPanel();
    const view = this.firstPanel();
    if (!view) return;
    view.prefillComposer(lines.join("\n"));
  }

  /** Ask the bridge for pi's last reply and insert it at the cursor. */
  insertLastResponse(): void {
    const view = this.firstPanel();
    if (!view) {
      new Notice("Pi Harness: open the harness panel first.");
      return;
    }
    view.requestInsertLastResponse();
  }

  private firstPanel(): HarnessView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HARNESS)) {
      if (leaf.view instanceof HarnessView) return leaf.view;
    }
    return null;
  }

  // Note: deliberately no detachLeavesOfType() here. Obsidian's plugin
  // guidelines forbid it — it destroys the user's saved layout on every reload.

  // -------------------------------------------------------------------------
  // Panel placement
  // -------------------------------------------------------------------------

  async openPanel(
    location: PanelLocation = this.settings.defaultLocation,
    options: { reuse?: boolean } = {},
  ): Promise<void> {
    const reuse = options.reuse ?? true;
    const { workspace } = this.app;

    if (reuse) {
      const existing = workspace.getLeavesOfType(VIEW_TYPE_HARNESS).at(0);
      if (existing) {
        await workspace.revealLeaf(existing);
        this.focusLeaf(existing);
        return;
      }
    }

    const leaf = this.createLeaf(location);
    if (!leaf) {
      new Notice("Pi Harness: could not open a panel here.");
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_HARNESS, active: true });
    await workspace.revealLeaf(leaf);
    this.focusLeaf(leaf);
  }

  private createLeaf(location: PanelLocation): WorkspaceLeaf | null {
    const { workspace } = this.app;
    if (location === "tab") return workspace.getLeaf(true);
    if (location === "left") return workspace.getLeftLeaf(false);
    return workspace.getRightLeaf(false);
  }

  private focusLeaf(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (view instanceof HarnessView) view.focusInput();
  }

  private async focusPanel(): Promise<void> {
    await this.openPanel();
  }

  /** Re-resolve the endpoint and reconnect every open panel. */
  reconnectAll(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HARNESS);
    if (leaves.length === 0) {
      new Notice("Pi Harness: no panels are open.");
      return;
    }
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof HarnessView) view.reconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Paths and settings
  // -------------------------------------------------------------------------

  /**
   * Absolute path to this plugin's directory, needed to spawn the bundled
   * server.js. `manifest.dir` is vault-relative, so it must be joined with the
   * adapter's base path.
   */
  absolutePluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const dir = this.manifest.dir;
    if (!dir) return null;
    return path.join(adapter.getBasePath(), dir);
  }

  /**
   * The markdown editor to act on for insert operations.
   *
   * Not `getActiveViewOfType`: clicking a button inside the harness panel makes
   * the panel's leaf active, so the "active" markdown view is frequently null at
   * exactly the moment the user asks to insert. `getMostRecentLeaf` ignores
   * sidebars and returns the last real editor instead.
   */
  private targetEditor(): Editor | null {
    const recent = this.app.workspace.getMostRecentLeaf();
    if (recent?.view instanceof MarkdownView) return recent.view.editor;
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
  }

  /** Insert text at the cursor of the most recent markdown editor. */
  insertIntoActiveNote(text: string): void {
    if (!text.trim()) {
      new Notice("Pi Harness: nothing to insert yet.");
      return;
    }
    const editor = this.targetEditor();
    if (!editor) {
      new Notice("Pi Harness: open a note in edit mode to insert text.");
      return;
    }
    editor.replaceSelection(text.endsWith("\n") ? text : `${text}\n`);
    new Notice("Inserted into note.");
  }

  /** Source path used to resolve links in rendered markdown. */
  activeSourcePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  async loadSettings(): Promise<void> {
    const stored: unknown = await this.loadData();
    this.settings =
      typeof stored === "object" && stored !== null
        ? { ...DEFAULT_SETTINGS, ...(stored as Partial<HarnessSettings>) }
        : { ...DEFAULT_SETTINGS };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Push changes into panels that are already open. Without this, toggling a
    // display setting appears to do nothing until the panel is reopened.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HARNESS)) {
      const view = leaf.view;
      if (view instanceof HarnessView) view.applySettings();
    }
  }
}
