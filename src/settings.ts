import { PluginSettingTab, Setting, type App } from "obsidian";

import { DEFAULT_PORT } from "../shared/protocol.js";
import type HarnessPlugin from "./main.js";

/** Where the ribbon icon and default command drop the panel. */
export type PanelLocation = "right" | "left" | "tab";

export interface HarnessSettings {
  /** Bridge host. Loopback only unless you really know why. */
  host: string;
  port: number;
  /** Blank means "read it from the handshake file". */
  token: string;
  /** Prefer the handshake file over the port/token entered here. */
  useHandshakeFile: boolean;
  /** Directory holding server.json (blank = ~/.obs-harness). */
  stateDir: string;
  /** Launch the bundled server automatically when nothing is listening. */
  autoStartServer: boolean;
  /** pi executable used by an auto-started server. */
  piPath: string;
  /** Default placement for the ribbon icon and "open panel" command. */
  defaultLocation: PanelLocation;
  /** Optional `provider/id` model override applied when a session spawns. */
  model: string;
  /** Render assistant thinking blocks. */
  showThinking: boolean;
  /** Expand tool call details by default instead of collapsing them. */
  expandTools: boolean;
  /** Agent working directory: the vault root, or a fixed path. */
  cwdMode: "vault" | "custom";
  customCwd: string;
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  token: "",
  useHandshakeFile: true,
  stateDir: "",
  autoStartServer: true,
  piPath: "pi",
  defaultLocation: "right",
  model: "",
  showThinking: true,
  expandTools: false,
  cwdMode: "vault",
  customCwd: "",
};

export class HarnessSettingTab extends PluginSettingTab {
  private readonly plugin: HarnessPlugin;

  constructor(app: App, plugin: HarnessPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Auto-discover server")
      .setDesc(
        "Read the port and token from the bridge's handshake file (server.json).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useHandshakeFile)
          .onChange(async (value) => {
            this.plugin.settings.useHandshakeFile = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Handshake directory")
      .setDesc("Where server.json lives. Blank uses ~/.obs-harness.")
      .addText((text) =>
        text
          .setPlaceholder("~/.obs-harness")
          .setValue(this.plugin.settings.stateDir)
          .onChange(async (value) => {
            this.plugin.settings.stateDir = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .setDisabled(!this.plugin.settings.useHandshakeFile);

    new Setting(containerEl).setName("Host").addText((text) =>
      text.setValue(this.plugin.settings.host).onChange(async (value) => {
        this.plugin.settings.host = value.trim() || "127.0.0.1";
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Port")
      .setDesc(
        "Used when auto-discovery is off or the handshake file is missing.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port > 0 && port < 65536) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Token")
      .setDesc("Shared secret. Leave blank to use the handshake file.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("from handshake file")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Start server automatically")
      .setDesc("Spawn the bundled bridge server when no server is reachable.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoStartServer)
          .onChange(async (value) => {
            this.plugin.settings.autoStartServer = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("pi executable")
      .setDesc(
        "Absolute path is safest — Obsidian's PATH is often not your shell's.",
      )
      .addText((text) =>
        text
          .setPlaceholder("pi")
          .setValue(this.plugin.settings.piPath)
          .onChange(async (value) => {
            this.plugin.settings.piPath = value.trim() || "pi";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reconnect now")
      .setDesc("Re-read the handshake file and reconnect every open panel.")
      .addButton((button) =>
        button
          .setButtonText("Reconnect")
          .setCta()
          .onClick(() => this.plugin.reconnectAll()),
      );

    new Setting(containerEl).setName("Agent").setHeading();

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("The agent's cwd, which is also the session key.")
      .addDropdown((drop) =>
        drop
          .addOption("vault", "Vault root")
          .addOption("custom", "Custom path")
          .setValue(this.plugin.settings.cwdMode)
          .onChange(async (value) => {
            this.plugin.settings.cwdMode =
              value === "custom" ? "custom" : "vault";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.cwdMode === "custom") {
      new Setting(containerEl)
        .setName("Custom working directory")
        .setDesc("Absolute path the agent should run in.")
        .addText((text) =>
          text
            .setPlaceholder("/Users/you/src/project")
            .setValue(this.plugin.settings.customCwd)
            .onChange(async (value) => {
              this.plugin.settings.customCwd = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Optional provider/id override, applied only when a session starts.",
      )
      .addText((text) =>
        text
          .setPlaceholder("anthropic/claude-sonnet-4-20250514")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Panel").setHeading();

    new Setting(containerEl)
      .setName("Default location")
      .setDesc("Where the ribbon icon opens the harness.")
      .addDropdown((drop) =>
        drop
          .addOption("right", "Right sidebar")
          .addOption("left", "Left sidebar")
          .addOption("tab", "Main area tab")
          .setValue(this.plugin.settings.defaultLocation)
          .onChange(async (value) => {
            this.plugin.settings.defaultLocation = value as PanelLocation;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Show thinking").addToggle((toggle) =>
      toggle
        .setValue(this.plugin.settings.showThinking)
        .onChange(async (value) => {
          this.plugin.settings.showThinking = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("Expand tool calls").addToggle((toggle) =>
      toggle
        .setValue(this.plugin.settings.expandTools)
        .onChange(async (value) => {
          this.plugin.settings.expandTools = value;
          await this.plugin.saveSettings();
        }),
    );
  }
}
