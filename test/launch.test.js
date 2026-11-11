/**
 * How this package gets launched, and what its surfaces say when you get it
 * wrong.
 *
 * Three defects met here, all of them in the seam between the package and the
 * thing starting it — the part no unit test was watching:
 *
 *   A. the plugin launched the server through `npx -y -p concord-engine@...`,
 *      so every session start depended on the network and on the npm cache. A
 *      corrupt cache entry (node_modules/ with no package.json) made npm exit
 *      ENOENT before the server ever spoke MCP, and the host reported only
 *      "CONNECTION_CLOSED". Two sessions lost to it, one for eight days.
 *   B. `brief` printed `concord-engine decide ...`, which does not run: the bin
 *      is not on PATH and the brief is used from another directory entirely.
 *      The brief is documented as the complete worker prompt, so its central
 *      instruction was inert — a peer hand-edited it 86 times in one session.
 *   C. an MCP tool name typed at the CLI printed the full help text on stdout
 *      and one line on stderr, which in a transcript reads as success.
 *
 * None of these needs the MCP SDK, which is an optional peer: the manifest is
 * read as data and the CLI is spawned directly. `test/mcp-smoke.mjs` covers the
 * server actually speaking the protocol, and stays out of `npm test` for that
 * reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const src = (f) => readFileSync(join(ROOT, "src", f), "utf8");
const manifest = () =>
  JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
const pkg = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-launch-"));

/** Runs the built CLI and keeps the streams apart, which is the point in C. */
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...opts,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/* ------------------------------------------------------------------ *
 * A. the launch path                                                  *
 * ------------------------------------------------------------------ */

test("the plugin launches the server with node, off the built file in the plugin root", () => {
  const server = manifest().mcpServers["concord-engine"];
  assert.equal(
    server.command,
    "node",
    "launching through a package manager puts the network in session start",
  );
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"]);
});

test("nothing in the launch path can reach the network or the npm cache", () => {
  // The corrupt-cache failure was unactionable from the host's side: npm exited
  // before the server spoke, so Claude Code could only say CONNECTION_CLOSED.
  // The fix is to have nothing there that can fail that way.
  const server = manifest().mcpServers["concord-engine"];
  const whole = JSON.stringify(server);
  for (const forbidden of [
    "npx",
    "npm",
    "-p ",
    "concord-engine@",
    "@modelcontextprotocol/sdk@",
  ]) {
    assert.ok(
      !whole.includes(forbidden),
      `${forbidden} is back in the launch path: ${whole}`,
    );
  }
});

test("the file the plugin says it will run is the file the package ships", () => {
  // Two ways this breaks: the manifest names a path that is not built, or
  // `files` stops shipping dist and the plugin root arrives without it.
  const [arg] = manifest().mcpServers["concord-engine"].args;
  const relative = arg.replace("${CLAUDE_PLUGIN_ROOT}/", "");
  assert.equal(relative, "dist/mcp.js");
  assert.ok(
    existsSync(join(ROOT, relative)),
    `${relative} is missing — run \`npm run build\``,
  );
  assert.ok(
    pkg().files.includes("dist"),
    "dist left package.json's files array; the built server would not ship",
  );
});

test("the server still receives the user's configured log directory", () => {
  // Removing npx must not take the one thing the env block was carrying.
  assert.equal(
    manifest().mcpServers["concord-engine"].env.CONCORD_ENGINE_DIR,
    "${user_config.decisions_dir}",
  );
});

test("the bin entry the manifest no longer names is still published", () => {
  // The manifest stopped going through the bin, but an npm user has not.
  assert.equal(pkg().bin["concord-engine-mcp"], "dist/mcp.js");
  assert.equal(pkg().bin["concord-engine"], "dist/cli.js");
});

/* ------------------------------------------------------------------ *
 * B. a brief whose commands run                                       *
 * ------------------------------------------------------------------ */

/** A contract with one unit that is allowed to decide something. */
const contract = {
  id: "launch-demo",
  goal: "Prove the brief prints a command that runs.",
  scope: { in: ["src/cli.ts"], out: ["anything that calls a model"] },
  decisions: [],
  units: [
    {
      id: "only",
      goal: "do the thing",
      files: ["src/cli.ts"],
      mayDecide: ["convention"],
      dependsOn: [],
    },
  ],
  acceptance: [
    { id: "a-1", statement: "it runs", check: "true", unit: "only" },
  ],
  openSubjects: [{ kind: "convention", subject: "error response body shape" }],
};

