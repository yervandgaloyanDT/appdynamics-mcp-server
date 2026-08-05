#!/usr/bin/env node
/**
 * Smoke check: the built server must come up on stdio and announce itself.
 *
 * The unit tests never import src/index.ts, so a broken entry point — a bad
 * import, a tool registration that throws at module load — typechecks and ships
 * without anything noticing. This runs dist/index.js and waits for the startup
 * banner on stderr. No controller credentials are needed: the server registers
 * its tools and connects the transport before it talks to AppDynamics.
 *
 * Usage: node test/smoke/start-server.mjs [entry]   (default: dist/index.js)
 */

import { spawn } from "node:child_process";

const entry = process.argv[2] ?? "dist/index.js";
const TIMEOUT_MS = 30_000;
const BANNER = /running via stdio/;

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let settled = false;

const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console[code === 0 ? "log" : "error"](message);
  child.kill();
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `FAIL: no startup banner within ${TIMEOUT_MS}ms.\nstderr:\n${stderr}`),
  TIMEOUT_MS
);

child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (BANNER.test(stderr)) finish(0, `OK: ${stderr.trim()}`);
});

child.on("error", (err) => finish(1, `FAIL: could not spawn ${entry}: ${err.message}`));

child.on("exit", (code) =>
  finish(1, `FAIL: server exited early with code ${code}.\nstderr:\n${stderr}`)
);
