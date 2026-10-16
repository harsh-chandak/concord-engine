import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRoutes, sourceFiles, verifyRoutes, kindSpec } from "../dist/index.js";

function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), "ag-code-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(d, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return d;
}
const decision = (value, over = {}) => ({
  id: "d-1", kind: "api-contract", subject: "s", value: kindSpec("api-contract").parse(value),
  layer: "lead", author: "backend-lead", at: "", ...over,
});

test("extracts Express and FastAPI routes", () => {
  const d = fixture({
    "server.js": `app.get('/api/a/:id', h)\nrouter.post("/api/b", h)`,
    "main.py": `@app.get("/api/c/{id}")\ndef c(): ...\n@router.delete('/api/d')\ndef dd(): ...`,
  });
  try {
    const r = extractRoutes(sourceFiles(d));
    const got = r.map((x) => `${x.method} ${x.path}`).sort();
    assert.deepEqual(got, ["DELETE /api/d", "GET /api/a/:p", "GET /api/c/:p", "POST /api/b"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("REGRESSION: a Python decorator is not counted twice", () => {
  const d = fixture({ "main.py": `@app.get("/api/c")\ndef c(): ...` });
  try {
    const r = extractRoutes(sourceFiles(d));
    assert.equal(r.length, 1, "@app.get matches both the JS and Python patterns");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a decision matches despite a trailing slash and different param naming", () => {
  const d = fixture({ "s.js": `app.get('/api/survey/:id', h)` });
  try {
    const served = extractRoutes(sourceFiles(d));
    const v = verifyRoutes([decision({ method: "GET", path: "/api/survey/{surveyId}/" })], served);
    assert.equal(v.length, 0, "the trailing-slash outage must not read as unserved");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("flags a decided route the code does not serve, and names the nearest method", () => {
  const d = fixture({ "s.js": `app.post('/api/orders', h)` });
  try {
    const served = extractRoutes(sourceFiles(d));
    const v = verifyRoutes([decision({ method: "DELETE", path: "/api/orders" })], served);
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, "method not served");
    assert.equal(v[0].nearest.method, "POST");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a path that appears nowhere is reported as not served", () => {
  const d = fixture({ "s.js": `app.get('/api/a', h)` });
  try {
    const v = verifyRoutes([decision({ method: "GET", path: "/api/zzz" })], extractRoutes(sourceFiles(d)));
    assert.equal(v[0].reason, "route not served");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("superseded decisions are not verified", () => {
  const d = fixture({ "s.js": `app.get('/api/new', h)` });
  try {
    const old = decision({ method: "GET", path: "/api/old" }, { id: "d-1" });
    const fix = decision({ method: "GET", path: "/api/new" }, { id: "d-2", supersedes: "d-1" });
    assert.equal(verifyRoutes([old, fix], extractRoutes(sourceFiles(d))).length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("non api-contract decisions are ignored by the route detector", () => {
  const v = verifyRoutes([{ id: "d-1", kind: "naming", subject: "s", value: "user_id", layer: "lead", author: "a", at: "" }], []);
  assert.equal(v.length, 0);
});

test("vendored and build directories are skipped", () => {
  const d = fixture({ "node_modules/x/s.js": `app.get('/vendored', h)`, "dist/s.js": `app.get('/built', h)`, "s.js": `app.get('/mine', h)` });
  try {
    const paths = extractRoutes(sourceFiles(d)).map((r) => r.path);
    assert.deepEqual(paths, ["/mine"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
