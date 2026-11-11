/**
 * A path a contract names must belong to a unit that can act on it.
 *
 * Two holes, one matcher, found the same way — by a human reading a generated
 * brief, which is not a gate.
 *
 * 1. A criterion whose check targets a file its unit does not own. A peer's
 *    contract had `a2` running `node scripts/oneoff/verify-workday-liveness.mjs`
 *    against a unit whose `files` list did not include that path. It validated
 *    clean, and the worker would have been told to make a check pass against a
 *    file it was forbidden to create.
 *
 * 2. A path the contract declares in `scope.in` that no unit's `files` covers.
 *    Three of those validated clean in a real fleet run; the file nobody owned
 *    was never touched, and a stale spread list shipped to the UI.
 *
 * Validation confirmed a criterion named a unit and carried a command. It
 * never asked whether anyone was allowed to act on the paths involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateContract, auditOwnership, auditAcceptanceOwnership, auditScopeOwnership,
  ownershipProblem } from "../dist/contract.js";
import { pathTokens, bareFileTokens, ownsPath, ownsArea, matchesGlob } from "../dist/paths.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-ownership-"));
const only = (warnings, severity) => warnings.filter((w) => w.severity === severity);

function spec(dir, body, ...extra) {
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  const r = spawnSync(process.execPath, [CLI, "spec", "--from", file, "--dir", dir, ...extra], { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", said: (r.stdout ?? "") + (r.stderr ?? "") };
}

/* ------------------------------------------------------------------ *
 * 1. the peer's criterion                                            *
 * ------------------------------------------------------------------ */

/** The peer's contract, reduced to the one unit that matters. */
const peer = (over = {}) => ({
  id: "workday-liveness",
  goal: "Keep the Workday sync observable while it runs unattended.",
  scope: { in: ["the sync worker"], out: ["anything that calls a model"] },
  decisions: [],
  units: [
    { id: "workday-sync", goal: "write the sync worker",
      files: ["src/workday/**", "test/workday/**"], mayDecide: [], dependsOn: [] },
  ],
  acceptance: [
    { id: "a1", statement: "the sync worker has tests",
      check: "node --test test/workday/sync.test.js", unit: "workday-sync" },
    { id: "a2", statement: "the sync reports itself live",
      check: "node scripts/oneoff/verify-workday-liveness.mjs", unit: "workday-sync" },
  ],
  ...over,
});

test("THE DEFECT: a criterion checking a path its unit does not own is caught", () => {
  const c = peer();

  // The structural validator is unchanged. Ownership is inferred from a shell
  // string, and inference is deliberately not allowed to make a stored
  // contract unloadable — see auditOwnership.
  assert.equal(validateContract(c), c, "the structural validator still accepts it");

  const unowned = only(auditAcceptanceOwnership(c), "unowned");
  assert.equal(unowned.length, 1, `expected exactly a2, got ${JSON.stringify(unowned)}`);

  const [w] = unowned;
  assert.equal(w.where, "acceptance");
  assert.equal(w.criterion, "a2");
  assert.equal(w.unit, "workday-sync");
  assert.equal(w.path, "scripts/oneoff/verify-workday-liveness.mjs");
  assert.equal(w.check, "node scripts/oneoff/verify-workday-liveness.mjs");
});

test("the message names the criterion, the command, the path and the owning unit", () => {
  const [w] = only(auditAcceptanceOwnership(peer()), "unowned");
  const msg = ownershipProblem(w);

  assert.match(msg, /a2/, "names the criterion");
  assert.match(msg, /check: +node scripts\/oneoff\/verify-workday-liveness\.mjs/, "quotes the command");
  assert.match(msg, /path: +scripts\/oneoff\/verify-workday-liveness\.mjs/, "names the offending path");
  assert.match(msg, /workday-sync/, "names the owning unit");
  assert.match(msg, /src\/workday\/\*\*/, "shows what that unit does own, so the fix is obvious");
  assert.match(msg, /no unit/i, "says the path is owned by nobody, not merely by someone else");
});

