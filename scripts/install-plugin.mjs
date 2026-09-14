#!/usr/bin/env node
/*
 * Symlink this repo into a vault's plugin directory so Obsidian loads it in place.
 *
 *   node scripts/install-plugin.mjs [vaultPath]
 *
 * Falls back to $OBSIDIAN_VAULT, then $LORE_VAULT. Existing symlinks are
 * replaced; a real directory is never touched.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
 path.dirname(fileURLToPath(import.meta.url)),
 "..",
);
const manifestPath = path.join(repoRoot, "manifest.json");
let manifest;
try {
 manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (err) {
 console.error(`cannot read plugin manifest ${manifestPath}: ${err.message}`);
 process.exit(1);
}
if (typeof manifest?.id !== "string" || manifest.id.length === 0) {
 console.error(`${manifestPath} has no "id" field`);
 process.exit(1);
}

const vault =
 process.argv[2] ?? process.env.OBSIDIAN_VAULT ?? process.env.LORE_VAULT;
if (!vault) {
 console.error(
  "usage: node scripts/install-plugin.mjs <vaultPath>   (or set $OBSIDIAN_VAULT)",
 );
 process.exit(1);
}

const vaultPath = path.resolve(
 vault.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"),
);
const obsidianDir = path.join(vaultPath, ".obsidian");
if (!fs.existsSync(obsidianDir)) {
 console.error(`not an Obsidian vault (no .obsidian/): ${vaultPath}`);
 process.exit(1);
}

const target = path.join(obsidianDir, "plugins", manifest.id);
fs.mkdirSync(path.dirname(target), { recursive: true });

const existing = fs.lstatSync(target, { throwIfNoEntry: false });
if (existing?.isSymbolicLink()) {
 fs.unlinkSync(target);
} else if (existing) {
 console.error(`refusing to replace real directory: ${target}`);
 process.exit(1);
}

fs.symlinkSync(repoRoot, target, "dir");
// Obsidian's hot-reload plugin watches for this marker file.
fs.writeFileSync(path.join(repoRoot, ".hotreload"), "");

console.log(`linked ${target} -> ${repoRoot}`);
console.log("Enable 'Pi Harness' under Settings -> Community plugins.");
