/**
 * Note context: what the panel knows about the active note and pi does not.
 *
 * The point is to spend a few cheap tokens instead of an expensive tool call.
 * Two kinds of information justify inclusion:
 *
 *  - Invisible from inside the file. Backlinks answer "what references this?",
 *    which pi could otherwise only get by grepping the whole vault.
 *  - Expensive to obtain. Frontmatter and the heading outline let pi orient in a
 *    long note without reading it; a full read of one vault note measured 20k+
 *    characters.
 *
 * Everything is bounded and omitted when empty, so a sparse note produces a
 * couple of lines and a hub note cannot flood the composer.
 *
 * Obsidian imports here are type-only, so this module has no runtime dependency
 * on the host and its formatter can be unit-tested in plain node.
 */
import type { App, CachedMetadata, TFile } from "obsidian";

/** Plain snapshot of a note, decoupled from Obsidian's live caches. */
export interface NoteMetadata {
  path: string;
  createdMs: number | null;
  modifiedMs: number | null;
  sizeBytes: number | null;
  /** Parsed YAML properties, minus Obsidian's internal `position` key. */
  frontmatter: Record<string, unknown>;
  tags: string[];
  headings: { level: number; heading: string }[];
  /** Resolved outgoing link targets, most-linked first. */
  linksOut: string[];
  linksOutTotal: number;
  /** Wikilinks pointing at files that do not exist. */
  unresolvedOut: string[];
  unresolvedOutTotal: number;
  embeds: string[];
  embedsTotal: number;
  /** Notes linking to this one, most-linked first. */
  backlinks: string[];
  backlinksTotal: number;
}

export interface NoteContextLimits {
  frontmatterKeys: number;
  frontmatterValueChars: number;
  tags: number;
  headings: number;
  links: number;
  backlinks: number;
  embeds: number;
}

export const DEFAULT_LIMITS: NoteContextLimits = {
  frontmatterKeys: 20,
  frontmatterValueChars: 200,
  tags: 20,
  headings: 30,
  links: 20,
  backlinks: 20,
  embeds: 10,
};

// ---------------------------------------------------------------------------
// Collection (touches Obsidian)
// ---------------------------------------------------------------------------

/** Snapshot the active note's metadata from Obsidian's caches. */
export function collectNoteMetadata(app: App, file: TFile): NoteMetadata {
  const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);

  const outgoing = app.metadataCache.resolvedLinks[file.path] ?? {};
  const unresolved = app.metadataCache.unresolvedLinks[file.path] ?? {};

  return {
    path: file.path,
    createdMs: file.stat?.ctime ?? null,
    modifiedMs: file.stat?.mtime ?? null,
    sizeBytes: file.stat?.size ?? null,
    frontmatter: cleanFrontmatter(cache?.frontmatter),
    tags: collectTags(cache),
    headings: (cache?.headings ?? []).map((h) => ({
      level: h.level,
      heading: h.heading,
    })),
    linksOut: byCountDesc(outgoing),
    linksOutTotal: Object.keys(outgoing).length,
    unresolvedOut: byCountDesc(unresolved),
    unresolvedOutTotal: Object.keys(unresolved).length,
    embeds: dedupe((cache?.embeds ?? []).map((e) => e.link)),
    embedsTotal: dedupe((cache?.embeds ?? []).map((e) => e.link)).length,
    ...collectBacklinks(app, file.path),
  };
}

/**
 * Reverse-scan the resolved link map.
 *
 * `getBacklinksForFile` is not in the public API, so this walks the public
 * `resolvedLinks` record instead. It is an in-memory object, so a full pass is
 * cheap even for a large vault.
 */
function collectBacklinks(
  app: App,
  path: string,
): { backlinks: string[]; backlinksTotal: number } {
  const counted: Record<string, number> = {};
  for (const [source, targets] of Object.entries(
    app.metadataCache.resolvedLinks,
  )) {
    // A note linking to itself is noise, not a backlink.
    if (source === path) continue;
    const count = targets[path];
    if (typeof count === "number" && count > 0) counted[source] = count;
  }
  const backlinks = byCountDesc(counted);
  return { backlinks, backlinksTotal: backlinks.length };
}

/** Frontmatter minus Obsidian's injected `position` bookkeeping. */
function cleanFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!frontmatter) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "position") continue;
    out[key] = value;
  }
  return out;
}

/** Inline tags plus frontmatter tags, normalised to a single `#tag` form. */
function collectTags(cache: CachedMetadata | null): string[] {
  const tags: string[] = [];
  for (const entry of cache?.tags ?? []) {
    if (typeof entry.tag === "string") tags.push(normalizeTag(entry.tag));
  }
  const fromFrontmatter = cache?.frontmatter?.tags;
  if (typeof fromFrontmatter === "string") {
    for (const part of fromFrontmatter.split(/[,\s]+/)) {
      if (part) tags.push(normalizeTag(part));
    }
  } else if (Array.isArray(fromFrontmatter)) {
    for (const part of fromFrontmatter) {
      if (typeof part === "string" && part) tags.push(normalizeTag(part));
    }
  }
  return dedupe(tags);
}

