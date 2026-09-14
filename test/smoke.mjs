#!/usr/bin/env node
/*
 * End-to-end smoke test for the bridge server against a real pi binary.
 *
 * Deliberately avoids LLM calls: the RPC `bash` command exercises the whole
 * pipeline (spawn, JSONL framing, streaming events, request/response, session
 * persistence, fan-out) locally and for free.
 *
 *   node test/smoke.mjs
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
const PORT = 8899;
const TOKEN = "smoke-test-token";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-harness-state-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-harness-cwd-"));

let failures = 0;
const check = (label, ok, detail = "") => {
  const mark = ok ? "\u2713" : "\u2717";
  if (!ok) failures += 1;
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A WS client that records every message and can await specific ones. */
function connect(token = TOKEN) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`,
  );
  const seen = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    seen.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    ws,
    seen,
    send: (msg) => ws.send(JSON.stringify(msg)),
    open: () =>
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    waitFor: (predicate, timeoutMs = 20000, what = "message") => {
      const existing = seen.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${what}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
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
  ],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);

let exitCode = 1;
try {
  await waitForHealth();
  console.log("\n[1] handshake file");
  const handshakePath = path.join(stateDir, "server.json");
  const handshake = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
  check(
    "written with port + token",
    handshake.port === PORT && handshake.token === TOKEN,
  );
  check(
    "owner-only permissions",
    (fs.statSync(handshakePath).mode & 0o777) === 0o600,
    (fs.statSync(handshakePath).mode & 0o777).toString(8),
  );

  console.log("\n[2] auth");
  const bad = connect("wrong-token");
  const rejected = await bad
    .open()
    .then(() => false)
    .catch(() => true);
  check("bad token rejected at upgrade", rejected);

  console.log("\n[3] attach");
  const a = connect();
  await a.open();
  const hello = await a.waitFor(
    (m) => m.type === "bridge_hello",
    5000,
    "bridge_hello",
  );
  check("bridge_hello received", hello.protocol === 1);
  check(
    "pi detected",
    typeof hello.piVersion === "string" && hello.piVersion.length > 0,
    hello.piVersion ?? "not found",
  );

  a.send({ type: "bridge_attach", cwd: workDir });
  const snapshot = await a.waitFor(
    (m) => m.type === "bridge_snapshot",
    30000,
    "bridge_snapshot",
  );
  check("snapshot returned", Array.isArray(snapshot.messages));
  check("marked as freshly spawned", snapshot.spawned === true);
  check(
    "state includes a model",
    snapshot.state?.model?.id !== undefined,
    snapshot.state?.model?.id ?? "none",
  );
  const realWorkDir = snapshot.cwd;

  console.log("\n[4] streaming bash (no LLM)");
  a.send({
    type: "bash",
    id: "smoke-1",
    command: "printf 'line-a\\nline-b\\n'",
  });
  const bashResponse = await a.waitFor(
    (m) => m.type === "response" && m.command === "bash" && m.id === "smoke-1",
    30000,
    "bash response",
  );
  check(
    "command succeeded",
    bashResponse.success === true && bashResponse.data?.exitCode === 0,
  );
  check(
    "output captured",
    (bashResponse.data?.output ?? "").includes("line-b"),
  );
  const updates = a.seen.filter(
    (m) => m.type === "bash_execution_update" && m.id === "smoke-1",
  );
  check(
    "streamed update events arrived",
    updates.length > 0,
    `${updates.length} event(s)`,
  );

  console.log("\n[5] framing: U+2028 survives a round trip");
  // The exact case Node's readline would corrupt. Octal escapes are used because
  // macOS /bin/sh printf predates \uHHHH support; \342\200\250 is UTF-8 U+2028.
  a.send({
    type: "bash",
    id: "smoke-2",
    command: "printf 'a\\342\\200\\250b\\n'",
  });
  const tricky = await a.waitFor(
    (m) => m.type === "response" && m.id === "smoke-2",
    30000,
    "u2028 response",
  );
  const trickyOutput = tricky.data?.output ?? "";
  check(
    "record not split on U+2028",
    tricky.success === true && trickyOutput.includes("\u2028"),
    JSON.stringify(trickyOutput),
  );

  console.log("\n[6] second panel shares the session");
  const b = connect();
  await b.open();
  await b.waitFor((m) => m.type === "bridge_hello", 5000, "bridge_hello");
  b.send({ type: "bridge_attach", cwd: workDir });
  const snapshot2 = await b.waitFor(
    (m) => m.type === "bridge_snapshot",
    30000,
    "bridge_snapshot",
  );
  check("reattached, not respawned", snapshot2.spawned === false);
  check(
    "prior bash visible in replayed transcript",
    snapshot2.messages.some((m) => m.role === "bashExecution"),
    `${snapshot2.messages.length} message(s)`,
  );
  check("same session key", snapshot2.cwd === realWorkDir);

  console.log("\n[7] fan-out to both panels");
  const beforeA = a.seen.length;
  b.send({ type: "bash", id: "smoke-3", command: "echo fanout" });
  await b.waitFor(
    (m) => m.type === "response" && m.id === "smoke-3",
    30000,
    "fanout response",
  );
  await sleep(300);
  check(
    "panel A saw panel B's activity",
    a.seen.length > beforeA,
    `${a.seen.length - beforeA} new event(s)`,
  );

  console.log("\n[8] command allowlist");
  a.send({ type: "definitely_not_a_command" });
  const err = await a.waitFor(
    (m) => m.type === "bridge_error",
    5000,
    "bridge_error",
  );
  check(
    "unknown command rejected",
    /not allowed/.test(err.message),
    err.message,
  );
  a.send({ type: "get_state", id: "__bridge:steal" });
  const reserved = await a.waitFor(
    (m) => m.type === "bridge_error" && m.id === "__bridge:steal",
    5000,
    "reserved id error",
  );
  check("reserved id prefix rejected", /reserved/.test(reserved.message));

  console.log("\n[9] shutdown");
  a.ws.close();
  b.ws.close();
  server.kill("SIGTERM");
  await sleep(1200);
  check("handshake file removed", !fs.existsSync(handshakePath));

  console.log(
    failures === 0
      ? "\nall checks passed\n"
      : `\n${failures} check(s) FAILED\n`,
  );
  exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`\nsmoke test error: ${err.message}\n`);
  exitCode = 1;
} finally {
  server.kill("SIGKILL");
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
