# Architecture

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

pi's RPC commands and events pass through the bridge verbatim. Bridge-specific messages are namespaced `bridge_*` so they can never collide with pi's vocabulary. See `shared/protocol.ts`.

## Why a server instead of a child process

The panel could spawn `pi --mode rpc` itself. A standalone server buys three things:

- **Survives plugin reloads.** Iterating on plugin code doesn't kill your agent session.
- **Shared sessions.** Several panels (sidebar + tab, or two windows) attach to the same agent and see the same stream; a message sent from one appears in all.
- **Thin bundle.** No node dependencies compiled into `main.js`.

The cost is a second process to supervise, which the plugin starts on demand.

## Session identity

A session is keyed by working directory, which defaults to the vault root. One agent per vault, shared by every panel, and reattached rather than respawned when a panel opens.

## Files

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

## Running the server manually

The plugin starts it on demand, but you can run it yourself:

```bash
npm run server
node server.js --port 8787 --pi /absolute/path/to/pi --idle-timeout 30
```

On start it writes `~/.obs-harness/server.json` (mode `0600`) holding the port and a per-start random token. The plugin reads that file, so no token is copied by hand. Disable **Auto-discover server** in settings to enter a port and token manually.

## Tests

```bash
npm test            # format checks + bridge vs. real pi; no LLM calls, no cost
npm run test:format # pure formatting helpers only
npm run test:live   # one real LLM turn; asserts the streaming event sequence
```

`npm test` covers the handshake file and its permissions, token rejection at upgrade, attach/snapshot, streamed `bash` output, LF-only framing (a U+2028 round trip), session sharing across two clients, event fan-out, the command allowlist (including that phantom commands stay out of it), reserved-id rejection, and handshake cleanup on `SIGTERM`.

`test/format.mjs` guards against re-introducing silent truncation of tool previews and dialog answers.
