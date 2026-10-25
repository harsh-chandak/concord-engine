import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLogLock, decisionsPath } from "../dist/index.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-concurrency-"));
const WRITERS = 16;
// A race does not show on every run: against the unlocked code, one round of
// eight writers recorded exactly one decision about two runs in three. So the
// regression repeats on fresh logs, and a single round with two decisions fails it.
const ROUNDS = 5;

// Started together and awaited together, so the processes really overlap.
function decideAll(dir) {
  return Promise.all(Array.from({ length: WRITERS }, (_, i) => new Promise((done) => {
    const p = spawn(process.execPath, [CLI, "decide", "--dir", dir,
      "--kind", "naming", "--subject", "user identifier",
      "--value", `user_id_${i}`, "--as", `worker${i}`]);
    p.on("close", (code) => done(code));
  })));
}

const logOf = (dir) =>
  readFileSync(decisionsPath(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// REGRESSION: every writer read the log, checked it, then appended, with nothing
// holding the three steps together. Eight concurrent decides on one subject
// recorded four contradicting decisions, all four as d-001: the gate let them
// through, and nextId() handed each the same id, so --supersedes could not even
// name which one it meant.
test("REGRESSION: concurrent contradicting decides record exactly one", async () => {
  for (let round = 1; round <= ROUNDS; round++) {
    const d = box();
    try {
      const codes = await decideAll(d);
      const log = logOf(d);
      assert.equal(log.length, 1, `round ${round}: expected one decision in force, the log holds ${log.length} (${log.map((x) => x.id).join(", ")})`);
      assert.equal(codes.filter((c) => c === 0).length, 1, `round ${round}: exactly one writer should succeed`);
      assert.equal(codes.filter((c) => c === 1).length, WRITERS - 1, `round ${round}: every other writer should be refused`);
      assert.equal(existsSync(`${decisionsPath(d)}.lock`), false, `round ${round}: the lock should be released`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("concurrent writes on different subjects all land, with distinct ids", async () => {
  const d = box();
  try {
    const codes = await Promise.all(Array.from({ length: WRITERS }, (_, i) => new Promise((done) => {
      const p = spawn(process.execPath, [CLI, "decide", "--dir", d,
        "--kind", "naming", "--subject", `field ${i}`, "--value", `f${i}`, "--as", `worker${i}`]);
      p.on("close", (code) => done(code));
    })));
    assert.deepEqual(codes, Array(WRITERS).fill(0));
    const ids = logOf(d).map((x) => x.id);
    assert.equal(ids.length, WRITERS);
    assert.equal(new Set(ids).size, WRITERS, `ids must be unique, got ${ids.join(", ")}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a lock left behind is reported, not silently reclaimed", () => {
  const d = box();
  try {
    withLogLock(d, () => {});                       // creates the directory
    writeFileSync(`${decisionsPath(d)}.lock`, "12345\n");
    assert.throws(() => withLogLock(d, () => {}, 50), /held by another writer/);
    assert.equal(existsSync(`${decisionsPath(d)}.lock`), true, "a lock it did not take must not be deleted");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the lock is released when the guarded work throws", () => {
  const d = box();
  try {
    assert.throws(() => withLogLock(d, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(`${decisionsPath(d)}.lock`), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