/** Stores the contract in a throwaway log dir and returns the brief text. */
function briefIn(dir) {
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify(contract), "utf8");
  const stored = cli(["spec", "--from", file, "--dir", dir]);
  assert.equal(stored.status, 0, `spec failed: ${stored.err}`);
  const b = cli(["brief", "--contract", contract.id, "only", "--dir", dir]);
  assert.equal(b.status, 0, `brief failed: ${b.err}`);
  return b.out;
}

/** The two printed lines of the decide instruction, joined and unwrapped. */
function printedCommand(brief) {
  const lines = brief.split("\n");
  const at = lines.findIndex((l) => l.includes("RECORD A DECISION"));
  assert.ok(
    at !== -1,
    "the brief no longer tells the worker how to record a decision",
  );
  return `${lines[at + 1]} ${lines[at + 2]}`.replace(/\\/g, "").trim();
}

test("the brief's decide instruction names a real interpreter and a real script", () => {
  const dir = box();
  try {
    const cmd = printedCommand(briefIn(dir));
    const script = cmd.match(/ node (\S+\/dist\/cli\.js) /)?.[1];
    assert.ok(
      script,
      `no \`node <path>/dist/cli.js\` in the printed command:\n  ${cmd}`,
    );
    assert.ok(
      isAbsolute(script),
      `the script path must be absolute, got ${script}`,
    );
    assert.ok(
      existsSync(script),
      `the brief points at ${script}, which does not exist`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the brief does not print the bare command, which is not on PATH", () => {
  // `which concord-engine` finds nothing, and `npx --no-install concord-engine`
  // resolves only inside this package's own root — never where a worker is.
  const dir = box();
  try {
    const cmd = printedCommand(briefIn(dir));
    assert.ok(
      !/(^|\s)concord-engine\s+decide/.test(cmd),
      `the inert form is back:\n  ${cmd}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the brief carries the log directory it was generated against, absolutely", () => {
  // A worker runs somewhere else. The default `.concord-engine` is relative, so
  // an omitted value would resolve against the worker's cwd: a second log, no
  // decisions in it, and every decide succeeding against nothing.
  const dir = box();
  try {
    const cmd = printedCommand(briefIn(dir));
    const got = cmd.match(/CONCORD_ENGINE_DIR=(\S+)/)?.[1];
    assert.ok(
      got,
      `the printed command does not carry CONCORD_ENGINE_DIR:\n  ${cmd}`,
    );
    assert.ok(
      isAbsolute(got),
      `the log directory must be absolute, got ${got}`,
    );
    assert.equal(
      readFileSync(join(got, "contracts", `${contract.id}.json`), "utf8")
        .length > 0,
      true,
      `${got} is not the directory the brief was generated against`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command the brief prints records a decision when run from somewhere else", () => {
  // The whole of defect B in one test: take what the brief printed, fill in the
  // placeholders, run it from an unrelated cwd, and check the decision landed
  // in the brief's log rather than a fresh one beside the worker.
  const dir = box();
  const elsewhere = box();
  try {
    const cmd = printedCommand(briefIn(dir))
      .replace(
        `--kind <kind> --subject "<what>" --value '<value>'`,
        `--kind convention --subject "error response body shape" --value "one error string field"`,
      )
      .replace(`--rationale "<why>"`, `--rationale "both sides serialise it"`);

    // Split the way a shell would, honouring the quotes the brief printed.
    const argv = cmd.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ""));
    const env = argv.shift().split("=");
    assert.equal(env[0], "CONCORD_ENGINE_DIR");
    assert.equal(
      argv.shift(),
      "node",
      "the printed command must start by naming the interpreter",
    );

    const r = spawnSync(process.execPath, argv, {
      cwd: elsewhere,
      encoding: "utf8",
      env: { ...process.env, CONCORD_ENGINE_DIR: env[1] },
    });
    assert.equal(
      r.status,
      0,
      `the brief's own command failed:\n${r.stdout}\n${r.stderr}`,
    );
    assert.match(r.stdout, /recorded/, "the command ran but recorded nothing");

    const log = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    assert.match(
      log,
      /error response body shape/,
      "the decision did not reach the brief's log",
    );
    assert.ok(
      !existsSync(join(elsewhere, ".concord-engine")),
      "the worker's cwd grew its own log — the directory was not carried through",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the fleet footer prints the same runnable form, not the bare command", () => {
  const dir = box();
  try {
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify(contract), "utf8");
    cli(["spec", "--from", file, "--dir", dir]);
    const r = cli(["fleet", "--contract", contract.id, "--dir", dir]);
    assert.equal(r.status, 0, r.err);
    assert.ok(
      !/(^|\s)concord-engine\s+brief/.test(r.out),
      `the inert hint is back:\n${r.out}`,
    );
    assert.match(
      r.out,
      / node \S+\/dist\/cli\.js brief /,
      "the footer should print what it told you to run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * C. a wrong command that looks wrong                                 *
 * ------------------------------------------------------------------ */

test("an unknown command exits non-zero and writes nothing to stdout", () => {
  const r = cli(["definitely-not-a-command"]);
  assert.notEqual(
    r.status,
    0,
    "a command that did not run must not report success",
  );
  assert.equal(
    r.out,
    "",
    "help on stdout is what made this scan as success in a transcript",
  );
  assert.match(r.err, /unknown command/i);
  assert.ok(
    r.err.length < 200,
    `the error should be short, got ${r.err.length} bytes:\n${r.err}`,
  );
});

test("an MCP tool name typed at the CLI names its CLI counterpart", () => {
  // SKILL.md said "call open_conflicts". It is not a CLI command, and the old
  // handler answered with 1690 bytes of help and no usable pointer.
  for (const [name, expected] of [
    ["open_conflicts", "conflicts"],
    ["status", "report"],
  ]) {
    const r = cli([name]);
    assert.notEqual(r.status, 0, `${name} must not look like it worked`);
    assert.equal(r.out, "", `${name} put help on stdout`);
    assert.match(r.err, /MCP tool/, `${name} should say where it does exist`);
    assert.match(
      r.err,
      new RegExp(`concord-engine ${expected}\\b`),
      `${name} should name \`${expected}\``,
    );
  }
});

test("every tool the MCP server exposes is reachable from the CLI, or says it is not", () => {
  // The drift this catches: a tool added over MCP and never mentioned at the
  // CLI, which is exactly how `status` and `open_conflicts` became dead ends.
  const tools = [...src("mcp.ts").matchAll(/^    name: "([a-z_]+)",$/gm)].map(
    (m) => m[1],
  );
  assert.ok(
    tools.length >= 12,
    `only found ${tools.length} tool names — this test may be scanning nothing`,
  );
  const commands = new Set(
    [...src("cli.ts").matchAll(/cmd === "([a-z_]+)"/g)].map((m) => m[1]),
  );
  const mapped = new Set(
    [
      ...src("cli.ts")
        .match(/const MCP_ONLY: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
        .matchAll(/^  ([a-z_]+):/gm),
    ].map((m) => m[1]),
  );
  for (const t of tools) {
    assert.ok(
      commands.has(t) || mapped.has(t),
      `MCP tool "${t}" is neither a CLI command nor listed in MCP_ONLY, so the CLI cannot point anywhere`,
    );
  }
});

test("every CLI command MCP_ONLY points at actually exists", () => {
  // A pointer to a command that does not exist is worse than no pointer.
  const commands = new Set(
    [...src("cli.ts").matchAll(/cmd === "([a-z_]+)"/g)].map((m) => m[1]),
  );
  const body = src("cli.ts").match(
    /const MCP_ONLY: Record<string, string> = \{([\s\S]*?)\n\};/,
  )[1];
  const pairs = [...body.matchAll(/^  ([a-z_]+): "([^"]+)",$/gm)];
  assert.ok(
    pairs.length >= 12,
    `only parsed ${pairs.length} entries — this test may be scanning nothing`,
  );
  for (const [, name, target] of pairs) {
    const word = target.split(" ")[0];
    assert.ok(
      commands.has(word),
      `MCP_ONLY.${name} points at "${word}", which is not a CLI command`,
    );
  }
});

test("help still succeeds and still prints the command list on stdout", () => {
  // The fix removed USAGE from the failure path, not from help.
  const r = cli(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /concord-engine decide/);
  assert.match(r.out, /concord-engine conflicts/);
});

test("SKILL.md does not send an agent to a CLI command that does not exist", () => {
  // The documented flow is the product here: an instruction to "call
  // open_conflicts" with no note that it is MCP-only is the defect, not a typo.
  const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  const mcpOnly = [
    ...src("cli.ts")
      .match(/const MCP_ONLY: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
      .matchAll(/^  ([a-z_]+):/gm),
  ].map((m) => m[1]);
  for (const name of mcpOnly) {
    if (!skill.includes(name)) continue;
    assert.ok(
      !new RegExp(`concord-engine ${name}\\b`).test(skill),
      `SKILL.md shows \`concord-engine ${name}\`, which is an MCP tool name, not a command`,
    );
  }
  // And it has to say somewhere that the two surfaces differ.
  assert.match(
    skill,
    /over MCP \| on the CLI|not a CLI command|MCP tool/i,
    "SKILL.md should state that MCP names and CLI commands are not the same words",
  );
  assert.match(
    skill,
    /not on PATH/i,
    "SKILL.md should say the bare `concord-engine` command is not on PATH",
  );
});
