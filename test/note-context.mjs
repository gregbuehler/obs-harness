#!/usr/bin/env node
/*
 * Tests for the active-note context block.
 *
 * src/note-context.ts imports Obsidian types only, so it bundles and runs in
 * plain node with no host stub. The collector needs just three fields of `App`,
 * which a literal supplies.
 *
 *   node test/note-context.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "obs-harness-nc-")),
  "t.mjs",
);

execFileSync(
  "npx",
  [
    "esbuild",
    path.join(repoRoot, "src/note-context.ts"),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

const { collectNoteMetadata, formatNoteContext, DEFAULT_LIMITS } = await import(
  outFile
);

let failures = 0;
const it = (label, fn) => {
  try {
    fn();
    console.log(`  \u2713 ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  \u2717 ${label}\n      ${err.message.split("\n")[0]}`);
  }
};

/** Minimal App/TFile doubles: only the fields the collector reads. */
const makeApp = ({
  cache = null,
  resolvedLinks = {},
  unresolvedLinks = {},
}) => ({
  metadataCache: { getFileCache: () => cache, resolvedLinks, unresolvedLinks },
});
const makeFile = (p, stat = { ctime: 0, mtime: 0, size: 0 }) => ({
  path: p,
  stat,
});

console.log("\ncollectNoteMetadata: backlinks");
it("derives backlinks by reverse-scanning resolvedLinks", () => {
  const app = makeApp({
    resolvedLinks: {
      "a.md": { "target.md": 1 },
      "b.md": { "target.md": 3 },
      "c.md": { "other.md": 9 },
    },
  });
  const meta = collectNoteMetadata(app, makeFile("target.md"));
  assert.equal(meta.backlinksTotal, 2);
  // Most-linked first, so a cap keeps the strongest references.
  assert.deepEqual(meta.backlinks, ["b.md", "a.md"]);
});
it("excludes self-links", () => {
  const app = makeApp({
    resolvedLinks: {
      "target.md": { "target.md": 2 },
      "a.md": { "target.md": 1 },
    },
  });
  const meta = collectNoteMetadata(app, makeFile("target.md"));
  assert.deepEqual(meta.backlinks, ["a.md"]);
});
it("ignores zero counts and unrelated targets", () => {
  const app = makeApp({
    resolvedLinks: { "a.md": { "target.md": 0 }, "b.md": {} },
  });
  assert.equal(
    collectNoteMetadata(app, makeFile("target.md")).backlinksTotal,
    0,
  );
});

console.log("\ncollectNoteMetadata: frontmatter and tags");
it("strips Obsidian's injected position key", () => {
  const app = makeApp({
    cache: {
      frontmatter: { type: "service", position: { start: {}, end: {} } },
    },
  });
  const meta = collectNoteMetadata(app, makeFile("n.md"));
  assert.deepEqual(Object.keys(meta.frontmatter), ["type"]);
});
it("merges inline and frontmatter tags, normalising and deduping", () => {
  const app = makeApp({
    cache: {
      tags: [{ tag: "#alpha" }, { tag: "#beta" }],
      frontmatter: { tags: ["beta", "gamma"] },
    },
  });
  const meta = collectNoteMetadata(app, makeFile("n.md"));
  assert.deepEqual(meta.tags, ["#alpha", "#beta", "#gamma"]);
});
it("accepts a space/comma separated frontmatter tag string", () => {
  const app = makeApp({ cache: { frontmatter: { tags: "one, two three" } } });
  assert.deepEqual(collectNoteMetadata(app, makeFile("n.md")).tags, [
    "#one",
    "#two",
    "#three",
  ]);
});
it("cleans YAML punctuation off a tag string", () => {
  // A real vault note produced the literal "[context]", which used to render as
  // the nonsense tag "#[context]".
  const app = makeApp({ cache: { frontmatter: { tags: "[context]" } } });
  assert.deepEqual(collectNoteMetadata(app, makeFile("n.md")).tags, [
    "#context",
  ]);
});
it("drops tags that clean away to nothing", () => {
  const app = makeApp({ cache: { frontmatter: { tags: "[]" } } });
  assert.deepEqual(collectNoteMetadata(app, makeFile("n.md")).tags, []);
});
it("strips quotes from frontmatter tags", () => {
  const app = makeApp({
    cache: { frontmatter: { tags: ['"quoted"', "plain"] } },
  });
  assert.deepEqual(collectNoteMetadata(app, makeFile("n.md")).tags, [
    "#quoted",
    "#plain",
  ]);
});
it("survives a note with no cache at all", () => {
  const meta = collectNoteMetadata(makeApp({ cache: null }), makeFile("n.md"));
  assert.deepEqual(meta.tags, []);
  assert.deepEqual(meta.headings, []);
  assert.equal(meta.backlinksTotal, 0);
});

