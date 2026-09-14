#!/usr/bin/env node
/*
 * Regression tests for the transcript's pure formatting helpers.
 *
 * These guard the "content is cut off" class of bug: the helpers used to
 * hard-truncate a chosen dialog answer at 57 chars and a tool preview at 117,
 * which silently destroyed text the panel had room to show. Layout clamping is
 * now CSS's job, so these must return full strings.
 *
 *   node test/format.mjs
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
  fs.mkdtempSync(path.join(os.tmpdir(), "obs-harness-fmt-")),
  "t.mjs",
);

execFileSync(
  "npx",
  [
    "esbuild",
    path.join(repoRoot, "src/transcript.ts"),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    `--alias:obsidian=${path.join(repoRoot, "test/obsidian-stub.mjs")}`,
    `--outfile=${outFile}`,
    "--log-level=warning",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

const { describeAnswer, summarizeArgs, formatArgsBody, extractText } =
  await import(outFile);

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

console.log("\ndescribeAnswer");
it("returns a long answer in full (was truncated at 57 chars)", () => {
  const long =
    "The SKU-Based Release Management RFC (Recommended) \u2014 The one with the version matrix";
  assert.equal(describeAnswer({ value: long }), long);
  assert.ok(!describeAnswer({ value: long }).includes("\u2026"));
});
it("maps booleans to yes/no", () => {
  assert.equal(describeAnswer({ value: true }), "yes");
  assert.equal(describeAnswer({ value: false }), "no");
});
it("reports cancellation", () => {
  assert.equal(describeAnswer({ cancelled: true }), "cancelled");
});
it("falls back for non-string values", () => {
  assert.equal(describeAnswer({ value: 42 }), "answered");
});

console.log("\nsummarizeArgs");
it("returns a long command in full (was truncated at 117 chars)", () => {
  const cmd = `git -C ${"/home/example/notes/some/deep/vault/path".repeat(4)} status --short`;
  assert.equal(summarizeArgs({ command: cmd }), cmd);
  assert.ok(!summarizeArgs({ command: cmd }).includes("\u2026"));
});
it("collapses newlines so a heredoc cannot blow the row open", () => {
  const out = summarizeArgs({ command: "line one\n  line two\nline three" });
  assert.ok(!out.includes("\n"), "no raw newlines");
  assert.equal(out, "line one \u23ce line two \u23ce line three");
});
it("prefers command over other keys", () => {
  assert.equal(summarizeArgs({ path: "/tmp/x", command: "ls" }), "ls");
});
it("falls back to a key list", () => {
  assert.equal(summarizeArgs({ alpha: 1, beta: 2 }), "alpha, beta");
});
it("tolerates non-objects", () => {
  assert.equal(summarizeArgs(undefined), "");
  assert.equal(summarizeArgs("nope"), "");
});

console.log("\nformatArgsBody");
it("renders a lone string arg raw, not as JSON", () => {
  assert.equal(formatArgsBody({ command: "echo hi" }), "echo hi");
  assert.ok(!formatArgsBody({ command: "echo hi" }).includes('"command"'));
});
it("keeps newlines intact in the body (unlike the preview)", () => {
  assert.equal(formatArgsBody({ command: "a\nb" }), "a\nb");
});
it("falls back to pretty JSON for multi-key args", () => {
  const body = formatArgsBody({ path: "/tmp/x", limit: 5 });
  assert.ok(body.includes('"path"') && body.includes('"limit"'));
});
it("handles a bare string and non-records", () => {
  assert.equal(formatArgsBody("raw"), "raw");
  assert.equal(formatArgsBody(7), "7");
});

console.log("\nextractText");
it("flattens content blocks", () => {
  assert.equal(
    extractText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "ab",
  );
});
it("passes strings through and ignores junk", () => {
  assert.equal(extractText("plain"), "plain");
  assert.equal(extractText(null), "");
  assert.equal(extractText([{ type: "image" }]), "");
});

fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
console.log(
  failures === 0
    ? "\nall format checks passed\n"
    : `\n${failures} check(s) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
