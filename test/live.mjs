#!/usr/bin/env node
/*
 * Live test: one real LLM turn through the bridge, asserting the exact event
 * sequence src/transcript.ts consumes. Costs a few tokens.
 *
 *   node test/live.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PORT = 8901;
const TOKEN = "live-test-token";
const stateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "obs-harness-live-state-"),
);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-harness-live-cwd-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "\u2713" : "\u2717"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const retry = () => {
        if (Date.now() > deadline)
          reject(new Error("server never became healthy"));
        else setTimeout(attempt, 200);
      };
      const req = http.get(
        { host: "127.0.0.1", port: PORT, path: "/health" },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on("error", () => {
        req.destroy();
        retry();
      });
    };
    attempt();
  });
}

const server = spawn(
  process.execPath,
  [
    path.join(repoRoot, "server.js"),
    "--port",
    String(PORT),
    "--token",
    TOKEN,
    "--state-dir",
    stateDir,
    "--quiet",
  ],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);

let exitCode = 1;
try {
  await waitForHealth();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const events = [];
  let assembled = "";

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no agent_settled within 120s")),
      120000,
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      events.push(msg);

      // Assemble streamed text exactly as the panel's renderer does.
      if (
        msg.type === "message_update" &&
        msg.assistantMessageEvent?.type === "text_delta"
      ) {
        assembled += msg.assistantMessageEvent.delta;
      }
      if (msg.type === "bridge_snapshot") {
        ws.send(
          JSON.stringify({
            type: "prompt",
            message:
              "Reply with exactly the token HARNESS_OK and nothing else.",
          }),
        );
      }
      if (msg.type === "agent_settled") {
        clearTimeout(timer);
        resolve();
      }
      if (msg.type === "bridge_status" && msg.phase === "error") {
        clearTimeout(timer);
        reject(new Error(msg.detail ?? "agent failed to start"));
      }
    });
  });

  ws.send(JSON.stringify({ type: "bridge_attach", cwd: workDir }));
  await settled;

  const types = events.map((e) => e.type);
  const deltaKinds = events
    .filter((e) => e.type === "message_update")
    .map((e) => e.assistantMessageEvent?.type);

  console.log("\n[live] event sequence");
  check("agent_start emitted", types.includes("agent_start"));
  check("message_start emitted", types.includes("message_start"));
  check("text_start emitted", deltaKinds.includes("text_start"));
  check(
    "text_delta streamed",
    deltaKinds.filter((t) => t === "text_delta").length > 0,
    `${deltaKinds.filter((t) => t === "text_delta").length} delta(s)`,
  );
  check("text_end emitted", deltaKinds.includes("text_end"));
  check("message_end emitted", types.includes("message_end"));
  check("agent_settled emitted", types.includes("agent_settled"));

  console.log("\n[live] content");
  check(
    "assembled deltas contain the token",
    assembled.includes("HARNESS_OK"),
    JSON.stringify(assembled.trim().slice(0, 80)),
  );

  const endEvent = events.find(
    (e) => e.type === "message_end" && e.message?.role === "assistant",
  );
  const authoritative = (endEvent?.message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  check(
    "message_end matches assembled stream",
    authoritative.trim() === assembled.trim(),
    `authoritative=${JSON.stringify(authoritative.trim().slice(0, 40))}`,
  );

  const userEcho = events.find(
    (e) => e.type === "message_start" && e.message?.role === "user",
  );
  check(
    "user message echoed by pi (dedupe path exercised)",
    userEcho !== undefined,
  );

  ws.close();
  console.log(
    failures === 0
      ? "\nall live checks passed\n"
      : `\n${failures} check(s) FAILED\n`,
  );
  exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`\nlive test error: ${err.message}\n`);
  exitCode = 1;
} finally {
  server.kill("SIGKILL");
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
