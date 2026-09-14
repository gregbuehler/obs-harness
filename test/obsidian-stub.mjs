/**
 * Minimal stand-in for the `obsidian` module so pure helpers in src/ can be
 * unit-tested in plain node. Only the runtime values transcript.ts imports need
 * to exist; nothing here is exercised by the assertions.
 */
export const MarkdownRenderer = {
 render: async () => undefined,
};

export function setIcon() {
 /* no-op outside Obsidian */
}
