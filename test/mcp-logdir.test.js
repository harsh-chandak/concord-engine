import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which log did the MCP server just write to?
 *
 * A stdio server's working directory belongs to whoever launched it. With
 * CONCORD_ENGINE_DIR unset, the relative default resolves against THAT
 * directory, not the project's — and in a real fan-out it did: three workers
 * called record_decision, each got `recorded: true`, and all three decisions
 * landed in ~/Desktop/.concord-engine while the project read
 * ~/Desktop/tarot/.concord-engine. `report` stayed clean.
 *
 * Nothing in the existing MCP coverage could catch that: mcp-smoke checks the
 * server initializes under four env cases, never where it writes. These tests
 * assert the location is reported, because silence is the actual defect — the
 * write succeeds, so the only possible signal is the server saying where.
 *
 * Written against raw stdio framing, like mcp-smoke, so it does not pass for
 * the wrong reason by importing an optional peer the package may not have.
 *
 * Temp dirs are realpath'd: on macOS /var is a symlink to /private/var, so
 * mkdtemp returns one form while the server resolving its own cwd returns the
 * other. That is an artefact of the test, not of the product, and it is worth
 * fixing with realpath rather than by loosening the assertion to a suffix.
 */

const SERVER = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "../dist/mcp.js"));

/** One handshake, then the given tool calls, against a server in `cwd`. */
async function talk(cwd, envDir, calls) {
  const env = { ...process.env };
  delete env.CONCORD_ENGINE_DIR;
  if (envDir !== undefined) env.CONCORD_ENGINE_DIR = envDir;

  const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  await new Promise((r) => setTimeout(r, 700));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  calls.forEach((c, i) => send({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: c }));
  await new Promise((r) => setTimeout(r, 1500));
  child.kill("SIGKILL");

  const lines = out.trim().split("\n").filter(Boolean);
  const replies = new Map();
  for (const l of lines) {
    // Any non-JSON line here is the bug this package shipped for eight days:
    // stdout IS the protocol channel.
    let j;
    try { j = JSON.parse(l); } catch { assert.fail(`non-JSON on stdout (protocol channel): ${l.slice(0, 120)}`); }
    if (typeof j.id === "number" && j.id >= 10) {
      const text = j.result?.content?.[0]?.text ?? "";
      try { replies.set(j.id, JSON.parse(text)); } catch { replies.set(j.id, text); }
    }
  }
  return { replies, stderr: err };
}

const DECISION = { name: "record_decision", arguments: {
  kind: "naming", subject: "where the log goes", value: "reported",
  author: "test", rationale: "the location must come back in the response" } };

test("with CONCORD_ENGINE_DIR unset, the server reports the log it fell back to", async () => {
  const host = realpathSync(mkdtempSync(join(tmpdir(), "ce-host-")));
  const { replies, stderr } = await talk(host, undefined, [{ name: "status", arguments: {} }, DECISION]);

  const status = replies.get(10);
  assert.ok(status && typeof status === "object", `status returned nothing usable: ${JSON.stringify(status)}`);
  assert.equal(status.logChosen, false, "nobody chose this directory, and status must say so");
  assert.equal(status.log, resolve(host, ".concord-engine"),
    "status must name the ABSOLUTE log path, so a wrong one is visible");

  const rec = replies.get(11);
  assert.equal(rec?.recorded, true, "the decision should still be recorded");
  assert.equal(rec?.log, resolve(host, ".concord-engine"),
    "record_decision must say where it wrote — a success with no location is the silent failure");

  assert.match(stderr, /CONCORD_ENGINE_DIR is not set/,
    "a server never told where to look must say so on stderr");
  assert.ok(stderr.includes(resolve(host, ".concord-engine")),
    "and the warning must name the directory it is about to use");
});

test("with CONCORD_ENGINE_DIR set, the log follows the project and the warning goes quiet", async () => {
  const host = realpathSync(mkdtempSync(join(tmpdir(), "ce-host-")));
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "ce-proj-")));
  const dir = join(proj, ".concord-engine");

  const { replies, stderr } = await talk(host, dir, [{ name: "status", arguments: {} }, DECISION]);

  assert.equal(replies.get(10)?.logChosen, true, "this directory was chosen deliberately");
  assert.equal(replies.get(10)?.log, resolve(dir));
  assert.equal(replies.get(11)?.log, resolve(dir),
    "the write must follow the project, not the directory the server happens to sit in");
  assert.doesNotMatch(stderr, /CONCORD_ENGINE_DIR is not set/,
    "no warning when it was told where to look");

  // The decision is in the project's log and nowhere near the server's cwd.
  const path = join(dir, "decisions.jsonl");
  assert.ok(existsSync(path), "the project log should exist");
  assert.match(readFileSync(path, "utf8"), /where the log goes/);
  assert.ok(!existsSync(join(host, ".concord-engine")),
    "nothing may be written beside the server when a project was named");
});

test("an empty binding_decisions answer says which log it looked in", async () => {
  // The dangerous case, proven live: a server started outside the project
  // answered count 0 for a subject that had two decisions in force, because it
  // was reading a different project's log. The tool tells workers to call it
  // before writing code, so an unqualified count 0 reads as permission.
  const host = realpathSync(mkdtempSync(join(tmpdir(), "ce-host-")));
  const { replies } = await talk(host, undefined, [
    { name: "binding_decisions", arguments: { subject: "a subject nobody decided" } },
    { name: "open_conflicts", arguments: {} },
  ]);

  const binding = replies.get(10);
  assert.equal(binding?.count, 0, "nothing is decided in a fresh directory");
  assert.equal(binding?.log, resolve(host, ".concord-engine"),
    "an empty answer must name the log it came from");
  assert.match(binding?.note ?? "", /not proof that nothing was decided/,
    "and must refuse to be read as permission to choose freely");
  assert.ok((binding?.note ?? "").includes(resolve(host, ".concord-engine")),
    "the note itself must carry the path, since the note is what a worker reads");

  assert.equal(replies.get(11)?.log, resolve(host, ".concord-engine"),
    "open_conflicts must report its log too");
});