test("the sibling criterion on an owned path is left alone", () => {
  assert.equal(auditAcceptanceOwnership(peer()).some((w) => w.criterion === "a1"), false,
    "a1 checks test/workday/sync.test.js, which the unit owns");
});

test("adding the path to the unit's files clears it", () => {
  assert.deepEqual(auditAcceptanceOwnership(peer({
    units: [{ id: "workday-sync", goal: "write the sync worker",
      files: ["src/workday/**", "test/workday/**", "scripts/oneoff/*.mjs"],
      mayDecide: [], dependsOn: [] }],
  })), []);
});

/* ------------------------------------------------------------------ *
 * 2. a path in scope that nobody owns                                *
 * ------------------------------------------------------------------ */

/** The peer fleet's shape: a file declared in scope, assigned to no unit. */
const scoped = (into, files = ["src/api/**"]) => ({
  id: "spread", goal: "Refresh the spread list end to end.",
  scope: { in: into, out: ["anything that calls a model"] },
  decisions: [],
  units: [{ id: "api", goal: "g", files, mayDecide: [], dependsOn: [] }],
  acceptance: [{ id: "a", statement: "s", check: "npm test", unit: "api" }],
});

test("THE SECOND DEFECT: a path in scope.in that no unit's files covers is caught", () => {
  const c = scoped(["src/api/spread.ts", "src/ui/spread-list.tsx"]);
  assert.equal(validateContract(c), c, "it validates clean, which is the hole");

  const warnings = auditScopeOwnership(c);
  assert.equal(warnings.length, 1, `expected only the UI file, got ${JSON.stringify(warnings)}`);

  const [w] = warnings;
  assert.equal(w.severity, "unowned", "an unowned path is the worse of the two severities");
  assert.equal(w.where, "scope.in");
  assert.equal(w.path, "src/ui/spread-list.tsx");
  assert.equal(w.entry, "src/ui/spread-list.tsx", "the scope entry it came from, verbatim");
});

test("the scope message says the run assigned the path to nobody", () => {
  const msg = ownershipProblem(auditScopeOwnership(scoped(["src/ui/spread-list.tsx"]))[0]);
  assert.match(msg, /scope\.in/, "names where the path was declared");
  assert.match(msg, /src\/ui\/spread-list\.tsx/, "names the path");
  assert.match(msg, /no unit/i, "says nobody owns it");
  assert.match(msg, /files/, "points at the fix");
  assert.match(msg, /scope\.out/, "and at the other fix: say it is out of scope");
});

test("three unowned paths are three findings, each named", () => {
  const warnings = auditScopeOwnership(scoped([
    "src/api/spread.ts", "src/ui/spread-list.tsx", "src/ui/filters.tsx", "db/spread.sql",
  ]));
  assert.deepEqual(warnings.map((w) => w.path).sort(),
    ["db/spread.sql", "src/ui/filters.tsx", "src/ui/spread-list.tsx"]);
});

test("FALSE POSITIVE: scope.in is prose as often as it is paths", () => {
  // The schema says `scope.in` is an array of strings and nothing more, and
  // real contracts put sentences in it. A sentence names no path.
  assert.deepEqual(auditScopeOwnership(scoped(["the sync worker", "read paths only"])), []);
  assert.deepEqual(auditScopeOwnership(scoped(["everything under the API, but not the UI"])), []);
  assert.deepEqual(auditScopeOwnership(peer()), [], "the peer's own scope is a sentence");
});

test("FALSE POSITIVE: a scope area a unit owns part of is covered", () => {
  // `scope.in: ["src/api/"]` against `files: ["src/api/**"]`. The glob does not
  // match the bare directory, but a unit owning everything inside it plainly
  // covers the area — flagging this would fire on most real contracts.
  assert.deepEqual(auditScopeOwnership(scoped(["src/api/"])), []);
  assert.deepEqual(auditScopeOwnership(scoped(["src/api"])), []);
  assert.deepEqual(auditScopeOwnership(scoped(["src"])), [], "a broader area is covered too");
  assert.deepEqual(auditScopeOwnership(scoped(["src/api/spread.ts"])), []);
});

