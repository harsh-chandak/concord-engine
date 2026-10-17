import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDecision, readDecisions, detect, escalate, nextId,
} from "../dist/index.js";
import { reconcile, readConflicts, writeConflict, conflictId } from "../dist/conflicts.js";
import { packet, report } from "../dist/format.js";

const dir = () => mkdtempSync(join(tmpdir(), "concord-engine-"));
const D = (over) => ({
  id: "d-x", kind: "naming", subject: "user id", value: "user_id",
  layer: "lead", author: "backend-lead", at: "2026-10-16T00:00:00Z", ...over,
});

test("decisions round-trip through the append-only log", () => {
  const d = dir();
  try {
    appendDecision(D({ id: "d-001" }), d);
    appendDecision(D({ id: "d-002", author: "frontend-lead", value: "userId" }), d);
    const all = readDecisions(d);
    assert.equal(all.length, 2);
    assert.equal(nextId(all), "d-003");
    assert.equal(detect(all).conflicts.length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a conflict keeps its id across runs, so the attempt budget advances", () => {
  const d = dir();
  try {
    const all = [D({ id: "d-001" }), D({ id: "d-002", author: "frontend-lead", value: "userId" })];
    const f = detect(all).conflicts[0];
    const first = reconcile([f], readConflicts(d), d);
    const again = reconcile([f], readConflicts(d), d);
    assert.equal(first[0].id, again[0].id, "same subject must produce the same conflict id");
    assert.equal(readConflicts(d).length, 1, "re-detecting must not create a second conflict");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a conflict that stops being detected is marked resolved", () => {
  const d = dir();
  try {
    const all = [D({ id: "d-001" }), D({ id: "d-002", author: "frontend-lead", value: "userId" })];
    const f = detect(all).conflicts[0];
    reconcile([f], readConflicts(d), d);
    reconcile([], readConflicts(d), d);           // PM ruled; no longer detected
    assert.equal(readConflicts(d)[0].state, "resolved");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("REGRESSION: the packet shows whose turn it is now, not who it started with", () => {
  const all = [D({ id: "d-001" }), D({ id: "d-002", author: "frontend-lead", value: "userId" })];
  const f = detect(all).conflicts[0];
  assert.equal(f.owner, "pm");
  let c = { id: conflictId(f), subject: f.subject, kind: f.kind, between: ["d-001", "d-002"],
            owner: "pm", attempts: 0, state: "open", notes: [], at: "" };
  c = escalate(escalate(c));
  assert.equal(c.owner, "human");
  const text = packet(f, c);
  assert.match(text, /owner:\s*you/, "after escalation the packet must point at the human");
  assert.ok(!/owner:\s*pm/.test(text), "it must not still name the layer that gave up");
});

test("REGRESSION: report counts by outcome, so a PM that passed it on still counts", () => {
  const text = report([
    { id: "c-1", owner: "human", state: "open", notes: [], subject: "", kind: "naming", between: ["", ""], attempts: 0, at: "" },
  ]);
  assert.match(text, /reached the PM\s+1/, "a conflict at the human passed through the PM to get there");
  assert.match(text, /reached you\s+1/);
});

test("report is all zeros and says so when nothing has gone wrong", () => {
  const text = report([]);
  assert.match(text, /0 conflicts recorded/);
  assert.match(text, /reached you\s+0/);
});
