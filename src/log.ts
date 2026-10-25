import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Decision, Kind } from "./types.js";
import { kindSpec, normalizeSubject } from "./compare.js";

/**
 * Append-only JSONL. One decision per line.
 *
 * JSONL rather than YAML for two reasons: appending is a single syscall with no
 * parse-rewrite cycle, which is what an append-only log wants, and it needs no
 * parser, which keeps the package at zero runtime dependencies.
 */
export const DEFAULT_DIR = ".concord-engine";

/**
 * Where the log lives: an explicit flag, else the environment, else the
 * default. Both the CLI and the MCP server resolve through here, because when
 * they resolved separately they disagreed — the server wrote to the
 * environment's directory while `check` audited the default one, so the gate
 * and the audit were reading different files.
 *
 * Empty and whitespace are treated as unset. A host that expands an unset
 * config placeholder to "" must get the default, not the process cwd.
 */
/**
 * The decision already in force that a proposed one cannot coexist with, or
 * null. Extracted because `decide`, `bind` and the MCP gate each answered this
 * question separately and gave different answers — the CLI recorded what the
 * MCP server refused, so a worker following its brief was told a refusal would
 * come and it never did.
 */
export function findContradiction(
  active: Decision[],
  kind: Kind,
  subject: string,
  value: unknown,
): Decision | null {
  const spec = kindSpec(kind);
  const key = `${kind}::${subject.trim()}`;
  const parsed = spec.parse(value);
  for (const d of active) {
    if (`${d.kind}::${normalizeSubject(d.subject)}` !== key) continue;
    if (spec.conflicts(spec.parse(d.value), parsed)) return d;
  }
  return null;
}

export function resolveDir(flag?: string, env = process.env.CONCORD_ENGINE_DIR): string {
  return flag?.trim() || env?.trim() || DEFAULT_DIR;
}
export const decisionsPath = (dir = DEFAULT_DIR) => join(dir, "decisions.jsonl");

export function readDecisions(dir = DEFAULT_DIR): Decision[] {
  const path = decisionsPath(dir);
  if (!existsSync(path)) return [];
  const out: Decision[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as Decision);
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON. The log is append-only — do not hand-edit it.`);
    }
  });
  return out;
}

/**
 * Every writer reads the log, checks, then appends: three steps, and two
 * processes interleaving them both pass the check and both write. Eight
 * concurrent `decide`s on one subject recorded four contradicting decisions,
 * all four as d-001. So read-check-append is one critical section, serialised
 * by an exclusive lock file beside the log.
 *
 * `wx` (O_CREAT | O_EXCL) makes taking the lock atomic with no dependency.
 * A lock is never reclaimed automatically: deciding whether its holder is dead
 * is itself a race (two waiters both judge it stale and each deletes the
 * other's fresh lock), and the section it guards is a few milliseconds of
 * synchronous work, so a leftover lock means a process was killed mid-write.
 * That is rare enough to surface loudly rather than guess about.
 */
export const LOCK_TIMEOUT_MS = 5000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLogLock<T>(dir: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const path = `${decisionsPath(dir)}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd = -1;
  while (fd < 0) {
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline) {
        throw new Error(
          `${path} is held by another writer; gave up after ${timeoutMs}ms. ` +
          "If no concord-engine process is running, a writer was killed mid-write: delete the file and retry.",
        );
      }
      pause(5 + Math.random() * 20);
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}

export function appendDecision(decision: Decision, dir = DEFAULT_DIR): Decision {
  // Validate before writing: a log that can hold an invalid decision is a log
  // whose comparisons can throw later, far from the cause.
  kindSpec(decision.kind).parse(decision.value);
  const path = decisionsPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(decision) + "\n", "utf8");
  return decision;
}

/**
 * Decisions still in force: everything not named by a later `supersedes`.
 * Superseded entries stay on disk — a reversal has to remain visible.
 */
export function activeDecisions(all: Decision[]): Decision[] {
  const superseded = new Set<string>();
  for (const d of all) if (d.supersedes) superseded.add(d.supersedes);
  return all.filter((d) => !superseded.has(d.id));
}

/** Stable key a contradiction is detected on. */
export const subjectKey = (d: Decision) => `${d.kind}::${normalizeSubject(d.subject)}`;

export function nextId(all: Decision[], prefix = "d"): string {
  let max = 0;
  for (const d of all) {
    const m = /^d-(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