test("FALSE POSITIVE: scope.out is not checked, it is the opposite of a claim", () => {
  assert.deepEqual(auditScopeOwnership({
    ...scoped(["src/api/spread.ts"]),
    scope: { in: ["src/api/spread.ts"], out: ["src/legacy/importer.ts", "node_modules/**"] },
  }), [], "a path the run promises not to touch must not be owned by anyone");
});

test("FALSE POSITIVE: generated trees and fixtures named in scope", () => {
  assert.deepEqual(auditScopeOwnership(scoped(["dist/cli.js", "test/fixtures/sample.json"])), []);
});

test("auditOwnership is both audits, and nothing else", () => {
  const c = peer({ scope: { in: ["src/ui/spread-list.tsx"], out: [] } });
  const all = auditOwnership(c);
  assert.deepEqual(all.map((w) => w.where).sort(), ["acceptance", "scope.in"]);
  assert.deepEqual(all, [...auditAcceptanceOwnership(c), ...auditScopeOwnership(c)]);
});

/* ------------------------------------------------------------------ *
 * the false positives a criterion must not produce                   *
 * ------------------------------------------------------------------ */

const lone = (check, files = ["src/thing.ts"]) => ({
  id: "fp", goal: "g", scope: { in: [], out: [] }, decisions: [],
  units: [{ id: "u", goal: "g", files, mayDecide: [], dependsOn: [] }],
  acceptance: [{ id: "a", statement: "s", check, unit: "u" }],
});

test("FALSE POSITIVE: `npm test` names no path at all", () => {
  assert.deepEqual(auditOwnership(lone("npm test")), []);
  assert.deepEqual(auditOwnership(lone("npm run test:unit -- --bail")), []);
  assert.deepEqual(auditOwnership(lone("npx --yes @biomejs/biome check")), [],
    "a scoped package specifier contains a slash and is not a path");
});

test("FALSE POSITIVE: `node --test test/*.test.js` is a set of files, not one file", () => {
  // The glob is the point: `npm test` in this very repo expands to exactly
  // this. A set of paths cannot be given one owner without guessing, so a
  // globbed target is skipped rather than guessed at.
  assert.deepEqual(auditOwnership(lone("node --test test/*.test.js")), []);
  assert.deepEqual(auditOwnership(lone("pytest tests/**/test_*.py")), []);
});

test("FALSE POSITIVE: a flag-only command", () => {
  assert.deepEqual(auditOwnership(lone("tsc --noEmit")), []);
  assert.deepEqual(auditOwnership(lone("eslint . --max-warnings=0")), []);
  assert.deepEqual(auditOwnership(lone("cargo test --all-features --locked")), []);
});

test("FALSE POSITIVE: binaries, interpreters and subcommands on PATH", () => {
  assert.deepEqual(auditOwnership(lone("make test")), []);
  assert.deepEqual(auditOwnership(lone("/usr/bin/env node --version")), [],
    "an absolute path is outside the repo and cannot be owned by a unit");
  assert.deepEqual(auditOwnership(lone("bash -c 'pytest -q'")), []);
});

test("FALSE POSITIVE: node_modules, build output and env assignments", () => {
  assert.deepEqual(auditOwnership(lone("node_modules/.bin/jest --ci")), []);
  assert.deepEqual(auditOwnership(lone("node dist/cli.js check")), [],
    "build output is generated, not owned");
  assert.deepEqual(auditOwnership(lone("CONFIG=cfg/ci.json npm test")), [],
    "an env assignment's value is not the command's target");
});

test("FALSE POSITIVE: shared test fixtures", () => {
  assert.deepEqual(auditOwnership(lone("node src/thing.ts test/fixtures/sample.json")), []);
  assert.deepEqual(auditOwnership(lone("pytest tests/testdata/golden.sql")), []);
  assert.deepEqual(auditOwnership(lone("node src/thing.ts __snapshots__/a.snap")), []);
});

