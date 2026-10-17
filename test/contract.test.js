import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateContract, briefFor, waves, saveContract, loadContract, listContracts,
  contractsDir, contractPath, SCHEMA, ContractError, declaredSubjects } from "../dist/contract.js";
import { KIND_IDS } from "../dist/index.js";

const box = () => mkdtempSync(join(tmpdir(), "concord-engine-contract-"));

/** A contract with nothing wrong with it. Every rejection test breaks one thing. */
const ok = (over = {}) => ({
  id: "demo-run",
  goal: "Ship the loop commands behind one contract.",
  scope: { in: ["src/contract.ts", "src/run.ts"], out: ["anything that calls a model"] },
  decisions: [
    { kind: "naming", subject: "cli flag for selecting a contract", value: "--contract",
      rationale: "every loop command takes it, so it has to be the same word everywhere" },
  ],
  units: [
    { id: "core", goal: "ARMADILLO write the validator", files: ["src/contract.ts"], mayDecide: ["naming"], dependsOn: [] },
    { id: "tests", goal: "write the unit tests", files: ["test/contract.test.js"], mayDecide: [], dependsOn: ["core"] },
  ],
  acceptance: [
    { id: "a-core", statement: "the validator rejects a malformed contract", check: "node --test test/contract.test.js", unit: "core" },
    { id: "a-tests", statement: "every unit test passes", check: "node --test test/*.test.js", unit: "tests" },
  ],
  ...over,
});

/** Runs the validator and hands back the problem list, failing if it accepted. */
const problems = (raw) => {
  try {
    validateContract(raw);
  } catch (err) {
    assert.ok(err instanceof ContractError, `expected a ContractError, got ${err}`);
    return err.problems;
  }
  return assert.fail("validateContract accepted a contract it should have rejected");
};

const matches = (list, re, why) => assert.ok(list.some((p) => re.test(p)), `${why}\n  got: ${JSON.stringify(list, null, 2)}`);

/* ------------------------------------------------------------------ *
 * validateContract — what it accepts                                  *
 * ------------------------------------------------------------------ */

test("a well-formed contract validates and comes back unchanged", () => {
  const raw = ok();
  const c = validateContract(raw);
  assert.equal(c, raw, "validation returns the same object, it does not rebuild one");
  assert.equal(c.units.length, 2);
});

test("two decisions that agree on one subject are not a contradiction", () => {
  // The casing fold must not fire on agreement, or every contract that states
  // the same decision twice would be rejected for saying it consistently.
  validateContract(ok({
    decisions: [
      { kind: "naming", subject: "cli flag for selecting a contract", value: "--contract" },
      { kind: "naming", subject: "CLI Flag For Selecting A Contract", value: "--contract" },
    ],
  }));
});

test("an unspecified status does not contradict a specified one", () => {
  validateContract(ok({
    decisions: [
      { kind: "api-contract", subject: "brief endpoint", value: { method: "get", path: "/brief/{id}" } },
      { kind: "api-contract", subject: "brief endpoint", value: { method: "GET", path: "/brief/:id", status: 200 } },
    ],
  }));
});

/* ------------------------------------------------------------------ *
 * validateContract — the rejections that matter                       *
 * ------------------------------------------------------------------ */

// A unit told to wait for a unit nobody is building waits forever, and the
// host fanning out never schedules it — a run that hangs instead of failing.
test("REJECT: a unit depending on a unit that does not exist", () => {
  const p = problems(ok({
    units: [
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: ["ghost"] },
      { id: "tests", goal: "g", files: [], mayDecide: [], dependsOn: ["core"] },
    ],
  }));
  matches(p, /unit "core" depends on "ghost", which is not a unit/, "the missing dependency must be named");
});

// Self-dependency is the one-node cycle, and it reads as a typo rather than a
// cycle, so it gets its own message.
test("REJECT: a unit that depends on itself", () => {
  const p = problems(ok({
    units: [
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: ["core"] },
      { id: "tests", goal: "g", files: [], mayDecide: [], dependsOn: [] },
    ],
  }));
  matches(p, /unit "core" depends on itself/, "a self-edge must be reported as such");
});

