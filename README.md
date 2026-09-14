# obs-harness

Run a [pi](https://github.com/earendil-works/pi) coding agent in an Obsidian side panel, with access to your vault.

A small local server owns the agent; the panel is just a client. So closing the panel — or reloading the plugin — reattaches to the running conversation instead of starting over, and every open panel shares one agent.

Desktop only.

## Quick start

Requires node 20+ and `pi` on your `PATH`.

```bash
npm install
npm run build
npm run install-plugin -- /path/to/vault   # symlinks the repo into the vault
```

Then in Obsidian: **Settings → Community plugins → enable "Pi Harness"**, and click the **`bot`** ribbon icon.

That's it — the plugin starts the bridge server itself on first use. If `PATH` doesn't include `pi` (Obsidian's `PATH` usually isn't your shell's), set an absolute path under **Settings → Pi Harness → pi executable**.

## Using it

**Enter** sends, **Shift+Enter** newlines, **Esc** stops. Typing while the agent is running steers it rather than being rejected.

The agent runs in your vault root, so it can read and write your notes. Three commands make that useful:

| Command palette | Effect |
| --- | --- |
| Ask pi about the active note | Prefills the composer with the current note's path |
| Ask pi about the selection | Same, plus the selected text |
| Insert pi's last response into the note | Inserts pi's reply at your cursor |

Hover any message for copy / insert-into-note. Click the model name to switch models.

## Development

```bash
npm run dev     # watch both bundles
npm test        # bridge vs. real pi; no LLM calls, no cost
```

Pair `npm run dev` with the [Hot Reload](https://github.com/pjeby/hot-reload) plugin; `install-plugin` drops the `.hotreload` marker it looks for.

## More

- [docs/architecture.md](docs/architecture.md) — how the pieces fit, and why there's a server
- [docs/notes.md](docs/notes.md) — security posture, pi RPC gotchas, known gaps