test("FALSE POSITIVE: a target this unit does own, written every plausible way", () => {
  assert.deepEqual(auditOwnership(lone("node ./src/thing.ts")), [], "a leading ./ is the same path");
  assert.deepEqual(auditOwnership(lone("node src/thing.ts", ["src/**"])), []);
  assert.deepEqual(auditOwnership(lone("node src/thing.ts", ["src"])), [],
    "a bare directory in `files` means the unit owns what is under it");
  assert.deepEqual(auditOwnership(lone("pytest src/thing.ts::test_it", ["src/**"])), [],
    "a pytest node id is a path with a selector after it");
});

test("FALSE POSITIVE: a command whose target cannot be resolved statically", () => {
  assert.deepEqual(auditOwnership(lone("node $SCRIPT_DIR/verify.mjs")), [],
    "a variable is not a path until a shell expands it, and this is not a shell");
  assert.deepEqual(auditOwnership(lone("node $(git rev-parse --show-toplevel)/x.mjs")), []);
  assert.deepEqual(auditOwnership(lone("curl -fsS https://example.test/health")), [],
    "a URL contains slashes and is not a path");
});

/* ------------------------------------------------------------------ *
 * owned by a different unit — the weaker signal                      *
 * ------------------------------------------------------------------ */

const twoUnits = (check, dependsOn) => ({
  id: "two", goal: "g", scope: { in: [], out: [] }, decisions: [],
  units: [
    { id: "api", goal: "g", files: ["src/api/**"], mayDecide: [], dependsOn },
    { id: "db", goal: "g", files: ["db/**"], mayDecide: [], dependsOn: [] },
  ],
  acceptance: [
    { id: "a-api", statement: "s", check, unit: "api" },
    { id: "a-db", statement: "s", check: "node db/migrate.mjs", unit: "db" },
  ],
});

test("a path owned by another, unrelated unit is reported apart from an unowned one", () => {
  const warnings = auditOwnership(twoUnits("node db/migrate.mjs", []));
  assert.equal(only(warnings, "unowned").length, 0, "the path is owned — just not by `api`");

  const foreign = only(warnings, "foreign");
  assert.equal(foreign.length, 1, JSON.stringify(warnings));
  assert.equal(foreign[0].criterion, "a-api");
  assert.equal(foreign[0].unit, "api");
  assert.equal(foreign[0].owner, "db", "the message must name who does own it");

  const msg = ownershipProblem(foreign[0]);
  assert.match(msg, /a-api/);
  assert.match(msg, /db\/migrate\.mjs/);
  assert.match(msg, /"db"/, "names the unit that owns the path");
  assert.match(msg, /"api"/, "names the unit that must satisfy the criterion");
  assert.match(msg, /dependsOn/, "points at the two ways to fix it");
});

test("FALSE POSITIVE: another unit's path is fine when the two units are related", () => {
  // `tests` dependsOn `core`, and `core`'s criterion is that the test file
  // `tests` writes passes. That is the shape of this repo's own contract
  // fixture, and it is not a defect: the dependency is what coordinates the
  // two files existing. Only units with no edge between them are flagged.
  assert.deepEqual(auditOwnership(twoUnits("node db/migrate.mjs", ["db"])), [], "api dependsOn db");

  assert.deepEqual(auditOwnership({
    id: "rev", goal: "g", scope: { in: [], out: [] }, decisions: [],
    units: [
      { id: "core", goal: "g", files: ["src/contract.ts"], mayDecide: [], dependsOn: [] },
      { id: "tests", goal: "g", files: ["test/contract.test.js"], mayDecide: [], dependsOn: ["core"] },
    ],
    acceptance: [
      { id: "a-core", statement: "s", check: "node --test test/contract.test.js", unit: "core" },
      { id: "a-tests", statement: "s", check: "node --test test/contract.test.js", unit: "tests" },
    ],
  }), [], "the edge runs the other way, and still coordinates the two units");
});