// waves() loops forever on a cycle unless the validator has already refused it,
// so this rejection is what makes the scheduler's "cannot happen" true.
test("REJECT: a dependency cycle, with the cycle named in the message", () => {
  const p = problems(ok({
    units: [
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: ["tests"] },
      { id: "tests", goal: "g", files: [], mayDecide: [], dependsOn: ["core"] },
    ],
  }));
  matches(p, /dependency cycle: .*core.*->.*/, "the message must show the cycle, not just report one");
});

// A criterion with no command cannot be run, so the run can only be declared
// finished by assertion — the thing this package exists to refuse.
test("REJECT: an acceptance criterion with an empty check", () => {
  const p = problems(ok({
    acceptance: [
      { id: "a-core", statement: "it works", check: "   ", unit: "core" },
      { id: "a-tests", statement: "tests pass", check: "node --test test/*.test.js", unit: "tests" },
    ],
  }));
  matches(p, /acceptance\[a-core\] has no check/, "a blank command is no command");
});

// A criterion pinned to a unit that does not exist proves nothing about the
// run, and silently leaves a real unit uncovered.
test("REJECT: an acceptance criterion naming an unknown unit", () => {
  const p = problems(ok({
    acceptance: [
      { id: "a-core", statement: "it works", check: "true", unit: "core" },
      { id: "a-ghost", statement: "ghost works", check: "true", unit: "ghost" },
    ],
  }));
  matches(p, /acceptance\[a-ghost\]\.unit must name a unit/, "the dangling criterion must be reported");
  matches(p, /unit "tests" has no acceptance criterion/, "and the unit it left uncovered too");
});

// A unit with no criterion is work nobody can mark done; the fleet finishes
// with a hole in it and the gate reports green.
test("REJECT: a unit with no acceptance criterion", () => {
  const p = problems(ok({
    acceptance: [{ id: "a-core", statement: "it works", check: "true", unit: "core" }],
  }));
  matches(p, /unit "tests" has no acceptance criterion/, "every unit needs something that proves it");
});

// Two contradicting decisions inside one contract is the drift this tool
// catches, arriving before a single worker has started.
test("REJECT: two decisions inside one contract that contradict each other", () => {
  const p = problems(ok({
    decisions: [
      { kind: "naming", subject: "cli flag for selecting a contract", value: "--contract" },
      { kind: "naming", subject: "cli flag for selecting a contract", value: "--spec" },
    ],
  }));
  matches(p, /decisions contradict each other on "cli flag for selecting a contract": --contract vs --spec/,
    "both values must appear, so the reader can pick one");
});

// Two leads write the same subject differently. If the fold is not applied the
// contradiction is stored twice and never detected — the exact silent failure.
test("REJECT: contradicting decisions written with different casing of one subject", () => {
  const p = problems(ok({
    decisions: [
      { kind: "naming", subject: "user identifier in API payloads", value: "user_id" },
      { kind: "naming", subject: "User Identifier in API Payloads!", value: "userId" },
    ],
  }));
  matches(p, /decisions contradict each other on "User Identifier in API Payloads!": user_id vs userId/,
    "casing and punctuation must not hide a contradiction");
});

test("REJECT: a contradiction on a structured kind, not just on strings", () => {
  const p = problems(ok({
    decisions: [
      { kind: "enum", subject: "run states", value: ["open", "done"] },
      { kind: "enum", subject: "run states", value: ["open", "closed"] },
    ],
  }));
  matches(p, /decisions contradict each other on "run states": \[done, open\] vs \[closed, open\]/,
    "enum values are compared canonically and rendered as lists");
});

// A kind outside the fixed set has no comparison rule, so a decision carrying
// one could never be checked for contradiction — it would be stored and
// silently trusted.
test("REJECT: an invalid decision kind", () => {
  const p = problems(ok({
    decisions: [{ kind: "vibes", subject: "how we feel about it", value: "good" }],
  }));
  matches(p, new RegExp(`decisions\\[0\\]\\.kind must be one of ${KIND_IDS.join(", ")}`),
    "the message must list the kinds that are allowed");
});

