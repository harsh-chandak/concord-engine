import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDir, DEFAULT_DIR } from "../dist/index.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-dir-"));

const decide = (cwd, env = {}, args = []) =>
  execFileSync(process.execPath, [CLI, "decide",
    "--kind", "naming", "--subject", "probe", "--value", "probe_value",
    "--as", "lead-a", "--json", ...args,
  ], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });

// REGRESSION: the Claude Code plugin passed CONCORD_ENGINE_DIR as an
// unexpanded ${user_config.*} placeholder, which the host expanded to "".
// The MCP server resolved its directory with `??`, which only guards
// null/undefined, so DIR became "" and the log was written to a bare
// decisions.jsonl in the server's cwd — the user's Desktop, outside any
// project, and invisible to `check`.
test("REGRESSION: an empty or blank directory resolves to the default", () => {
  assert.equal(resolveDir(undefined, ""), DEFAULT_DIR);
  assert.equal(resolveDir(undefined, "   "), DEFAULT_DIR);
  assert.equal(resolveDir("", ""), DEFAULT_DIR);
  assert.equal(resolveDir(undefined, undefined), DEFAULT_DIR);
});

test("resolveDir: flag beats environment beats default", () => {
  assert.equal(resolveDir("from-flag", "from-env"), "from-flag");
  assert.equal(resolveDir(undefined, "from-env"), "from-env");
  assert.equal(resolveDir("  ", "from-env"), "from-env", "a blank flag is not a directory");
});

// The same resolution, observed end to end through the CLI process.
// REGRESSION: the Claude Code plugin passed CONCORD_ENGINE_DIR as an
// unexpanded ${user_config.*} placeholder, which arrived as "". `??` let the
// empty string through, so the log was written to a bare decisions.jsonl in
// whatever cwd the MCP server happened to have — outside the project, and
// invisible to `check`.
test("REGRESSION: an empty CONCORD_ENGINE_DIR falls back to the default", () => {
  const cwd = box();
  try {
    decide(cwd, { CONCORD_ENGINE_DIR: "" });
    assert.ok(existsSync(join(cwd, ".concord-engine", "decisions.jsonl")),
      "an empty env var must not relocate the log");
    assert.ok(!existsSync(join(cwd, "decisions.jsonl")),
      "nothing may be written to the cwd root");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("REGRESSION: whitespace is treated as unset, not as a directory name", () => {
  const cwd = box();
  try {
    decide(cwd, { CONCORD_ENGINE_DIR: "   " });
    assert.ok(existsSync(join(cwd, ".concord-engine", "decisions.jsonl")));
    assert.deepEqual(readdirSync(cwd), [".concord-engine"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// The CLI read only --dir while the MCP server read only the environment, so
// setting the documented variable made `check` audit a file the server had
// never written to.
test("REGRESSION: the CLI honours CONCORD_ENGINE_DIR, like the MCP server", () => {
  const cwd = box();
  try {
    decide(cwd, { CONCORD_ENGINE_DIR: "team-decisions" });
    assert.ok(existsSync(join(cwd, "team-decisions", "decisions.jsonl")),
      "the CLI must write where the environment says the log lives");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("--dir beats the environment", () => {
  const cwd = box();
  try {
    decide(cwd, { CONCORD_ENGINE_DIR: "from-env" }, ["--dir", "from-flag"]);
    assert.ok(existsSync(join(cwd, "from-flag", "decisions.jsonl")));
    assert.ok(!existsSync(join(cwd, "from-env")));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("--version prints the version and exits 0", () => {
  const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});
