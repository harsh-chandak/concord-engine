import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractRoutes, sourceFiles, verifyRoutes, verifyReport, kindSpec } from "../dist/index.js";

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

// REGRESSION: verifyRoutes compared extractRoutes' output, which collapses
// every parameter to :p, against the decision's path as authored. No source
// spelling could satisfy a decision containing a parameter, so every
// parameterised route was reported "route not served" — the detector was
// unusable for exactly the routes most likely to drift. Found by a worker on
// the linkfold run when a served GET /api/links/:code came back NOT SERVED.
test("REGRESSION: a parameterised route verifies against its authored spelling", () => {
  const decision = {
    id: "d-1", kind: "api-contract", subject: "link resolution",
    value: { method: "GET", path: "/api/links/:code", status: 200 },
    layer: "lead", author: "api", supersedes: null, at: "",
  };
  const served = [{ method: "GET", path: "/api/links/:p", file: "src/api.js", line: 1 }];
  assert.deepEqual(verifyRoutes([decision], served), [],
    "the same route spelled two ways must verify");
});

test("REGRESSION: a genuinely missing parameterised route is still caught", () => {
  // The fix must not make verify blind: normalising both sides cannot be
  // allowed to make everything match everything.
  const decision = {
    id: "d-1", kind: "api-contract", subject: "link resolution",
    value: { method: "GET", path: "/api/links/:code", status: 200 },
    layer: "lead", author: "api", supersedes: null, at: "",
  };
  const served = [{ method: "GET", path: "/api/users/:p", file: "src/api.js", line: 1 }];
  const out = verifyRoutes([decision], served);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "route not served");
});

// ---------------------------------------------------------------------------
// REGRESSION: the receiver allowlist, and vacuous verification
//
// extractRoutes matched only receivers literally named app/router/server/api.
// A peer session ran `verify` against a real Express app whose routers are
// named per version — `const v1Route = express.Router()` — extracted ZERO
// routes from 143 files, and `verify` printed "every api-contract decision is
// served" and exited 0. Every api-contract decision went unchecked and the run
// was reported as green. Two separate defects: the pattern was too narrow, and
// checking nothing was indistinguishable from checking everything.
// ---------------------------------------------------------------------------