test("REJECT: a decision whose value does not fit its kind", () => {
  const p = problems(ok({
    decisions: [{ kind: "enum", subject: "run states", value: "open" }],
  }));
  matches(p, /decisions\[0\] \(run states\): enum value must be a non-empty array/, "the kind spec's own message is kept");
});

test("REJECT: duplicate unit ids and duplicate acceptance ids", () => {
  const p = problems(ok({
    units: [
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: [] },
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: [] },
    ],
    acceptance: [
      { id: "a-core", statement: "s", check: "true", unit: "core" },
      { id: "a-core", statement: "s", check: "true", unit: "core" },
    ],
  }));
  matches(p, /two units share the id "core"/, "duplicate unit ids must be caught");
  matches(p, /two acceptance criteria share the id "a-core"/, "duplicate criterion ids must be caught");
});

test("REJECT: a missing goal, a bad id, and a scope that does not say what is out", () => {
  const p = problems({ id: "Not Kebab", goal: "  ", scope: { in: ["x"] }, decisions: [], units: [], acceptance: [] });
  matches(p, /id must be kebab-case/, "ids are kebab-case");
  matches(p, /goal must be a non-empty sentence/, "a blank goal is no goal");
  matches(p, /scope\.out must be an array of strings/, "the out-of-scope list is required");
  matches(p, /units must be a non-empty array/, "a contract with no units has no workers");
  matches(p, /acceptance must be a non-empty array/, "a run with no criteria cannot be finished");
});

test("REJECT: something that is not a JSON object at all", () => {
  for (const raw of [null, [], "a contract", 7]) {
    assert.deepEqual(problems(raw), ["contract must be a JSON object"], `${JSON.stringify(raw)} is not a contract`);
  }
});

// An agent fixing one error per round trip is the expensive way to learn the
// shape was wrong, so the validator must report everything it found at once.
test("every problem is collected in one pass, not just the first", () => {
  const p = problems({
    id: "many-faults",
    goal: "a contract with six separate things wrong with it",
    scope: { in: [], out: [] },
    decisions: [
      { kind: "naming", subject: "cli flag", value: "--contract" },
      { kind: "naming", subject: "CLI Flag", value: "--spec" },
      { kind: "vibes", subject: "how we feel", value: "good" },
    ],
    units: [
      { id: "a", goal: "a", files: [], mayDecide: [], dependsOn: ["ghost"] },
      { id: "b", goal: "b", files: [], mayDecide: [], dependsOn: [] },
    ],
    acceptance: [
      { id: "a-1", statement: "s", check: "   ", unit: "a" },
      { id: "a-2", statement: "s", check: "true", unit: "nobody" },
    ],
  });

  matches(p, /decisions\[2\]\.kind must be one of/, "the invalid kind");
  matches(p, /decisions contradict each other on "CLI Flag"/, "the contradiction");
  matches(p, /unit "a" depends on "ghost"/, "the missing dependency");
  matches(p, /acceptance\[a-1\] has no check/, "the empty check");
  matches(p, /acceptance\[a-2\]\.unit must name a unit/, "the unknown unit");
  matches(p, /unit "b" has no acceptance criterion/, "the uncovered unit");
  assert.equal(p.length, 6, `exactly those six, nothing swallowed: ${JSON.stringify(p, null, 2)}`);
});

test("ContractError carries the problems and prints all of them", () => {
  const err = new ContractError(["first thing", "second thing"]);
  assert.equal(err.name, "ContractError");
  assert.deepEqual(err.problems, ["first thing", "second thing"]);
  assert.match(err.message, /contract is not valid:/);
  assert.match(err.message, /- first thing/);
  assert.match(err.message, /- second thing/, "the message must not stop at the first problem");
});

/* ------------------------------------------------------------------ *
 * SCHEMA                                                              *
 * ------------------------------------------------------------------ */

