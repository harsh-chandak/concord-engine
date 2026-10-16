#!/usr/bin/env node
/**
 * Does the MCP server start, speak the protocol, and offer every tool?
 *
 * Written against the raw stdio framing rather than the SDK client, because
 * the SDK is an optional peer: a test that imported it would pass for reasons
 * the installed user does not share. Node builtins only.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "dist", "mcp.js");

/** Every tool the server promises. v0.1 first, then the v0.2 loop. */
const EXPECTED = [
  "record_decision",
  "binding_decisions",
  "open_conflicts",
  "record_attempt",
  "status",
  "write_contract",
  "bind_contract",
  "brief_unit",
  "fleet_plan",
  "run_acceptance",
  "generate_docs",
  "cost_report",
];

const TIMEOUT_MS = 20_000;

function die(message, detail) {
  process.stderr.write(`\nmcp-smoke: ${message}\n`);
  if (detail) process.stderr.write(`${String(detail).trim()}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

if (!existsSync(SERVER)) die(`${SERVER} is missing. Run \`npm run build\` first.`);

// A throwaway log dir, so a smoke test can never touch the project's own.
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ORCHESTRAGUARD_DIR: mkdtempSync(join(tmpdir(), "og-smoke-")) },
});

let stderr = "";
child.stderr.on("data", (c) => { stderr += c; });

/** Resolved by id as responses arrive; the server may interleave them. */
const pending = new Map();
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  // Stdio framing is newline-delimited JSON, one message per line.
  for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      die("server wrote a line that is not JSON", line);
    }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});

child.on("exit", (code, signal) => {
  if (pending.size) die(`server exited (code ${code}, signal ${signal}) before answering`, stderr);
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// A hung server is a failure, not a reason for CI to sit there.
const watchdog = setTimeout(() => {
  child.kill("SIGKILL");
  die(`no answer within ${TIMEOUT_MS / 1000}s`, stderr);
}, TIMEOUT_MS);
watchdog.unref?.();

function finish(code, message, detail) {
  clearTimeout(watchdog);
  child.stdin.end();
  child.kill("SIGKILL");
  if (code === 0) {
    process.stdout.write(`${message}\n`);
    process.exit(0);
  }
  die(message, detail);
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "0" },
});
if (init.error) finish(1, `initialize failed: ${JSON.stringify(init.error)}`, stderr);
if (!init.result?.serverInfo?.name) finish(1, "initialize returned no serverInfo", JSON.stringify(init));

send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

const listed = await request("tools/list", {});
if (listed.error) finish(1, `tools/list failed: ${JSON.stringify(listed.error)}`, stderr);

const tools = listed.result?.tools;
if (!Array.isArray(tools)) finish(1, "tools/list returned no tools array", JSON.stringify(listed));

const names = tools.map((t) => t.name);
const missing = EXPECTED.filter((n) => !names.includes(n));
if (missing.length) {
  finish(1, `the server does not expose: ${missing.join(", ")}`, `it exposes: ${names.join(", ") || "(none)"}`);
}

// Every tool has to be callable, which means a usable input schema.
const unusable = tools.filter((t) => !t.description?.trim() || t.inputSchema?.type !== "object");
if (unusable.length) {
  finish(1, `these tools lack a description or an object inputSchema: ${unusable.map((t) => t.name).join(", ")}`);
}

const extra = names.filter((n) => !EXPECTED.includes(n));
finish(
  0,
  `mcp-smoke: ${init.result.serverInfo.name} v${init.result.serverInfo.version} lists all ${EXPECTED.length} tools` +
    (extra.length ? ` (plus ${extra.join(", ")})` : ""),
);
