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
  Notice,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian";

import {
  DEFAULT_SETTINGS,
  HarnessSettingTab,
  type HarnessSettings,
  type PanelLocation,
} from "./settings.js";
import { HarnessView, VIEW_TYPE_HARNESS } from "./view.js";

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

    this.addSettingTab(new HarnessSettingTab(this.app, this));
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
  }
}
