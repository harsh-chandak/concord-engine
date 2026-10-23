import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-supersede-"));

function cli(dir, sub, ...args) {
  const r = spawnSync(process.execPath, [CLI, sub, "--dir", dir, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const decide = (dir, value, ...extra) =>
  cli(dir, "decide", "--kind", "naming", "--subject", "status field",
    "--value", value, "--as", "pm", "--layer", "pm", ...extra);

const logOf = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

// REGRESSION: the gate guarded on `if (clash && !values.force)` and never read
// `values.supersedes`, although it stored the flag on the record and named it
// in the refusal text as THE way to override deliberately. So the documented
// override path could not satisfy the gate, and the only way past was
// --force — which records a disagreement, not an override, leaving a
// permanent false conflict that `check` reports forever. The MCP server did
// not share the bug: record_decision builds the candidate with its supersedes
// and runs detect(), which filters through activeDecisions(). So the two
// interfaces disagreed about the gate — the exact asymmetry the comment above
// this gate was written about.
test("REGRESSION: --supersedes records a deliberate override instead of refusing", () => {
  const d = box();
  try {
    assert.equal(decide(d, "state").status, 0, "the first decision should record");

    const plain = decide(d, "status");
    assert.equal(plain.status, 1, "a clash with no override must still be refused");

    const override = decide(d, "status", "--supersedes", "d-001",
      "--rationale", "state was wrong: the public API already ships status");
    assert.equal(override.status, 0, `--supersedes must satisfy the gate; stderr: ${override.err}`);

    const log = logOf(d);
    assert.equal(log.length, 2, "exactly the first decision and its replacement");
    assert.equal(log[1].supersedes, "d-001", "the override must name what it replaced");

    const check = cli(d, "check");
    assert.equal(check.status, 0, "an override leaves no open conflict");
    assert.match(check.out, /no contradictions/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// REGRESSION: --supersedes was never checked against the log, so an id that
// did not exist was accepted in silence. That is how a typo became a decision
// nobody could find the ancestor of.
test("REGRESSION: superseding an id that does not exist is refused", () => {
  const d = box();
  try {
    assert.equal(decide(d, "state").status, 0);
    const bogus = decide(d, "status", "--supersedes", "d-999");
    assert.equal(bogus.status, 1, "an unknown id must be refused, not accepted silently");
    assert.match(bogus.err, /d-999/, "the refusal should name the id it could not find");
    assert.equal(logOf(d).length, 1, "nothing may be appended when the id is unknown");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// REGRESSION: a decision could name the id it was about to be given, so it
// superseded itself. activeDecisions() then filtered it straight back out:
// the CLI printed "recorded", exited 0, and left a decision that was not in
// force and never would be.
test("REGRESSION: a decision cannot supersede itself into nonexistence", () => {
  const d = box();
  try {
    assert.equal(decide(d, "state").status, 0, "d-001 recorded");
    // d-002 is the id this very call would be given.
    const itself = decide(d, "status", "--supersedes", "d-002");
    assert.equal(itself.status, 1, "a decision may not supersede itself");

    const binding = cli(d, "check");
    assert.match(binding.out, /1 active decision/, "the original must still be in force");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--force still records a disagreement rather than an override", () => {
  const d = box();
  try {
    assert.equal(decide(d, "state").status, 0);
    assert.equal(decide(d, "status", "--force").status, 0, "--force must still record");

    const log = logOf(d);
    assert.equal(log[1].supersedes, null, "--force is not an override and names nothing");

    const check = cli(d, "check");
    assert.equal(check.status, 1, "a forced disagreement stays open for check to surface");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