test("SCHEMA is the shape the validator actually enforces", () => {
  assert.deepEqual([...SCHEMA.required], ["id", "goal", "scope", "decisions", "units", "acceptance"]);
  assert.equal(SCHEMA.additionalProperties, false);
  // Published so the host agent has something exact to target: if the kind
  // list here drifts from the comparison table, agents are told to emit kinds
  // the validator will reject.
  assert.deepEqual([...SCHEMA.properties.decisions.items.properties.kind.enum], [...KIND_IDS]);
  assert.deepEqual([...SCHEMA.properties.units.items.properties.mayDecide.items.enum], [...KIND_IDS]);
  assert.equal(SCHEMA.properties.units.minItems, 1);
  assert.equal(SCHEMA.properties.acceptance.minItems, 1);
  assert.ok(JSON.parse(JSON.stringify(SCHEMA)), "SCHEMA must be plain JSON, it is published to agents");
});

/* ------------------------------------------------------------------ *
 * waves                                                               *
 * ------------------------------------------------------------------ */

test("waves orders a real dependency chain, widest wave first", () => {
  const c = validateContract(ok({
    units: [
      { id: "tests", goal: "g", files: [], mayDecide: [], dependsOn: ["api", "schema"] },
      { id: "api", goal: "g", files: [], mayDecide: [], dependsOn: ["core"] },
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: [] },
      { id: "docs", goal: "g", files: [], mayDecide: [], dependsOn: [] },
      { id: "schema", goal: "g", files: [], mayDecide: [], dependsOn: ["core"] },
    ],
    acceptance: ["tests", "api", "core", "docs", "schema"].map((u) => ({
      id: `a-${u}`, statement: `${u} is done`, check: "true", unit: u,
    })),
  }));

  assert.deepEqual(waves(c), [["core", "docs"], ["api", "schema"], ["tests"]]);
});

test("waves puts every unit in exactly one wave, after everything it depends on", () => {
  const c = validateContract(ok());
  const w = waves(c);
  assert.deepEqual(w.flat().sort(), ["core", "tests"]);
  assert.ok(w.findIndex((x) => x.includes("core")) < w.findIndex((x) => x.includes("tests")),
    "a unit may not start in the same wave as the unit it waits for");
});

test("waves is a single wave when nothing depends on anything", () => {
  const c = validateContract(ok({
    units: [
      { id: "core", goal: "g", files: [], mayDecide: [], dependsOn: [] },
      { id: "tests", goal: "g", files: [], mayDecide: [], dependsOn: [] },
    ],
  }));
  assert.deepEqual(waves(c), [["core", "tests"]]);
});

/* ------------------------------------------------------------------ *
 * briefFor                                                            *
 * ------------------------------------------------------------------ */

const D = (over) => ({
  id: "d-001", kind: "naming", subject: "cli command that runs acceptance checks",
  value: "accept", layer: "pm", author: "pm", at: "2026-10-16T00:00:00Z", ...over,
});

