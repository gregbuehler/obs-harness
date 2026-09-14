# obs-harness

A [pi](https://github.com/earendil-works/pi) coding-agent harness exposed as an Obsidian panel, backed by a local bridge server.

The panel is a thin WebSocket client. All agent state lives in a separate long-lived server process, so closing the panel — or reloading the plugin — reattaches to the running conversation instead of starting over.

## Why a server instead of a child process

The panel could spawn `pi --mode rpc` itself, but a standalone server buys three things:

- **Survives plugin reloads.** Iterating on plugin code doesn't kill your agent session.
- **Shared sessions.** Several panels (sidebar + tab, or two windows) attach to the same agent and see the same stream; a message sent from one appears in all.
- **Thin bundle.** No node dependencies compiled into `main.js`.

The cost is a second process to supervise. The plugin can start it for you (`Start server automatically`).

## Architecture

```text
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Obsidian (Electron renderer) │        │ bridge server (node)         │
│                              │        │                              │
│  HarnessView (ItemView)      │  ws    │  HarnessServer               │
│    ├── BridgeClient  ────────┼───────►│    ├── auth (loopback+token) │
│    └── Transcript            │  JSON  │    ├── session registry      │
│         renders pi events    │◄───────┤    │     keyed by cwd        │
└──────────────────────────────┘        │    └── PiSession  ──────────┐│
                                        └──────────────────────────────┘│
                                                                        │ JSONL
                                                                 ┌──────▼──────┐
                                                                 │ pi --mode rpc│
                                                                 └─────────────┘
```

pi's RPC commands and events pass through the bridge verbatim; bridge-specific messages are namespaced `bridge_*` so they can never collide with pi's vocabulary. See `shared/protocol.ts`.

| File | Role |
| --- | --- |
| `src/main.ts` | Plugin entry: `registerView`, commands, ribbon, settings |
| `src/view.ts` | The panel itself (`ItemView`) — toolbar, transcript, composer |
| `src/transcript.ts` | Renders pi's event stream into DOM |
| `src/client.ts` | WebSocket client with backoff reconnect and re-attach |
| `src/discovery.ts` | Handshake-file discovery + server autostart |
| `src/settings.ts` | Settings model and settings tab |
| `server/src/server.ts` | WS auth, session registry, fan-out, dialog routing |
| `server/src/pi-session.ts` | One `pi --mode rpc` child process |
| `server/src/jsonl.ts` | Strict LF-only JSONL framing |
| `shared/protocol.ts` | Wire protocol shared by both bundles |

## Install

```bash
npm install
npm run build                       # emits main.js + server.js
npm run install-plugin              # symlinks into $LORE_VAULT
npm run install-plugin -- /path/to/vault
```

Then enable **Pi Harness** under Settings → Community plugins.

For development, `npm run dev` watches both bundles. Pair it with the [Hot Reload](https://github.com/pjeby/hot-reload) plugin — `install-plugin` drops the `.hotreload` marker it looks for.

## Running the server

The plugin starts it on demand by default. To run it yourself:

```bash
npm run server
node server.js --port 8787 --pi /absolute/path/to/pi --idle-timeout 30
```

On start it writes `~/.obs-harness/server.json` (mode `0600`) containing the port and a per-start random token. The plugin reads that file, so there is nothing to copy by hand. Disable **Auto-discover server** to enter a port and token manually instead.

Note that Obsidian's `PATH` is usually not your shell's — set an absolute **pi executable** path in settings if autostart can't find `pi`.

## Using the panel

- Ribbon icon (`bot`) opens the harness in the configured default location.
- Commands: open in right sidebar / left sidebar / new tab, focus input, reconnect.
- **Enter** sends, **Shift+Enter** inserts a newline.
- Sending while the agent is running becomes a **steer** — pi delivers it at the next safe point rather than rejecting it.
- **Esc** in the input, or the **Stop** button, aborts the current run.
- Tool calls render as collapsible rows with streamed output; errors auto-expand. Collapsed rows clamp to two lines and reveal the full label when expanded.
- Click the model name in the composer to switch models.
- Hover a message for **copy** and **insert into note** actions.
- Extension dialogs (including tool-approval prompts) render as inline cards. This matters: those dialogs *block the agent*. With no panel attached the server auto-cancels them so pi can never hang invisibly, and a dialog answered in one panel is retired in all the others.

Working directory defaults to the vault root and doubles as the session key — one agent per vault, shared by every panel.

### Vault integration

These are the reason to embed the agent rather than use a terminal:

| Command | Effect |
| --- | --- |
| Ask pi about the active note | Prefills the composer with the note's vault-relative path, which is directly readable by pi since the vault root is its working directory. |
| Ask pi about the selection | Same, plus the selected text in a fence sized to survive backticks inside it. |
| Insert pi's last response into the note | Fetches the reply via `get_last_assistant_text` and inserts at the cursor. |

Without the first two, asking about "this document" makes pi hunt the filesystem or stop to ask which file you meant — a round trip the panel can eliminate, since it already knows.

Insertion targets the most recently focused editor rather than the "active" one, because clicking inside the panel makes the panel itself active.

## Tests

```bash
npm test            # format checks + bridge vs. real pi; no LLM calls, no cost
npm run test:format # pure formatting helpers only
npm run test:live   # one real LLM turn; asserts the streaming event sequence
```

`npm test` covers the handshake file and its permissions, token rejection at upgrade, attach/snapshot, streamed `bash` output, LF-only framing (a U+2028 round trip), session sharing across two clients, event fan-out, the command allowlist (including that phantom commands stay out of it), reserved-id rejection, and handshake cleanup on `SIGTERM`. `test/format.mjs` guards against re-introducing silent truncation.

## Notes on pi's RPC surface

Two things worth knowing, both found by checking the installed build rather than the docs:

- `list_sessions` and `load_session` do not exist. There is no RPC way to enumerate sessions; switching is `switch_session` with an explicit path. A session picker would have to scan pi's session directory itself.
- `get_last_assistant_text` is typed as `data: { text: string | null }`, but when no assistant message exists the key is **omitted** (`data: {}`). Treat absent and null alike.

## Security notes

- The server binds `127.0.0.1` only and requires a token, compared in constant time.
- The token is transmitted as a WebSocket query parameter because the browser `WebSocket` API cannot set headers. Plain `ws://` over loopback is intentional — TLS to localhost would add a certificate to manage without a meaningful threat-model gain.
- Clients cannot send arbitrary commands: only an explicit allowlist is forwarded (`shared/protocol.ts`), and ids using the bridge's internal prefix are rejected so a client cannot hijack a server-issued request.
- The agent still has whatever filesystem and shell access pi normally has. This panel is not a sandbox.

## Known gaps

- No image or attachment support in the composer yet (`prompt` accepts them over RPC).
- No session picker: pi's RPC cannot list sessions (see above).
- No diff view for `write`/`edit` tool calls, so pi rewriting a note shows args and a result but not what changed. Highest-value remaining item.
- No context-window or cost meter, though `get_session_stats` is allowlisted and returns both.
- Session history isn't virtualized, so extremely long transcripts will get heavy.
- Desktop only, by necessity: discovery and autostart use node APIs.