test("REGRESSION: a router bound to a non-allowlisted name still yields its routes", () => {
  const d = fixture({
    "routes/v1.js": [
      `const express = require("express");`,
      `const v1Route = express.Router();`,
      `v1Route.post('/api/v1/orders', h);`,
      `v1Route.get("/api/v1/orders/:id", h);`,
      `module.exports = v1Route;`,
    ].join("\n"),
  });
  try {
    const got = extractRoutes(sourceFiles(d)).map((x) => `${x.method} ${x.path}`).sort();
    assert.deepEqual(got, ["GET /api/v1/orders/:p", "POST /api/v1/orders"],
      "a router is a router whatever the variable is called");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a bare Router() call, imported by destructuring, is tracked too", () => {
  const d = fixture({
    "r.ts": `import { Router } from "express";\nconst adminRoutes = Router();\nadminRoutes.delete("/admin/sessions", h);`,
  });
  try {
    const got = extractRoutes(sourceFiles(d)).map((x) => `${x.method} ${x.path}`);
    assert.deepEqual(got, ["DELETE /admin/sessions"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an express() application bound to any name is tracked", () => {
  const d = fixture({ "boot.js": `const svc = express();\nsvc.get("/healthz", h);` });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)).map((x) => x.path), ["/healthz"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a FastAPI APIRouter bound to any name is tracked", () => {
  const d = fixture({
    "v2.py": `v2 = APIRouter()\n@v2.patch("/api/v2/users/{uid}")\ndef u(): ...`,
  });
  try {
    const got = extractRoutes(sourceFiles(d)).map((x) => `${x.method} ${x.path}`);
    assert.deepEqual(got, ["PATCH /api/v2/users/:p"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The docblock on extractRoutes promises misses, never false accusations. A
// widened receiver pattern is only safe if it cannot manufacture a route the
// codebase does not serve: a phantom route lets `verify` claim a path exists,
// and report "the path exists as GET at <file>:<line>" about a line that
// serves nothing.
test("NEVER-FALSE: a widened receiver does not turn library calls into routes", () => {
  const d = fixture({
    "u.js": `const _ = require("lodash");\n_.get("key");\n_.get(obj, "a.b");`,
    "c.js": `cache.get("/api/orders");\nstore.get("/x");\nsession.get("/y");`,
    "h.js": `const axios = require("axios");\naxios.get("/api/users");\naxios.post("/api/users", body);`,
    "t.js": `const request = require("supertest");\nrequest(app).get("/api/orders").expect(200);`,
    "m.js": `const m = new Map();\nm.get("/api/orders");`,
  });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)), [],
      "nothing here serves a route; inventing one is a false accusation");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("NEVER-FALSE: a router mounted under its own prefix is not tracked at the wrong path", () => {
  // APIRouter(prefix="/v1") serves /v1/items, not /items. Extracting /items
  // would be a route the app does not serve, which is worse than a miss.
  const d = fixture({
    "p.py": `v1 = APIRouter(prefix="/v1")\n@v1.get("/items")\ndef i(): ...`,
    "k.js": `const k = new Router({ prefix: "/v1" });\nk.get("/items", h);`,
  });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)), [],
      "a prefixed router must be missed, not guessed");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("tracking is per file: a name bound in one file does not legitimise another", () => {
  const d = fixture({
    "a.js": `const items = express.Router();\nitems.get("/api/items", h);`,
    "b.js": `items.get("/not-a-route", h);`,
  });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)).map((x) => x.path), ["/api/items"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("verifyReport marks a run vacuous when there are decisions but no routes", () => {
  const decisions = [decision({ method: "GET", path: "/api/a" })];
  const empty = verifyReport(decisions, [], 143);
  assert.equal(empty.vacuous, true, "0 routes from 143 files proved nothing");
  assert.equal(empty.routesFound, 0);
  assert.equal(empty.apiContractDecisions, 1);

  const served = [{ method: "GET", path: "/api/a", file: "s.js", line: 1 }];
  assert.equal(verifyReport(decisions, served, 1).vacuous, false);
  assert.equal(verifyReport([], [], 143).vacuous, false, "nothing to check is not a vacuous check");
});

// --- `verify` at the CLI: vacuous success is a failure ----------------------

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const decideApi = (dir, method, path) =>
  cli("decide", "--dir", dir, "--kind", "api-contract", "--subject", `${method} ${path}`,
    "--value", JSON.stringify({ method, path }), "--as", "api-lead", "--layer", "lead");

test("REGRESSION: verify exits non-zero and says so when it extracted no routes", () => {
  const code = fixture({
    // 143 files in spirit: real source, no recognisable registration at all.
    "src/server.js": `const srv = http.createServer((req, res) => { route(req.url, res); });`,
    "src/util.js": `export const pick = (o, k) => o[k];`,
  });
  const log = mkdtempSync(join(tmpdir(), "concord-engine-vacuous-"));
  try {
    assert.equal(decideApi(log, "POST", "/api/v1/orders").status, 0, "the decision should record");
    const r = cli("verify", code, "--dir", log);
    assert.notEqual(r.status, 0,
      "checking nothing must not be reported as success — this is the whole defect");
    assert.match(r.out, /0 (?:served )?routes|no routes/i, "it must say that zero routes were extracted");
    assert.doesNotMatch(r.out, /every api-contract decision is served/,
      "it must not claim the decisions were verified");

    const j = cli("verify", code, "--dir", log, "--json");
    assert.notEqual(j.status, 0);
    const parsed = JSON.parse(j.out);
    assert.equal(parsed.vacuous, true);
    assert.equal(parsed.routesFound, 0);
    assert.equal(parsed.apiContractDecisions, 1);
  } finally {
    rmSync(code, { recursive: true, force: true });
    rmSync(log, { recursive: true, force: true });
  }
});

test("verify still exits 0 when there are no api-contract decisions to check", () => {
  const code = fixture({ "src/util.js": `export const pick = (o, k) => o[k];` });
  const log = mkdtempSync(join(tmpdir(), "concord-engine-vacuous-"));
  try {
    assert.equal(cli("decide", "--dir", log, "--kind", "naming", "--subject", "user id",
      "--value", "user_id", "--as", "lead").status, 0);
    const r = cli("verify", code, "--dir", log);
    assert.equal(r.status, 0, "no api-contract decisions means there is nothing to prove");
  } finally {
    rmSync(code, { recursive: true, force: true });
    rmSync(log, { recursive: true, force: true });
  }
});

test("verify reports how many routes it extracted, not only how many files it read", () => {
  const code = fixture({ "s.js": `const v1Route = express.Router();\nv1Route.get("/api/a", h);` });
  const log = mkdtempSync(join(tmpdir(), "concord-engine-vacuous-"));
  try {
    assert.equal(decideApi(log, "GET", "/api/a").status, 0);
    const r = cli("verify", code, "--dir", log);
    assert.equal(r.status, 0, "the route is served, so verify passes");
    assert.match(r.out, /1 file/);
    assert.match(r.out, /1 .*route/);
  } finally {
    rmSync(code, { recursive: true, force: true });
    rmSync(log, { recursive: true, force: true });
  }
});

// A router's path is relative to a mount point extraction cannot see, so it is
// matched as a suffix. That relaxation can only ever suppress a violation,
// never invent one — but a suppressed violation is still something verify did
// not really prove, so the count of them is reported rather than swallowed.
test("NEVER-FALSE: a router mounted under a prefix is not accused of not serving it", () => {
  const d = fixture({
    "routes/v1.js": `const v1Route = express.Router();\nv1Route.post("/orders", h);\nmodule.exports = v1Route;`,
    "app.js": `const app = express();\napp.use("/api/v1", require("./routes/v1"));`,
  });
  try {
    const served = extractRoutes(sourceFiles(d));
    const r = verifyReport([decision({ method: "POST", path: "/api/v1/orders" })], served, 2);
    assert.deepEqual(r.violations, [], "the app does serve it; saying otherwise is the false accusation");
    assert.equal(r.mountInferred, 1, "a suffix match is reported, not silently counted as proof");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a suffix match is segment-aligned, so a different route is still caught", () => {
  const d = fixture({ "r.js": `const v1Route = express.Router();\nv1Route.get("/orders", h);` });
  try {
    const served = extractRoutes(sourceFiles(d));
    const out = verifyRoutes([decision({ method: "GET", path: "/api/myorders" })], served);
    assert.equal(out.length, 1, "/api/myorders must not be satisfied by a router's /orders");
    assert.equal(out[0].reason, "route not served");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an application's paths are absolute, so no suffix match is allowed for them", () => {
  const d = fixture({ "a.js": `const app = express();\napp.get("/orders", h);` });
  try {
    const out = verifyRoutes([decision({ method: "GET", path: "/api/v1/orders" })], extractRoutes(sourceFiles(d)));
    assert.equal(out.length, 1, "express() serves /orders at /orders and nowhere else");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a wrong method on a mounted router is still caught, and named as mount-relative", () => {
  const d = fixture({ "r.js": `const v1Route = express.Router();\nv1Route.post("/orders", h);` });
  try {
    const out = verifyRoutes([decision({ method: "DELETE", path: "/api/v1/orders" })], extractRoutes(sourceFiles(d)));
    assert.equal(out.length, 1);
    assert.equal(out[0].reason, "method not served");
    assert.equal(out[0].nearest.mountUnknown, true, "the report must not claim the path is absolute");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Express's own settings getter: app.get("port") reads a setting, it does not
// register a route. The old pattern took it as GET "port".
test("NEVER-FALSE: the Express settings getter is not a route", () => {
  const d = fixture({ "a.js": `const app = express();\nconst port = app.get("port");\napp.get("/healthz", h);` });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)).map((x) => x.path), ["/healthz"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("NEVER-FALSE: a name the file binds to a non-router loses its allowlisted status", () => {
  const d = fixture({ "c.js": `const api = require("../lib/client");\napi.get("/billing/quote");` });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)), [],
      "an HTTP client called `api` serves nothing");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an allowlisted name with no binding in the file still works", () => {
  // The common `module.exports = (app) => { app.get(...) }` shape binds
  // nothing, so the name allowlist has to keep carrying it.
  const d = fixture({ "m.js": `module.exports = (app) => {\n  app.get("/api/a", h);\n};` });
  try {
    assert.deepEqual(extractRoutes(sourceFiles(d)).map((x) => x.path), ["/api/a"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