test("a unit that owns nothing at all is flagged, not skipped", () => {
  const warnings = only(auditOwnership(lone("node src/thing.ts", [])), "unowned");
  assert.equal(warnings.length, 1,
    "an empty `files` list owns no path, so no criterion naming one is satisfiable");
  assert.match(ownershipProblem(warnings[0]), /owns no files/);
});

/* ------------------------------------------------------------------ *
 * the pieces, directly                                               *
 * ------------------------------------------------------------------ */

test("pathTokens extracts the plausible targets and nothing else", () => {
  assert.deepEqual(pathTokens("node scripts/verify.mjs --out build/report.json"),
    ["scripts/verify.mjs"], "build output is excluded");
  assert.deepEqual(pathTokens("npm test"), []);
  assert.deepEqual(pathTokens("bash scripts/ci.sh && node tools/check.mjs"),
    ["scripts/ci.sh", "tools/check.mjs"], "both sides of an operator are read");
  assert.deepEqual(pathTokens("node a/b.mjs | tee out/log.txt"), ["a/b.mjs"]);
  assert.deepEqual(pathTokens("node --config=cfg/ci.json src/x.ts"),
    ["cfg/ci.json", "src/x.ts"], "a --flag=path carries a real target");
  assert.deepEqual(pathTokens("node ../outside/x.mjs"), [],
    "a path climbing out of the tree cannot be matched against a unit glob");
  assert.deepEqual(pathTokens("node a/b.mjs; node a/b.mjs"), ["a/b.mjs"], "deduped");
});

test("matchesGlob implements the glob semantics `files` is documented with", () => {
  assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/d/a.ts", "src/*.ts"), false, "* stops at a separator");
  assert.equal(matchesGlob("src/d/a.ts", "src/**/*.ts"), true);
  assert.equal(matchesGlob("src/a.ts", "src/**/*.ts"), true, "** also matches zero directories");
  assert.equal(matchesGlob("src/d/e/a.ts", "src/**"), true);
  assert.equal(matchesGlob("srcx/a.ts", "src/**"), false);
  assert.equal(matchesGlob("src/a.ts", "src"), true, "a bare directory covers its contents");
  assert.equal(matchesGlob("src/a.ts", "src/"), true);
  assert.equal(matchesGlob("src/a.ts", "src/a.ts"), true);
  assert.equal(matchesGlob("src/ab.ts", "src/a?.ts"), true);
  assert.equal(matchesGlob("src/a.ts", "src/a.ts.bak"), false);
  assert.equal(matchesGlob("src/a+b.ts", "src/a+b.ts"), true, "regex metacharacters stay literal");
});

test("ownsPath is true when any one of the unit's globs covers the path", () => {
  assert.equal(ownsPath("test/workday/sync.test.js", ["src/workday/**", "test/workday/**"]), true);
  assert.equal(ownsPath("scripts/x.mjs", ["src/workday/**", "test/workday/**"]), false);
  assert.equal(ownsPath("scripts/x.mjs", []), false);
});

test("ownsArea also covers a directory a unit owns the inside of", () => {
  assert.equal(ownsArea("src/api", ["src/api/**"]), true, "ownsPath alone says false here");
  assert.equal(ownsPath("src/api", ["src/api/**"]), false, "which is why scope needs its own rule");
  assert.equal(ownsArea("src", ["src/api/**"]), true);
  assert.equal(ownsArea("src/ui", ["src/api/**"]), false);
  assert.equal(ownsArea("src/api/spread.ts", ["src/api/**"]), true);
});

/* ------------------------------------------------------------------ *
 * the CLI gate                                                        *
 * ------------------------------------------------------------------ */

