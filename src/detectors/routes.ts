import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { normalizePath } from "../compare.js";
import { activeDecisions } from "../log.js";
import type { Decision } from "../types.js";

export interface ServedRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  /**
   * The receiver is a router, which may be mounted under a prefix that static
   * extraction cannot see. `path` is then relative to an unknown mount point —
   * evidence that the served path *ends* with it, not a claim about the
   * absolute path. An application (`express()`, `FastAPI()`) serves absolute
   * paths, so its routes leave this unset.
   */
  mountUnknown?: boolean;
}

export interface Violation {
  decision: Decision;
  reason: "route not served" | "method not served";
  expected: string;
  nearest?: ServedRoute;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".concord-engine"]);
const EXTS = new Set([".ts", ".js", ".mjs", ".tsx", ".jsx", ".py"]);

export function sourceFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith(".") && e !== ".") continue;
    const p = join(root, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) sourceFiles(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

/** What a receiver turned out to be, once the file has been read. */
type Receiver = "app" | "router";

/** `app`/`server` are applications; `router`/`api` may be mounted. */
const BY_NAME: Record<string, Receiver> = { app: "app", server: "app", router: "router", api: "router" };

// A lone identifier being assigned, with the start of its right-hand side.
// Anchored at a statement boundary or a declarator so that `api.timeout = 5`
// and an `app => ...` arrow parameter are not read as bindings, and
// `=(?![=>])` keeps comparisons and arrows out.
const BINDING = /(?:^|[;{}\n]|\b(?:const|let|var)\s+)\s*([A-Za-z_$][\w$]*)\s*(?::[^=\n;]+)?=(?![=>])\s*([^;\n]*)/g;
const ROUTER_CTOR = /^(?:await\s+)?(?:new\s+)?(?:[\w$]+(?:\s*\([^()]*\))?\s*\.\s*)*(?:Router|APIRouter)\b\s*\(([^)]*)/;
const APP_CTOR = /^(?:await\s+)?(?:new\s+)?(?:[\w$]+(?:\s*\([^()]*\))?\s*\.\s*)*(?:express|FastAPI|Flask)\b\s*\(/;

/**
 * Which identifiers this file binds to an application or a router.
 *
 * Evidence, not naming: a name the file binds to something that is not a
 * router is dropped from the name allowlist for that file, so the very common
 * `const api = createHttpClient()` stops looking like a router it never was.
 *
 * A router constructed with its own prefix — `APIRouter(prefix="/v1")`, koa's
 * `new Router({ prefix: "/v1" })` — is deliberately not tracked. It serves
 * `/v1/items`, never `/items`, and the prefix is sitting right there in the
 * source: recording the relative path would throw away what we can already
 * see, to claim a path the app does not serve.
 */
function receivers(text: string): Map<string, Receiver> {
  const out = new Map(Object.entries(BY_NAME));
  BINDING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BINDING.exec(text))) {
    const [, name, rhs] = m;
    const router = ROUTER_CTOR.exec(rhs);
    if (router) {
      if (/\bprefix\b/.test(router[1])) out.delete(name);
      else out.set(name, "router");
    } else if (APP_CTOR.test(rhs)) out.set(name, "app");
    else out.delete(name);
  }
  return out;
}

/**
 * Routes a codebase serves, read statically.
 *
 * Static extraction is a deliberate v1 limitation: it sees literal paths on
 * recognised handler calls and nothing else. A path built at runtime, or a
 * router produced by a factory, is invisible. That produces misses, never
 * false accusations — a decision is only reported as violated when no served
 * route matches it at all, and `concord-engine verify` says how many files it
 * read *and how many routes it extracted*, so "0 routes from 143 files" cannot
 * be mistaken for a clean bill of health.
 *
 * The receiver was once a literal allowlist of `app`/`router`/`server`/`api`,
 * which read zero routes out of a real Express app whose routers are named per
 * version (`const v1Route = express.Router()`). Widening it to any identifier
 * would be worse than narrow: `_.get("key")`, `cache.get("/x")` and an HTTP
 * client's `client.get("/api/users")` would all become routes the app does not
 * serve, and a phantom route is a false accusation waiting to happen — it lets
 * verify report that a path exists at a line which serves nothing. So the
 * receiver is widened on *evidence*: any identifier the same file binds to an
 * application or router constructor, plus the names above unless the file
 * binds them to something else. A handler path must also start with "/", which
 * is what a route looks like and what Express's own `app.get("port")` setting
 * lookup does not.
 *
 * Widening the receiver without widening what a router's path *means* would
 * have turned the old silence into a false accusation: the standard layout is
 * `v1Route.post("/orders")` mounted by `app.use("/api/v1", …)`, so a decided
 * `POST /api/v1/orders` would have been reported NOT SERVED against a route
 * the app does serve. Hence `mountUnknown`, and the suffix rule in
 * `satisfies()`. The cost is paid in the other direction: a decided
 * `/api/v2/orders` is satisfied by any router's `/orders`, wherever it is
 * really mounted. That is a miss, and `verifyReport` counts those as
 * `mountInferred` so a run that leaned on the relaxation says so instead of
 * passing quietly.
 */
