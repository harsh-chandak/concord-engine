import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { normalizePath } from "../compare.js";
import { activeDecisions } from "../log.js";
import type { Decision } from "../types.js";

export interface ServedRoute { method: string; path: string; file: string; line: number }

export interface Violation {
  decision: Decision;
  reason: "route not served" | "method not served";
  expected: string;
  nearest?: ServedRoute;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".orchestraguard"]);
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

/**
 * Routes a codebase serves, read statically.
 *
 * Static extraction is a deliberate v1 limitation: it sees literal paths on
 * recognised handler calls and nothing else. A router mounted under a prefix,
 * or a path built at runtime, is invisible. That produces misses, never false
 * accusations — a decision is only reported as violated when no served route
 * matches it at all, and `orchestraguard verify` says how many files it read so the
 * number is never mistaken for completeness.
 */
export function extractRoutes(files: string[]): ServedRoute[] {
  // app.get("/x" | router.post('/x' | @app.get("/x") | @router.put('/x')
  const js = /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"`])([^'"`]+)\2/gi;
  const py = /@\s*(?:app|router|api)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/gi;
  const found: ServedRoute[] = [];
  // A Python decorator matches both patterns — "@app.get(...)" contains
  // "app.get(...)" — so the same route would be counted twice. Dedupe on the
  // exact source position rather than trying to out-clever the regexes.
  const seen = new Set<string>();
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const lineAt = (i: number) => text.slice(0, i).split("\n").length;
    for (const re of [js, py]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const route: ServedRoute = { method: m[1].toUpperCase(), path: normalizePath(m[3]), file, line: lineAt(m.index) };
        const key = `${route.method} ${route.path} ${route.file}:${route.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(route);
      }
    }
  }
  return found;
}

/** api-contract decisions that no served route satisfies. */
export function verifyRoutes(decisions: Decision[], served: ServedRoute[]): Violation[] {
  const out: Violation[] = [];
  for (const d of activeDecisions(decisions)) {
    if (d.kind !== "api-contract") continue;
    const want = d.value as { method: string; path: string; status: number | null };
    const samePath = served.filter((s) => s.path === want.path);
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