console.log("\nformatNoteContext");
const emptyMeta = {
  path: "n.md",
  createdMs: null,
  modifiedMs: null,
  sizeBytes: null,
  frontmatter: {},
  tags: [],
  headings: [],
  linksOut: [],
  linksOutTotal: 0,
  unresolvedOut: [],
  unresolvedOutTotal: 0,
  embeds: [],
  embedsTotal: 0,
  backlinks: [],
  backlinksTotal: 0,
};

it("a bare note yields only the path line", () => {
  const out = formatNoteContext(emptyMeta);
  assert.equal(out.split("\n").length, 1);
  assert.ok(out.includes("`n.md`"));
});
it("collapses a multi-line frontmatter value onto one line", () => {
  const out = formatNoteContext({
    ...emptyMeta,
    frontmatter: { summary: "line one\n  line two" },
  });
  const summaryLines = out.split("\n").filter((l) => l.includes("summary:"));
  assert.equal(summaryLines.length, 1);
  assert.ok(summaryLines[0].includes("line one line two"));
});
it("joins array frontmatter values", () => {
  const out = formatNoteContext({
    ...emptyMeta,
    frontmatter: { related: ["a", "b"] },
  });
  assert.ok(out.includes("related: a, b"));
});
it("truncates an absurd frontmatter value", () => {
  const out = formatNoteContext({
    ...emptyMeta,
    frontmatter: { blob: "x".repeat(5000) },
  });
  assert.ok(out.includes("\u2026"));
  assert.ok(out.length < 1000);
});
it("caps the outline and reports the remainder", () => {
  const headings = Array.from({ length: 40 }, (_, i) => ({
    level: 1,
    heading: `H${String(i)}`,
  }));
  const out = formatNoteContext({ ...emptyMeta, headings });
  assert.ok(out.includes("Outline (40)"));
  assert.ok(
    out.includes(`\u2026 ${String(40 - DEFAULT_LIMITS.headings)} more`),
  );
});
it("caps backlinks but always reports the true total", () => {
  const backlinks = Array.from({ length: 50 }, (_, i) => `n${String(i)}.md`);
  const out = formatNoteContext({
    ...emptyMeta,
    backlinks,
    backlinksTotal: 50,
  });
  assert.ok(out.includes("Linked from (50)"));
  assert.ok(
    out.includes(`\u2026 ${String(50 - DEFAULT_LIMITS.backlinks)} more`),
  );
});
it("omits every empty section", () => {
  const out = formatNoteContext(emptyMeta);
  for (const label of [
    "Properties",
    "Tags",
    "Outline",
    "Links to",
    "Linked from",
  ]) {
    assert.ok(!out.includes(label), `${label} should be absent`);
  }
});
it("indents the outline by heading level", () => {
  const out = formatNoteContext({
    ...emptyMeta,
    headings: [
      { level: 1, heading: "Top" },
      { level: 3, heading: "Deep" },
    ],
  });
  const deep = out.split("\n").find((l) => l.includes("Deep"));
  const top = out.split("\n").find((l) => l.includes("Top"));
  assert.ok(
    deep.length - deep.trimStart().length > top.length - top.trimStart().length,
  );
});
it("indents relative to the shallowest heading, not to h1", () => {
  // Many notes start at h2; indenting the whole outline for that is noise.
  const out = formatNoteContext({
    ...emptyMeta,
    headings: [
      { level: 2, heading: "Top" },
      { level: 3, heading: "Child" },
    ],
  });
  const top = out.split("\n").find((l) => l.includes("Top"));
  const child = out.split("\n").find((l) => l.includes("Child"));
  assert.equal(top, "    Top");
  assert.equal(child, "      Child");
});

fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
console.log(
  failures === 0
    ? "\nall note-context checks passed\n"
    : `\n${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
