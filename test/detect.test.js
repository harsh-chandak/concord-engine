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

test("no model call exists anywhere in the decision path", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  for (const f of files) {
    const src = readFileSync(`src/${f}`, "utf8");
    assert.ok(!/\b(fetch|anthropic|openai|https?:\/\/api)\b/i.test(src),
      `${f} reaches outside the process — the decision path must stay deterministic`);
  }
});

test("path normalization collapses every param style", () => {
  const forms = ["/a/:id", "/a/{id}", "/a/<int:id>", "/a/${id}", "/a/:id/"];
  const normed = new Set(forms.map(normalizePath));
  assert.equal(normed.size, 1, [...normed].join(" != "));
});

test("subject normalization strips case, punctuation and accents", () => {
  assert.equal(normalizeSubject("  Órder  Status! "), "order status");
});