function normalizeTag(tag: string): string {
  // Frontmatter tags arrive in several shapes. An inline YAML array can reach us
  // as the literal string "[context]", which previously became the nonsense tag
  // "#[context]"; strip YAML punctuation and drop anything left empty.
  const cleaned = tag
    .replace(/^#/, "")
    .replace(/[[\]"',]/g, "")
    .trim();
  return cleaned ? `#${cleaned}` : "";
}

function byCountDesc(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Render a compact, human-readable context block.
 *
 * Pure and total: any field may be missing, and an empty note yields just the
 * path line.
 */
export function formatNoteContext(
  meta: NoteMetadata,
  limits: NoteContextLimits = DEFAULT_LIMITS,
): string {
  const lines: string[] = [
    // The agent's cwd is the vault root, so this path is directly readable by
    // pi's own tools.
    `Context: the note \`${meta.path}\`, relative to your working directory.`,
  ];

  const stats = formatStats(meta);
  if (stats) lines.push(`- ${stats}`);

  const frontmatterLines = formatFrontmatter(meta.frontmatter, limits);
  if (frontmatterLines.length > 0) {
    lines.push("- Properties:");
    for (const entry of frontmatterLines) lines.push(`    ${entry}`);
  }

  if (meta.tags.length > 0) {
    lines.push(`- Tags: ${joinCapped(meta.tags, limits.tags)}`);
  }

  if (meta.headings.length > 0) {
    lines.push(`- Outline (${String(meta.headings.length)}):`);
    // Indent relative to the shallowest heading present, not to h1. Many notes
    // start at h2, which otherwise indents the entire outline for no reason.
    const minLevel = Math.min(...meta.headings.map((h) => h.level));
    for (const heading of meta.headings.slice(0, limits.headings)) {
      const indent = "  ".repeat(Math.max(0, heading.level - minLevel));
      lines.push(`    ${indent}${heading.heading}`);
    }
    if (meta.headings.length > limits.headings) {
      lines.push(
        `    … ${String(meta.headings.length - limits.headings)} more`,
      );
    }
  }

  if (meta.linksOutTotal > 0) {
    lines.push(
      `- Links to (${String(meta.linksOutTotal)}): ${joinCapped(meta.linksOut, limits.links)}`,
    );
  }
  if (meta.embedsTotal > 0) {
    lines.push(
      `- Embeds (${String(meta.embedsTotal)}): ${joinCapped(meta.embeds, limits.embeds)}`,
    );
  }
  if (meta.unresolvedOutTotal > 0) {
    lines.push(
      `- Broken links (${String(meta.unresolvedOutTotal)}): ${joinCapped(meta.unresolvedOut, limits.links)}`,
    );
  }
  if (meta.backlinksTotal > 0) {
    // Called out explicitly because it is the one fact pi cannot obtain by
    // reading the file.
    lines.push(
      `- Linked from (${String(meta.backlinksTotal)}): ${joinCapped(meta.backlinks, limits.backlinks)}`,
    );
  }

  return lines.join("\n");
}

function formatStats(meta: NoteMetadata): string {
  const parts: string[] = [];
  if (meta.modifiedMs) parts.push(`modified ${formatDate(meta.modifiedMs)}`);
  if (meta.createdMs) parts.push(`created ${formatDate(meta.createdMs)}`);
  if (meta.sizeBytes !== null) {
    parts.push(`${String(Math.max(1, Math.round(meta.sizeBytes / 1024)))} KB`);
  }
  return parts.join(" · ");
}

function formatDate(ms: number): string {
  // Local ISO date: precise enough for "is this stale?" without a clock time.
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(d.getFullYear())}-${month}-${day}`;
}

function formatFrontmatter(
  frontmatter: Record<string, unknown>,
  limits: NoteContextLimits,
): string[] {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return [];

  const lines: string[] = [];
  for (const [key, value] of entries.slice(0, limits.frontmatterKeys)) {
    lines.push(
      `${key}: ${stringifyValue(value, limits.frontmatterValueChars)}`,
    );
  }
  if (entries.length > limits.frontmatterKeys) {
    lines.push(`… ${String(entries.length - limits.frontmatterKeys)} more`);
  }
  return lines;
}

function stringifyValue(value: unknown, maxChars: number): string {
  let text: string;
  if (value === null || value === undefined) {
    text = "";
  } else if (Array.isArray(value)) {
    text = value.map((v) => stringifyScalar(v)).join(", ");
  } else if (typeof value === "object") {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "[unserializable]";
    }
  } else {
    text = stringifyScalar(value);
  }
  // Collapse newlines: a multi-line YAML value must not break the block's
  // one-property-per-line shape.
  text = text.replace(/\s*\n\s*/g, " ");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function joinCapped(values: string[], limit: number): string {
  if (values.length <= limit) return values.join(", ");
  const shown = values.slice(0, limit).join(", ");
  return `${shown}, … ${String(values.length - limit)} more`;
}
