# Notes

## Security posture

- The server binds `127.0.0.1` only and requires a token, compared in constant time.
- The token travels as a WebSocket query parameter because the browser `WebSocket` API cannot set headers. Plain `ws://` over loopback is deliberate: TLS to localhost would add a certificate to manage without changing the threat model.
- Clients cannot send arbitrary commands. Only an explicit allowlist is forwarded (`shared/protocol.ts`), and ids using the bridge's internal prefix are rejected so a client cannot hijack a server-issued request.
- **The agent has whatever filesystem and shell access pi normally has.** This panel is not a sandbox, and it runs in your vault.

## pi RPC gotchas

Both found by reading the installed build rather than the docs, and both easy to reintroduce:

- **`list_sessions` and `load_session` do not exist.** There is no RPC way to enumerate sessions at all; switching is `switch_session` with an explicit path. A session picker would have to scan pi's session directory itself. An earlier version of the allowlist contained both phantom commands; `npm test` now asserts they stay out.
- **`get_last_assistant_text` omits its key when empty.** It is typed `data: { text: string | null }`, but with no assistant message the response is `data: {}`. Treat absent and null alike.

## Framing

pi's RPC uses LF as the only record delimiter. Node's `readline` also splits on U+2028/U+2029, which are legal inside JSON strings, so it will silently corrupt records. `server/src/jsonl.ts` works on raw bytes and only breaks on `0x0A`; there is a round-trip test for exactly this.

## Obsidian specifics

- No `detachLeavesOfType` on unload — Obsidian's plugin guidelines forbid it, since it destroys the user's saved layout on every reload.
- `onOpen` can run again on layout restore, so it must be idempotent.
- Insertion targets the *most recently focused* editor, not the active view: clicking a button inside the panel makes the panel active, so `getActiveViewOfType(MarkdownView)` returns null at exactly the moment the user asks to insert.
- Assistant messages are grouped per turn. pi emits a separate message per thinking block, so one logical reply arrives as several assistant messages; grouping them keeps copy/insert acting on the whole turn's prose instead of one fragment.

## Known gaps

- **No diff view for `write`/`edit`.** pi rewriting a note shows args and a result, but not what changed. Highest-value remaining item.
- No context-window or cost meter, though `get_session_stats` is allowlisted and returns both.
- No image or attachment support in the composer (`prompt` accepts them over RPC).
- No session picker — see the RPC gotcha above.
- Transcript is not virtualized, so very long sessions get heavy.
- Desktop only: discovery and autostart use node APIs.