test("briefFor states the binding decisions, with their rationale", () => {
  const b = briefFor(validateContract(ok()), "core");
  assert.equal(b.contract, "demo-run");
  assert.equal(b.unit, "core");
  assert.equal(b.binding.length, 1);
  assert.equal(b.binding[0].subject, "cli flag for selecting a contract");
  assert.match(b.instructions, /\[naming\] cli flag for selecting a contract = --contract/);
  assert.match(b.instructions, /\(every loop command takes it/, "the rationale travels with the decision");
  assert.match(b.instructions, /DECISIONS ALREADY IN FORCE — these are not suggestions/);
});

test("briefFor lists exactly the kinds the unit may not settle alone", () => {
  const c = validateContract(ok());
  const core = briefFor(c, "core");
  assert.deepEqual(core.mayDecide, ["naming"]);
  assert.deepEqual(core.mustRequest, KIND_IDS.filter((k) => k !== "naming"));
  assert.ok(!core.mustRequest.includes("naming"), "a kind cannot be both allowed and forbidden");
  assert.match(core.instructions, new RegExp(`WHAT YOU MUST NOT DECIDE ALONE\\n  ${core.mustRequest.join(", ")}`));

  const tests = briefFor(c, "tests");
  assert.deepEqual(tests.mustRequest, [...KIND_IDS], "a unit that may decide nothing must request every kind");
  assert.match(tests.instructions, /nothing — you write code and decide nothing/);
});

test("briefFor carries only this unit's files, criteria and dependencies", () => {
  const b = briefFor(validateContract(ok()), "tests");
  assert.deepEqual(b.files, ["test/contract.test.js"]);
  assert.deepEqual(b.acceptance.map((a) => a.id), ["a-tests"]);
  assert.deepEqual(b.dependsOn, ["core"]);
  assert.match(b.instructions, /WAIT FOR\n  core/);
  assert.match(b.instructions, /\[a-tests\] every unit test passes\n       \$ node --test test\/\*\.test\.js/);
  // A worker that can read another unit's goal reasons about work it was not
  // given, which is how a fleet talks itself into a contradiction.
  assert.ok(!b.instructions.includes("ARMADILLO"), "another unit's goal must not reach this worker");
  assert.ok(!b.instructions.includes("a-core"), "another unit's criterion must not reach this worker");
});

test("briefFor lets a logged decision override the contract's own", () => {
  // The log wins because the log is what the gate compares against; a brief
  // quoting the superseded contract value would send the worker at a value
  // the gate will refuse.
  const c = validateContract(ok());
  const b = briefFor(c, "core", [D({ subject: "CLI flag for selecting a contract!", value: "--contract-id" })]);
  assert.equal(b.binding.length, 1, "the same subject in different casing must replace, not duplicate");
  assert.equal(b.binding[0].value, "--contract-id");
  assert.ok(!b.instructions.includes("= --contract\n"), "the stale contract value must be gone");
});

test("briefFor adds a logged decision on a new subject", () => {
  const b = briefFor(validateContract(ok()), "core", [D()]);
  assert.equal(b.binding.length, 2);
  assert.match(b.instructions, /\[naming\] cli command that runs acceptance checks = accept/);
});

test("briefFor throws for a unit that is not in the contract", () => {
  assert.throws(() => briefFor(validateContract(ok()), "ghost"),
    /no unit "ghost" in contract "demo-run"/);
});

test("a brief with no decisions and no owned files says so rather than going blank", () => {
  const c = validateContract(ok({
    decisions: [],
    units: [{ id: "core", goal: "g", files: [], mayDecide: [], dependsOn: [] }],
    acceptance: [{ id: "a-core", statement: "s", check: "true", unit: "core" }],
  }));
  const b = briefFor(c, "core");
  assert.deepEqual(b.binding, []);
  assert.match(b.instructions, /\(none yet\)/);
  assert.match(b.instructions, /\(not yet decided\)/);
});

/* ------------------------------------------------------------------ *
 * storage                                                             *
 * ------------------------------------------------------------------ */

test("a contract round-trips through save and load", () => {
  const d = box();
  try {
    const c = validateContract(ok());
    const path = saveContract(c, d);
    assert.equal(path, contractPath("demo-run", d));
    assert.equal(path, join(d, "contracts", "demo-run.json"));
    assert.deepEqual(loadContract("demo-run", d), c);
    assert.ok(readFileSync(path, "utf8").endsWith("\n"), "the file ends with a newline");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("listContracts names what is stored, sorted, and nothing when the directory is missing", () => {
  const d = box();
  try {
    assert.deepEqual(listContracts(d), [], "a missing directory is empty, not an error");
    saveContract(validateContract(ok({ id: "zebra-run" })), d);
    saveContract(validateContract(ok({ id: "alpha-run" })), d);
    writeFileSync(join(contractsDir(d), "notes.txt"), "not a contract", "utf8");
    assert.deepEqual(listContracts(d), ["alpha-run", "zebra-run"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadContract says which contract is missing and where it looked", () => {
  const d = box();
  try {
    assert.throws(() => loadContract("ghost", d), (err) => {
      assert.match(err.message, /no contract "ghost" in /);
      assert.ok(err.message.includes(contractsDir(d)), "the message names the directory searched");
      return true;
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A contract edited on disk after it was saved is the realistic way an invalid
// one enters the system, so loading has to validate rather than trust.
test("loadContract validates what it reads, it does not trust the file", () => {
  const d = box();
  try {
    mkdirSync(contractsDir(d), { recursive: true });
    const broken = ok({ id: "hand-edited" });
    broken.acceptance = [{ id: "a-core", statement: "s", check: "", unit: "core" }];
    writeFileSync(contractPath("hand-edited", d), JSON.stringify(broken), "utf8");
    assert.throws(() => loadContract("hand-edited", d), ContractError);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("saving twice overwrites in place rather than accumulating files", () => {
  const d = box();
  try {
    saveContract(validateContract(ok()), d);
    saveContract(validateContract(ok({ goal: "a second, later goal for the same run." })), d);
    assert.deepEqual(listContracts(d), ["demo-run"]);
    assert.equal(loadContract("demo-run", d).goal, "a second, later goal for the same run.");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------------- *
 * declared subjects                                                  *
 *                                                                    *
 * The gate matches subjects by wording. On the first run of this loop
 * against a second project, two workers named one thing "error response
 * body shape" and "api error response body", chose incompatible values,
 * and `check` reported no contradiction because it never compared them.
 * Declaring subjects turns identity into a lookup.
 * ---------------------------------------------------------------- */

const withOpen = (openSubjects) => ({
  id: "os", goal: "g", scope: { in: [], out: [] }, decisions: [],
  openSubjects,
  units: [{ id: "u", goal: "g", files: [], mayDecide: ["convention"], dependsOn: [] }],
  acceptance: [{ id: "a", statement: "s", check: "true", unit: "u" }],
});

test("openSubjects is optional", () => {
  const c = { ...withOpen(undefined) };
  delete c.openSubjects;
  assert.ok(validateContract(c));
});

test("REGRESSION: a subject cannot be both decided and open", () => {
  const c = withOpen([{ kind: "naming", subject: "User ID!" }]);
  c.decisions = [{ kind: "naming", subject: "user id", value: "user_id" }];
  assert.throws(() => validateContract(c), (e) => {
    assert.match(e.message, /listed as open but the contract already decides it/);
    return true;
  }, "folding must catch it across casing and punctuation, as the gate does");
});

test("openSubjects rejects a duplicate and an unknown kind", () => {
  assert.throws(() => validateContract(withOpen([
    { kind: "convention", subject: "error shape" },
    { kind: "convention", subject: "Error  Shape!" },
  ])), /lists "Error  Shape!" twice/);
  assert.throws(() => validateContract(withOpen([{ kind: "nonsense", subject: "x" }])), /kind must be one of/);
});

test("declaredSubjects covers decided and open, keyed as the gate keys them", () => {
  const c = withOpen([{ kind: "convention", subject: "Error Response Body Shape" }]);
  c.decisions = [{ kind: "naming", subject: "user id", value: "user_id" }];
  const d = declaredSubjects(validateContract(c));
  assert.equal(d.get("naming::user id")?.state, "decided");
  assert.equal(d.get("convention::error response body shape")?.state, "open");
  assert.equal(d.size, 2);
});

test("a brief names the open subjects verbatim, and drops ones already settled", () => {
  const c = validateContract(withOpen([
    { kind: "convention", subject: "error response body shape", note: "both sides serialise it" },
    { kind: "convention", subject: "retry policy" },
  ]));
  const open = briefFor(c, "u", []);
  assert.match(open.instructions, /STILL TO BE DECIDED/);
  assert.match(open.instructions, /error response body shape/);
  assert.match(open.instructions, /both sides serialise it/);
  assert.match(open.instructions, /retry policy/);

  // Settled since the contract was written: telling a worker to decide it
  // again is how a second spelling of the subject gets created.
  const settled = briefFor(c, "u", [{
    id: "d-1", kind: "convention", subject: "Error Response Body Shape",
    value: "json", layer: "lead", author: "web", supersedes: null, at: "",
  }]);
  assert.ok(!/error response body shape/i.test(settled.instructions.split("RECORD A DECISION")[0].split("STILL TO BE DECIDED")[1] ?? ""),
    "a settled subject must not still be listed as open");
  assert.match(settled.instructions, /retry policy/, "the genuinely open one stays");
});
