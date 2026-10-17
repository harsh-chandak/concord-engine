import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcceptance, generateDocs, costReport } from "../dist/run.js";
import { validateContract, briefFor } from "../dist/contract.js";

const box = () => mkdtempSync(join(tmpdir(), "concord-engine-run-"));

/** A contract whose acceptance commands the test replaces per case. */
const contract = (acceptance, over = {}) => validateContract({
  id: "demo-run",
  goal: "Ship the loop commands behind one contract.",
  scope: { in: ["src/run.ts"], out: ["anything that calls a model"] },
  decisions: [
    { kind: "naming", subject: "cli flag for selecting a contract", value: "--contract",
      rationale: "every loop command takes it, so it has to be the same word everywhere" },
  ],
  units: [{ id: "core", goal: "write the runner", files: ["src/run.ts"], mayDecide: [], dependsOn: [] }],
  acceptance,
  ...over,
});

const D = (over) => ({
  id: "d-001", kind: "naming", subject: "cli command that runs acceptance checks",
  value: "accept", layer: "pm", author: "pm", at: "2026-10-16T00:00:00Z", ...over,
});

/* ------------------------------------------------------------------ *
 * runAcceptance                                                       *
 * ------------------------------------------------------------------ */

test("a check that exits 0 is reported as passed, with its criterion intact", () => {
  const d = box();
  try {
    writeFileSync(join(d, "pass.js"), `console.log("green");\n`, "utf8");
    const c = contract([{ id: "a-core", statement: "the runner runs", check: "node pass.js", unit: "core" }]);
    const [r] = runAcceptance(c, d);
    assert.equal(r.passed, true);
    assert.equal(r.code, 0);
    assert.equal(r.id, "a-core");
    assert.equal(r.statement, "the runner runs");
    assert.equal(r.check, "node pass.js");
    assert.equal(r.unit, "core", "the result has to say which unit failed to prove itself");
    assert.equal(r.output, "green");
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0, "every result is timed");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A failing check that reports no exit code and no output is indistinguishable
// from a check that did not run, which is how a red run gets waved through.
test("a failing check reports its non-zero code and captures both streams", () => {
  const d = box();
  try {
    writeFileSync(join(d, "fail.js"), [
      `console.log("stdout-needle");`,
      `console.error("stderr-needle: assertion failed");`,
      `process.exit(3);`,
    ].join("\n"), "utf8");
    const c = contract([{ id: "a-core", statement: "the runner runs", check: "node fail.js", unit: "core" }]);
    const [r] = runAcceptance(c, d);
    assert.equal(r.passed, false);
    assert.equal(r.code, 3, "the real exit code, not a boolean dressed up as one");
    assert.match(r.output, /stdout-needle/);
    assert.match(r.output, /stderr-needle: assertion failed/, "why it failed is usually on stderr");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a check whose command does not exist fails rather than throwing", () => {
  const d = box();
  try {
    const c = contract([{ id: "a-core", statement: "s", check: "definitely-not-a-command-xyz", unit: "core" }]);
    const [r] = runAcceptance(c, d);
    assert.equal(r.passed, false);
    assert.notEqual(r.code, 0);
    assert.ok(r.output.length > 0, "the shell's complaint is the useful part");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("checks run in the directory they were given, not the test's cwd", () => {
  const d = box();
  try {
    writeFileSync(join(d, "marker.txt"), "ran-in-the-box", "utf8");
    writeFileSync(join(d, "where.js"), `console.log(require("fs").readFileSync("marker.txt","utf8"));\n`, "utf8");
    writeFileSync(join(d, "package.json"), `{"type":"commonjs"}\n`, "utf8");
    const c = contract([{ id: "a-core", statement: "s", check: "node where.js", unit: "core" }]);
    const [r] = runAcceptance(c, d);
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /ran-in-the-box/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a check is told which criterion it is proving", () => {
  const d = box();
  try {
    writeFileSync(join(d, "env.js"), `console.log(process.env.CONCORD_ENGINE_ACCEPTANCE);\n`, "utf8");
    const c = contract([{ id: "a-core", statement: "s", check: "node env.js", unit: "core" }]);
    assert.equal(runAcceptance(c, d)[0].output, "a-core");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A failing command says why at the end, so a head-truncated log is a log that
// threw away the reason.
test("long output is truncated from the front, keeping the tail", () => {
  const d = box();
  try {
    writeFileSync(join(d, "loud.js"), [
      `console.log("x".repeat(5000));`,
      `console.log("THE-REASON-IT-FAILED");`,
    ].join("\n"), "utf8");
    const c = contract([{ id: "a-core", statement: "s", check: "node loud.js", unit: "core" }]);
    const [r] = runAcceptance(c, d);
    assert.equal(r.output.length, 2002, "a 2000-character tail plus the elision marker");
    assert.ok(r.output.startsWith("…\n"), "the truncation must be visible, not silent");
    assert.match(r.output, /THE-REASON-IT-FAILED$/, "the end of the output is the part worth keeping");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Running only until the first failure hides how much else is broken, and
// running in dependency order hides checks that only pass after another ran.
test("every criterion runs, in contract order, even after one fails", () => {
  const d = box();
  try {
    writeFileSync(join(d, "fail.js"), `process.exit(1);\n`, "utf8");
    const c = contract([
      { id: "a-one", statement: "one", check: "node fail.js", unit: "core" },
      { id: "a-two", statement: "two", check: "node -e \"process.exit(0)\"", unit: "core" },
      { id: "a-three", statement: "three", check: "node fail.js", unit: "core" },
    ]);
    const rs = runAcceptance(c, d);
    assert.deepEqual(rs.map((r) => r.id), ["a-one", "a-two", "a-three"]);
    assert.deepEqual(rs.map((r) => r.passed), [false, true, false]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * generateDocs                                                        *
 * ------------------------------------------------------------------ */

test("the docs are generated from the log, down to the attribution", () => {
  const c = contract([{ id: "a-core", statement: "the runner runs", check: "node --test test/run.test.js", unit: "core" }]);
  const md = generateDocs(c, [
    D({ id: "d-001", rationale: "verify already means route verification in v0.1" }),
    D({ id: "d-002", kind: "enum", subject: "conflict states", value: ["open", "resolved", "escalated"], author: "backend-lead", layer: "lead" }),
  ]);

  assert.match(md, /^# demo-run\n/);
  assert.match(md, /Ship the loop commands behind one contract\./);
  assert.match(md, /\*\*In\.\*\* src\/run\.ts/);
  assert.match(md, /\*\*Out\.\*\* anything that calls a model/);
  assert.match(md, /### enum\n/);
  assert.match(md, /### naming\n/);
  assert.ok(md.indexOf("### enum") < md.indexOf("### naming"), "kinds are grouped in a stable order");
  // Rendered through the kind's own spec, so the docs cannot show a value in a
  // form the comparison would not recognise.
  assert.match(md, /- \*\*conflict states\*\* — `\[escalated, open, resolved\]`/);
  assert.match(md, /- \*\*cli command that runs acceptance checks\*\* — `accept`/);
  assert.match(md, /verify already means route verification in v0\.1/);
  assert.match(md, /<sub>d-002 · backend-lead \(lead\) · 2026-10-16T00:00:00Z<\/sub>/);
  // The claim the whole document rests on.
  assert.match(md, /\| the runner runs \| `core` \| `node --test test\/run\.test\.js` \|/);
  assert.match(md, /Do not edit by hand/);
});

test("a decision with no rationale is marked as having none, not left blank", () => {
  const md = generateDocs(contract([{ id: "a-core", statement: "s", check: "true", unit: "core" }]), [D()]);
  assert.match(md, /_no rationale recorded_/, "a missing reason has to be visible, since that is the gap");
});

test("an empty log produces docs that say so rather than an empty section", () => {
  const md = generateDocs(contract([{ id: "a-core", statement: "s", check: "true", unit: "core" }]), []);
  assert.match(md, /_No decisions recorded\._/);
  assert.ok(!md.includes("## Decisions that were replaced"), "nothing was replaced, so there is no such section");
});

// A reversal that vanishes from the docs takes the reason with it, and the
// next fleet re-litigates the same choice.
test("a superseded decision is shown as replaced, and the replacement is in force", () => {
  const md = generateDocs(contract([{ id: "a-core", statement: "s", check: "true", unit: "core" }]), [
    D({ id: "d-001", value: "verify" }),
    D({ id: "d-002", value: "accept", supersedes: "d-001", rationale: "verify already means route verification" }),
  ]);
  assert.match(md, /## Decisions that were replaced/);
  assert.match(md, /~~\*\*cli command that runs acceptance checks\*\* — `verify`~~ <sub>\(d-001, pm\)<\/sub>/);
  const inForce = md.slice(md.indexOf("## Decisions in force"), md.indexOf("## Decisions that were replaced"));
  assert.match(inForce, /— `accept`/);
  assert.ok(!inForce.includes("`verify`"), "the superseded value must not still read as binding");
});

test("the acceptance table lists every criterion, which is how the run was proved", () => {
  const c = contract([
    { id: "a-one", statement: "the validator rejects a bad contract", check: "node --test test/contract.test.js", unit: "core" },
    { id: "a-two", statement: "the runner reports a failing command", check: "node --test test/run.test.js", unit: "core" },
  ]);
  const md = generateDocs(c, []);
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && l.includes("`core`"));
  assert.equal(rows.length, 2);
  assert.match(md, /\| criterion \| unit \| command \|/);
});

/* ------------------------------------------------------------------ *
 * costReport                                                          *
 * ------------------------------------------------------------------ */

const fanOut = () => validateContract({
  id: "fan-out",
  goal: "Four units, so the cost report has something to divide.",
  scope: { in: ["src"], out: ["docs"] },
  decisions: [{ kind: "naming", subject: "cli flag for selecting a contract", value: "--contract" }],
  units: ["core", "api", "tests", "docs"].map((id) => ({
    id, goal: `build ${id}`, files: [`src/${id}.ts`], mayDecide: [], dependsOn: [],
  })),
  acceptance: ["core", "api", "tests", "docs"].map((id) => ({
    id: `a-${id}`, statement: `${id} is done`, check: "true", unit: id,
  })),
});

test("the cost report measures one line per unit against the whole contract", () => {
  const c = fanOut();
  const r = costReport(c);
  assert.equal(r.contract, "fan-out");
  assert.deepEqual(r.lines.map((l) => l.unit), ["core", "api", "tests", "docs"]);
  // The baseline is the realistic alternative: handing each worker the whole
  // contract. A smaller baseline would flatter the ratio.
  const whole = JSON.stringify(c).length;
  for (const l of r.lines) {
    assert.equal(l.baselineBytes, whole);
    assert.equal(l.briefBytes, briefFor(c, l.unit).instructions.length, "the line measures the brief actually sent");
  }
});

test("the ratio is the division it claims to be", () => {
  const r = costReport(fanOut());
  assert.equal(r.briefTotal, r.lines.reduce((n, l) => n + l.briefBytes, 0));
  assert.equal(r.baselineTotal, r.lines.reduce((n, l) => n + l.baselineBytes, 0));
  assert.equal(r.ratio, r.briefTotal / r.baselineTotal);
  assert.ok(r.ratio > 0 && Number.isFinite(r.ratio));
});

// The package measures bytes. Calling them tokens would be exactly the kind of
// unsourced number this project exists to refuse, so every token figure is an
// estimate and the assumption behind it ships with it.
test("every token figure is an estimate and states its chars-per-token assumption", () => {
  const r = costReport(fanOut());
  assert.equal(r.charsPerToken, 4, "the assumption has a stated default");
  assert.equal(r.estimatedBriefTokens, Math.round(r.briefTotal / 4));
  assert.equal(r.estimatedBaselineTokens, Math.round(r.baselineTotal / 4));
  // The byte counts are measured; only the token counts are named "estimated".
  for (const key of ["briefTotal", "baselineTotal", "ratio", "charsPerToken", "estimatedBriefTokens", "estimatedBaselineTokens"]) {
    assert.ok(key in r, `the report must carry ${key}`);
  }
  for (const key of Object.keys(r)) {
    if (/token/i.test(key) && key !== "charsPerToken") {
      assert.ok(key.startsWith("estimated"), `${key} is derived from an assumption and must say so in its name`);
    }
  }
});

test("a different chars-per-token moves the estimates and nothing that was measured", () => {
  const c = fanOut();
  const four = costReport(c, [], 4);
  const three = costReport(c, [], 3);
  assert.equal(three.charsPerToken, 3);
  assert.equal(three.briefTotal, four.briefTotal, "bytes are measured and do not depend on the assumption");
  assert.equal(three.ratio, four.ratio, "the ratio is bytes over bytes, so the assumption cancels");
  assert.equal(three.estimatedBriefTokens, Math.round(four.briefTotal / 3));
  assert.ok(three.estimatedBriefTokens > four.estimatedBriefTokens);
});

test("decisions gained since the contract are counted in what the briefs cost", () => {
  const c = fanOut();
  const before = costReport(c);
  const after = costReport(c, [D({ subject: "mcp tool name prefix for loop tools", value: "no prefix" })]);
  assert.ok(after.briefTotal > before.briefTotal, "a brief that quotes one more decision is bigger");
  assert.equal(after.baselineTotal, before.baselineTotal, "the contract on disk did not change");
  assert.ok(after.ratio > before.ratio);
});

test("a contract with no units reports zero rather than dividing by zero", () => {
  // Not reachable through validateContract, which requires a unit — this is
  // the guard that keeps a NaN out of a report people quote.
  const r = costReport({ id: "empty", goal: "g", scope: { in: [], out: [] }, decisions: [], units: [], acceptance: [] });
  assert.deepEqual(r.lines, []);
  assert.equal(r.briefTotal, 0);
  assert.equal(r.baselineTotal, 0);
  assert.equal(r.ratio, 1);
  assert.ok(!Number.isNaN(r.ratio));
});

// REGRESSION: generateDocs keyed active decisions on `d.subject.toLowerCase()`
// while subjectKey, validateContract and briefFor all key on
// normalizeSubject(), which additionally strips punctuation and collapses
// whitespace. Two decisions the detector treats as ONE conflict therefore
// rendered as two separate entries, both listed under "Decisions in force",
// beneath a line promising each was enforced on every worker. The generated
// design doc asserted two contradictory values were simultaneously binding —
// which is the exact failure this package exists to catch, printed in its own
// output. Found independently by two workers during the v0.2 run.
test("REGRESSION: docs fold subjects the same way the detector does", () => {
  const contract = {
    id: "docs-key", goal: "g", scope: { in: [], out: [] }, decisions: [],
    units: [{ id: "u", goal: "g", files: [], mayDecide: [], dependsOn: [] }],
    acceptance: [{ id: "a", statement: "s", check: "true", unit: "u" }],
  };
  const at = "2026-10-16T00:00:00.000Z";
  const md = generateDocs(contract, [
    { id: "d-1", kind: "naming", subject: "user identifier in API payloads", value: "user_id", layer: "lead", author: "a", supersedes: null, at },
    { id: "d-2", kind: "naming", subject: "User Identifier in API Payloads!", value: "userId", layer: "lead", author: "b", supersedes: null, at },
  ]);
  const inForce = md.split("## Decisions in force")[1].split("\n## ")[0];
  const entries = inForce.split("\n").filter((l) => l.startsWith("- **"));
  assert.equal(entries.length, 1,
    `two spellings of one subject must collapse to one entry, got:\n${entries.join("\n")}`);
  assert.match(entries[0], /userId/, "the later decision is the one in force");
});

test("REGRESSION: a superseded decision survives a later one on the same subject", () => {
  // The replaced decision was looked up in the active map, so if a third
  // decision had already displaced it, it vanished from the record instead of
  // appearing under "Decisions that were replaced".
  const contract = {
    id: "sup", goal: "g", scope: { in: [], out: [] }, decisions: [],
    units: [{ id: "u", goal: "g", files: [], mayDecide: [], dependsOn: [] }],
    acceptance: [{ id: "a", statement: "s", check: "true", unit: "u" }],
  };
  const at = "2026-10-16T00:00:00.000Z";
  const md = generateDocs(contract, [
    { id: "d-1", kind: "naming", subject: "status field", value: "state", layer: "pm", author: "a", supersedes: null, at },
    { id: "d-2", kind: "naming", subject: "status field", value: "status", layer: "pm", author: "a", supersedes: "d-1", at },
  ]);
  assert.match(md, /Decisions that were replaced/);
  assert.match(md, /d-1/, "the replaced decision must still be named");
});