test("`spec` stores the contract but exits non-zero on an unowned criterion target", () => {
  const d = box();
  try {
    const r = spec(d, peer());
    assert.equal(r.status, 1, `expected a non-zero exit\n${r.said}`);
    assert.match(r.said, /a2/);
    assert.match(r.said, /scripts\/oneoff\/verify-workday-liveness\.mjs/);
    assert.match(r.said, /workday-sync/);
    // Stored anyway: the inference is a heuristic, and a heuristic must not be
    // able to make a contract unreadable by `brief` or `docs`.
    const briefed = spawnSync(process.execPath,
      [CLI, "brief", "--contract", "workday-liveness", "--dir", d, "workday-sync"], { encoding: "utf8" });
    assert.equal(briefed.status, 0, "the contract is still stored and briefable");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("`spec` exits non-zero on a scope path nobody owns", () => {
  const d = box();
  try {
    const r = spec(d, scoped(["src/api/spread.ts", "src/ui/spread-list.tsx"]));
    assert.equal(r.status, 1, `expected a non-zero exit\n${r.said}`);
    assert.match(r.said, /src\/ui\/spread-list\.tsx/);
    assert.doesNotMatch(r.said, /src\/api\/spread\.ts\n/, "the owned path is not mentioned");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("`spec` exits zero, and says nothing about ownership, on a clean contract", () => {
  const d = box();
  try {
    const r = spec(d, peer({
      acceptance: [{ id: "a1", statement: "s", check: "node --test test/workday/sync.test.js", unit: "workday-sync" }],
    }));
    assert.equal(r.status, 0, r.said);
    assert.doesNotMatch(r.said, /UNSATISFIABLE|owns no files|no unit/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a path owned by an unrelated unit does not by itself fail `spec`", () => {
  const d = box();
  try {
    const r = spec(d, twoUnits("node db/migrate.mjs", []));
    assert.equal(r.status, 0, "`foreign` is a note, not a gate — it is too easily legitimate");
    assert.match(r.said, /a-api/, "but it is still said out loud");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--json carries the findings so a host agent need not parse prose", () => {
  const d = box();
  try {
    const r = spec(d, peer({ scope: { in: ["src/ui/spread-list.tsx"], out: [] } }), "--json");
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.contract.id, "workday-liveness");
    assert.deepEqual(parsed.pathOwnership.map((w) => w.path).sort(),
      ["scripts/oneoff/verify-workday-liveness.mjs", "src/ui/spread-list.tsx"]);
    assert.equal(parsed.pathOwnership.every((w) => w.severity === "unowned"), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * bare filenames — half the gap, closed only where it is safe        *
 * ------------------------------------------------------------------ */

/** Two units each owning nothing but a root file: this repo's own shape. */
const rootFiles = (check, unit, dependsOn = []) => ({
  id: "root", goal: "g", scope: { in: [], out: [] }, decisions: [],
  units: [
    { id: "skill", goal: "g", files: ["SKILL.md"], mayDecide: [], dependsOn },
    { id: "readme", goal: "g", files: ["README.md"], mayDecide: [], dependsOn: [] },
  ],
  acceptance: [
    { id: "a", statement: "s", check, unit },
    { id: "a-other", statement: "s", check: "test -f README.md", unit: "readme" },
  ],
});

test("a bare filename another unit owns is reported, as the weaker severity", () => {
  const warnings = auditOwnership(rootFiles("grep -q 'brief' README.md", "skill"));
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0].severity, "foreign", "never `unowned` — see bareFileTokens");
  assert.equal(warnings[0].path, "README.md");
  assert.equal(warnings[0].unit, "skill");
  assert.equal(warnings[0].owner, "readme");
});

test("a bare filename its own unit owns is left alone", () => {
  assert.deepEqual(auditOwnership(rootFiles("test -f SKILL.md && grep -q 'spec' SKILL.md", "skill")), []);
});

test("FALSE POSITIVE: a bare filename no unit owns is never an ownership hole", () => {
  // The whole reason bare names are handled apart. At the repo root an
  // unowned bare name is far more likely to be a config a command reads than
  // a deliverable nobody was assigned, and failing a correct contract is the
  // worse error.
  for (const check of [
    "python manage.py test", "node server.js", "tsc -p tsconfig.json",
    "pytest -c pytest.ini", "node --test runner.mjs", "make -f Makefile.ci all",
  ]) {
    assert.deepEqual(auditOwnership(rootFiles(check, "skill")), [], check);
  }
});

test("FALSE POSITIVE: a bare filename a RELATED unit owns is left alone", () => {
  assert.deepEqual(auditOwnership(rootFiles("grep -q 'brief' README.md", "skill", ["readme"])), [],
    "the dependency coordinates the two, exactly as for a path with a directory");
});

test("bareFileTokens reads names, not flags, operators or paths", () => {
  assert.deepEqual(bareFileTokens("test -f SKILL.md && grep -q 'x' SKILL.md"), ["SKILL.md"]);
  assert.deepEqual(bareFileTokens("node scripts/x.mjs"), [], "that one has a directory; pathTokens takes it");
  assert.deepEqual(bareFileTokens("npm run build"), [], "a subcommand has no extension");
  assert.deepEqual(bareFileTokens("tsc --noEmit"), []);
  assert.deepEqual(bareFileTokens("node --test"), []);
  assert.deepEqual(bareFileTokens("eslint . --max-warnings=0"), [], "a lone dot is not a filename");
  assert.deepEqual(bareFileTokens("pytest -q test_thing.py"), ["test_thing.py"]);
});

/* ------------------------------------------------------------------ *
 * the audit is pure, and it does not over-refuse                     *
 * ------------------------------------------------------------------ */

// write_contract runs validation where there may be no repo on disk at all,
// so nothing on this path may consult the filesystem. That is what lets the
// same audit run on the CLI and the MCP side instead of only one of them, and
// it is a property worth a test rather than a comment: resolving a glob
// against real files would be the obvious way to "improve" ownsPath, and it
// would silently make write_contract wrong.
test("nothing in the ownership audit touches the filesystem", async () => {
  const { readFileSync } = await import("node:fs");
  const FS = /\b(readFileSync|writeFileSync|existsSync|statSync|readdirSync|node:fs|node:path)\b/;
  assert.ok(!FS.test(readFileSync("src/paths.ts", "utf8")),
    "src/paths.ts must match strings, not look at the disk");

  const src = readFileSync("src/contract.ts", "utf8");
  const audit = src.slice(src.indexOf("export function auditAcceptanceOwnership"),
                          src.indexOf("/** Depth-first cycle detection"));
  assert.ok(audit.length > 500, "the audit functions were not found — this test is scanning nothing");
  assert.ok(!FS.test(audit), "the audit functions must not consult the filesystem");
});

test("the audit is the same from a directory with nothing in it", () => {
  // The paths in this contract exist nowhere. Whether a worker MAY write a
  // file is a question about the contract, not about the disk, and the answer
  // must not change with the working directory.
  const cwd = process.cwd();
  const d = box();
  try {
    process.chdir(d);
    const w = auditOwnership(peer({ scope: { in: ["src/ui/spread-list.tsx"], out: [] } }));
    assert.deepEqual(w.map((x) => x.path).sort(),
      ["scripts/oneoff/verify-workday-liveness.mjs", "src/ui/spread-list.tsx"]);
  } finally { process.chdir(cwd); rmSync(d, { recursive: true, force: true }); }
});

// A stricter rule's real failure mode is over-refusal, so the regression worth
// guarding is not "does it catch the bad contract" but "does it stay quiet on
// the good ones". These two are the only real contracts in the repo: the
// published example, and the contract this package was built under. Between
// them they cover 9 criteria and 9 units, including the two shapes most likely
// to trip a path audit — a glob target (`node --test test/*.test.js`) and a
// bare root filename (`grep -q 'spec --schema' SKILL.md`).
test("REGRESSION: the real contracts in this repo produce no findings at all", () => {
  for (const f of ["examples/linkfold.contract.json", ".concord-engine/contracts/concord-engine-v2.json"]) {
    const c = validateContract(JSON.parse(readFileSync(f, "utf8")));
    assert.ok(c.acceptance.length > 0, `${f} has no criteria — this test would prove nothing`);
    assert.deepEqual(auditOwnership(c), [],
      `${f} is a contract that works; the audit must not accuse it of anything`);
  }
});