export function extractRoutes(files: string[]): ServedRoute[] {
  // <ident>.get("/x" | <ident>.post('/x' | @app.get("/x") | @v1.put('/x')
  const js = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])(\/[^'"`]*)\3/gi;
  const py = /@\s*([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"])(\/[^'"]*)\2/gi;
  const found: ServedRoute[] = [];
  // A Python decorator matches both patterns — "@app.get(...)" contains
  // "app.get(...)" — so the same route would be counted twice. Dedupe on the
  // exact source position rather than trying to out-clever the regexes.
  const seen = new Set<string>();
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    // Bindings are tracked per file. A name bound to a router in one file says
    // nothing about the same name in another, and borrowing that evidence
    // across files is how a widened pattern starts inventing routes.
    const known = receivers(text);
    const lineAt = (i: number) => text.slice(0, i).split("\n").length;
    for (const re of [js, py]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const kind = known.get(m[1]);
        if (!kind) continue;
        const route: ServedRoute = { method: m[2].toUpperCase(), path: normalizePath(m[4]), file, line: lineAt(m.index) };
        if (kind === "router") route.mountUnknown = true;
        const key = `${route.method} ${route.path} ${route.file}:${route.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(route);
      }
    }
  }
  return found;
}

/**
 * Does this served route satisfy the decided path?
 *
 * A router's own path is relative to a mount point static extraction cannot
 * see, so the served path ends with it. `endsWith` on a path that begins with
 * "/" is segment-aligned, so a decided `/api/myorders` is not satisfied by a
 * router's `/orders`. Accepting the suffix can only ever suppress a violation,
 * never invent one — which is the trade the docblock above already makes.
 */
function satisfies(served: ServedRoute, wantPath: string): boolean {
  const sp = normalizePath(served.path);
  if (sp === wantPath) return true;
  return Boolean(served.mountUnknown) && sp !== "/" && wantPath.endsWith(sp);
}

/** api-contract decisions that no served route satisfies. */
export function verifyRoutes(decisions: Decision[], served: ServedRoute[]): Violation[] {
  const out: Violation[] = [];
  for (const d of activeDecisions(decisions)) {
    if (d.kind !== "api-contract") continue;
    const want = d.value as { method: string; path: string; status: number | null };
    // Both sides must be normalised. extractRoutes() already collapses
    // every parameter to :p, while the decision keeps the path as it was
    // authored — comparing those directly meant no source spelling could
    // ever satisfy a decision with a parameter in it, so every
    // parameterised route was reported NOT SERVED.
    const wantPath = normalizePath(want.path);
    const samePath = served.filter((s) => satisfies(s, wantPath));
    if (samePath.length === 0) {
      out.push({ decision: d, reason: "route not served", expected: `${want.method} ${want.path}` });
      continue;
    }
    if (!samePath.some((s) => s.method === want.method)) {
      out.push({
        decision: d, reason: "method not served",
        expected: `${want.method} ${want.path}`, nearest: samePath[0],
      });
    }
  }
  return out;
}

export interface VerifyReport {
  filesRead: number;
  routesFound: number;
  apiContractDecisions: number;
  /** Satisfied only by a router path whose mount prefix is not visible. */
  mountInferred: number;
  /**
   * There were decisions to check and nothing to check them against. Not a
   * pass: the run proved nothing, and must not be read as having proved
   * anything.
   */
  vacuous: boolean;
  violations: Violation[];
}

/**
 * What one `verify` run actually established.
 *
 * Violations alone cannot distinguish "every decision holds" from "the
 * detector recognised nothing in your codebase", and those two printed
 * identically — a real Express app came back green with no routes read out of
 * it at all. Vacuity is part of the result, not a detail of the renderer, so
 * every caller has to deal with it.
 */
export function verifyReport(decisions: Decision[], served: ServedRoute[], filesRead: number): VerifyReport {
  const active = activeDecisions(decisions).filter((d) => d.kind === "api-contract");
  const violations = verifyRoutes(decisions, served);
  const blamed = new Set(violations.map((v) => v.decision.id));
  const mountInferred = active.filter((d) => {
    if (blamed.has(d.id)) return false;
    const wantPath = normalizePath((d.value as { path: string }).path);
    return served.some((s) => satisfies(s, wantPath))
      && !served.some((s) => normalizePath(s.path) === wantPath);
  }).length;
  return {
    filesRead,
    routesFound: served.length,
    apiContractDecisions: active.length,
    mountInferred,
    vacuous: active.length > 0 && served.length === 0,
    violations,
  };
}
