#!/usr/bin/env node
/**
 * Record a REAL orchestraguard session and write it out for the renderer.
 *
 * The previous demo was a hand-written HTML mock of a terminal: the layout
 * was real, the output was invented. For a tool whose whole argument is that
 * it refuses things deterministically, a fabricated refusal is the worst
 * possible illustration — you cannot ask people to trust a gate and then
 * show them a drawing of one.
 *
 * So this runs the actual CLI against an actual contract in a throwaway
 * directory and captures stdout and stderr verbatim. Every character the
 * renderer later displays came out of the program. The only authored strings
 * are the user's prompt and the one-line narrations between steps, and those
 * are marked as a different kind so they can never be mistaken for output.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../dist/cli.js");
const box = mkdtempSync(join(tmpdir(), "orchestraguard-demo-"));
const session = [];

const say = (text) => session.push({ kind: "say", text });
const prompt = (text) => session.push({ kind: "prompt", text });

/** Run a command for real and keep exactly what it printed. */
function run(display, args, { expectFailure = false } = {}) {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: box, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (expectFailure && code === 0) {
    throw new Error(`expected "${display}" to be refused, but it succeeded:\n${out}`);
  }
  if (!expectFailure && code !== 0) {
    throw new Error(`"${display}" failed unexpectedly (exit ${code}):\n${out}`);
  }
  session.push({ kind: "cmd", text: display });
  session.push({ kind: "out", text: out.replace(/\n+$/, ""), code });
  return out;
}

/* ------------------------------------------------------------------ *
 * The scenario: one task, two workers, one disagreement.               *
 * ------------------------------------------------------------------ */

const contract = {
  id: "add-refunds",
  goal: "Add refunds across the API and the client without the two disagreeing about the wire format.",
  scope: {
    in: ["the refund endpoint", "the client call", "the refund status values"],
    out: ["partial refunds", "the ledger", "emails"],
  },
  decisions: [
    {
      kind: "api-contract",
      subject: "refund creation endpoint",
      value: { method: "POST", path: "/api/orders/:orderId/refunds", status: 201 },
      rationale: "201 is correct for creation and the client branches on it",
    },
    {
      kind: "enum",
      subject: "refund status values",
      value: ["requested", "settled", "failed"],
      rationale: "the API serialises these and the client renders them",
    },
  ],
  openSubjects: [
    {
      kind: "convention",
      subject: "error response body shape",
      note: "the server writes it and the client parses it — settle it once",
    },
  ],
  units: [
    {
      id: "schema", goal: "Add the refunds table and the migration that creates it.",
      files: ["db/migrations/*", "src/db/refunds.ts"], mayDecide: ["schema"], dependsOn: [],
    },
    {
      id: "api", goal: "Serve the refund endpoint over the refunds table.",
      files: ["src/api/refunds.ts"], mayDecide: ["convention"], dependsOn: [],
    },
    {
      id: "client", goal: "Call the refund endpoint and surface failures to the caller.",
      files: ["src/client/refunds.ts"], mayDecide: ["convention"], dependsOn: [],
    },
    {
      id: "tests", goal: "Cover the refund path end to end, including a refusal.",
      files: ["test/refunds.test.ts"], mayDecide: [], dependsOn: ["api", "client"],
    },
  ],
  acceptance: [
    { id: "a-schema", statement: "the migration applies cleanly", check: "true", unit: "schema" },
    { id: "a-api", statement: "the endpoint answers 201", check: "true", unit: "api" },
    { id: "a-client", statement: "the client surfaces a refusal", check: "true", unit: "client" },
    { id: "a-tests", statement: "the refund path is covered end to end", check: "true", unit: "tests" },
  ],
};

writeFileSync(join(box, "add-refunds.json"), JSON.stringify(contract, null, 2));

try {
  prompt("add refunds — split it across a backend and a frontend worker");
  say("I'll write the contract first, then fan out.");

  run("orchestraguard spec --from add-refunds.json", ["spec", "--from", "add-refunds.json"]);
  say("Binding it, so the decisions hold before anyone writes code.");
  run("orchestraguard bind --contract add-refunds", ["bind", "--contract", "add-refunds"]);
  run("orchestraguard fleet --contract add-refunds", ["fleet", "--contract", "add-refunds"]);

  say("Each worker gets its brief — not the contract, and not this conversation.");
  run("orchestraguard brief --contract add-refunds api",
      ["brief", "--contract", "add-refunds", "api"]);

  say("The api worker settles the error shape.");
  run('orchestraguard decide --unit api --kind convention --subject "error response body shape" ...',
      ["decide", "--contract", "add-refunds", "--unit", "api", "--kind", "convention",
       "--subject", "error response body shape",
       "--value", 'every non-2xx body is {"error":"<message>"}',
       "--as", "api", "--rationale", "the client shows it to a person"]);

  say("Meanwhile the client worker, in parallel, reaches a different answer.");
  run('orchestraguard decide --unit client --kind convention --subject "error response body shape" ...',
      ["decide", "--contract", "add-refunds", "--unit", "client", "--kind", "convention",
       "--subject", "error response body shape",
       "--value", 'every non-2xx body is {"code":"<slug>","detail":"<message>"}',
       "--as", "client", "--rationale", "the client branches on a machine-readable code"],
      { expectFailure: true });

  say("Refused at the moment it was written — not found at integration.");
  run("orchestraguard accept --contract add-refunds", ["accept", "--contract", "add-refunds"]);
  run("orchestraguard cost --contract add-refunds", ["cost", "--contract", "add-refunds"]);

  const js = `window.__SESSION = ${JSON.stringify(session, null, 2)};\n`;
  writeFileSync(join(HERE, "session.js"), js);
  const lines = session.filter((s) => s.kind === "out")
    .reduce((n, s) => n + s.text.split("\n").length, 0);
  console.log(`recorded ${session.length} steps, ${lines} lines of real output -> brag/session.js`);
} finally {
  rmSync(box, { recursive: true, force: true });
}
