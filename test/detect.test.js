import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, escalate, normalizeSubject, normalizePath, kindSpec } from "../dist/index.js";

let n = 0;
const D = (over = {}) => ({
  id: `d-${++n}`, kind: "naming", subject: "user identifier in API payloads",
  value: "user_id", layer: "lead", author: "backend-lead", at: "2026-10-16T00:00:00Z",
  ...over,
});

test("agreeing decisions are not a conflict", () => {
  const r = detect([D(), D({ author: "frontend-lead" })]);
  assert.equal(r.conflicts.length, 0);
});

test("two leads disagreeing escalates to the PM", () => {
  const r = detect([D(), D({ author: "frontend-lead", value: "userId" })]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].owner, "pm");
  assert.equal(r.conflicts[0].decisions.length, 2);
});

test("a PM decision overrides a lead rather than conflicting with it", () => {
  const r = detect([D({ value: "userId" }), D({ layer: "pm", author: "pm", value: "user_id" })]);
  assert.equal(r.conflicts.length, 0, "the hierarchy settles it");
  assert.equal(r.overrides.length, 1);
  assert.equal(r.overrides[0].winner.layer, "pm");
});

test("two PMs disagreeing reaches the human, because nothing outranks them", () => {
  const r = detect([
    D({ layer: "pm", author: "pm-a", value: "user_id" }),
    D({ layer: "pm", author: "pm-b", value: "userId" }),
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].owner, "human");
});

test("subjects phrased differently still collide", () => {
  const r = detect([
    D({ subject: "User Identifier in API Payloads", value: "user_id" }),
    D({ subject: "user identifier in api payloads.", value: "userId", author: "frontend-lead" }),
  ]);
  assert.equal(r.conflicts.length, 1, "a near-miss subject must not hide the contradiction");
});

test("a superseded decision stops conflicting", () => {
  const old = D({ value: "userId" });
  const fix = D({ value: "user_id", supersedes: old.id, author: "frontend-lead" });
  assert.equal(detect([old, D()]).conflicts.length, 1);
  assert.equal(detect([old, D(), fix]).conflicts.length, 0);
});

test("api-contract ignores the trailing slash and param naming", () => {
  const k = kindSpec("api-contract");
  const a = k.parse({ method: "get", path: "/api/survey/:id" });
  const b = k.parse({ method: "GET", path: "/api/survey/{surveyId}/" });
  assert.equal(k.conflicts(a, b), false, "the trailing-slash outage must not read as two different routes");
});

test("api-contract conflicts on a different status", () => {
  const k = kindSpec("api-contract");
  const a = k.parse({ method: "POST", path: "/orders", status: 201 });
  const b = k.parse({ method: "POST", path: "/orders", status: 200 });
  assert.equal(k.conflicts(a, b), true);
});

test("an unspecified status does not contradict a specified one", () => {
  const k = kindSpec("api-contract");
  const a = k.parse({ method: "POST", path: "/orders", status: 201 });
  const b = k.parse({ method: "POST", path: "/orders" });
  assert.equal(k.conflicts(a, b), false);
});

test("enum comparison is order-independent and ignores duplicates", () => {
  const k = kindSpec("enum");
  const a = k.parse(["paid", "pending", "paid"]);
  const b = k.parse(["pending", "paid"]);
  assert.equal(k.conflicts(a, b), false);
  assert.equal(k.conflicts(a, k.parse(["pending", "paid", "shipped"])), true);
});

test("schema conflicts on type, and tolerates an unstated nullable", () => {
  const k = kindSpec("schema");
  assert.equal(k.conflicts(k.parse({ field: "id", type: "uuid" }), k.parse({ field: "id", type: "int" })), true);
  assert.equal(k.conflicts(k.parse({ field: "id", type: "uuid" }), k.parse({ field: "id", type: "UUID", nullable: false })), false);
});

test("an invalid value is rejected with an actionable message", () => {
  assert.throws(() => kindSpec("enum").parse([]), /non-empty array/);
  assert.throws(() => kindSpec("api-contract").parse({ method: "GET" }), /path must be/);
  assert.throws(() => kindSpec("nope"), /Unknown kind/);
});

test("escalation takes two attempts before moving up a layer", () => {
  let c = { id: "c-1", subject: "s", kind: "naming", between: ["d-1", "d-2"], owner: "lead", attempts: 0, state: "open", notes: [], at: "" };
  c = escalate(c);
  assert.equal(c.owner, "lead", "first failure stays at the same layer");
  assert.equal(c.attempts, 1);
  c = escalate(c);
  assert.equal(c.owner, "pm", "second failure moves up");
  assert.equal(c.attempts, 0);
  c = escalate(c); c = escalate(c);
  assert.equal(c.owner, "human");
  assert.equal(c.state, "escalated");
});

// The claim this project rests on is that agreement is decided by comparison
// and never by a model. A claim nothing enforces is a slogan, so these two
// tests enforce it — and they distinguish two paths that v0.2 made different.
//
// The DECISION path decides what is true: whether values conflict, what is in
// force, whether a contract is well-formed. It may not leave the process at
// all, by any means.
//
// The VERIFICATION path runs the acceptance commands the contract named. It
// exists to spawn subprocesses. It still may not call a model.
const DECISION_PATH = ["compare.ts", "detect.ts", "log.ts", "conflicts.ts", "contract.ts", "types.ts"];
const NETWORK = /\b(fetch|anthropic|openai|axios|node:https?|XMLHttpRequest|https?:\/\/api)\b/i;
// The lookbehind matters: `regex.exec(...)` is a RegExp method, not
// child_process, and matching it made this test fail on log.ts for
// parsing a decision id.
const LEAVES_PROCESS = /child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

test("nothing in the decision path can leave the process", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of DECISION_PATH) {
    const src = readFileSync(`src/${f}`, "utf8");
    assert.ok(!NETWORK.test(src), `src/${f} reaches the network — the decision path must stay deterministic`);
    assert.ok(!LEAVES_PROCESS.test(src), `src/${f} spawns a process — the decision path must stay deterministic`);
  }
});

test("no file anywhere calls a model, including the verification path", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  assert.ok(files.length >= DECISION_PATH.length, "src shrank unexpectedly — this test may be scanning nothing");
  for (const f of files) {
    const src = readFileSync(`src/${f}`, "utf8");
    assert.ok(!NETWORK.test(src), `src/${f} reaches outside the process — no model may decide anything here`);
  }
});

test("REGRESSION: the decision-path list still covers every module that decides", async () => {
  // A new module that decides something, added without being listed above,
  // would be exempt from the rule by omission — which is how a guarantee
  // quietly stops being one.
  const { readdirSync } = await import("node:fs");
  const present = readdirSync("src").filter((f) => f.endsWith(".ts"));
  const undecided = ["cli.ts", "mcp.ts", "format.ts", "index.ts", "run.ts", "ui.ts"];
  const unaccounted = present.filter((f) => !DECISION_PATH.includes(f) && !undecided.includes(f));
  assert.deepEqual(unaccounted, [],
    `new module(s) in src/: add to DECISION_PATH if they decide anything, or to the exempt list with a reason`);
});

test("path normalization collapses every param style", () => {
  const forms = ["/a/:id", "/a/{id}", "/a/<int:id>", "/a/${id}", "/a/:id/"];
  const normed = new Set(forms.map(normalizePath));
  assert.equal(normed.size, 1, [...normed].join(" != "));
});

test("subject normalization strips case, punctuation and accents", () => {
  assert.equal(normalizeSubject("  Órder  Status! "), "order status");
});
