import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DEFAULT_DIR } from "./log.js";
import { normalizeSubject } from "./compare.js";
import type { Conflict } from "./types.js";
import type { Finding } from "./detect.js";

export const conflictsPath = (dir = DEFAULT_DIR) => join(dir, "conflicts.jsonl");

/**
 * A conflict's identity is its subject, not the run that found it — otherwise
 * every `check` would report the same disagreement as new and the escalation
 * budget would never advance.
 */
export function conflictId(f: Finding): string {
  const h = createHash("sha256").update(`${f.kind}::${normalizeSubject(f.subject)}`).digest("hex");
  return `c-${h.slice(0, 8)}`;
}

export function readConflicts(dir = DEFAULT_DIR): Conflict[] {
  const path = conflictsPath(dir);
  if (!existsSync(path)) return [];
  const latest = new Map<string, Conflict>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as Conflict;
    latest.set(c.id, c); // append-only; last write for an id wins
  }
  return [...latest.values()];
}

export function writeConflict(c: Conflict, dir = DEFAULT_DIR): Conflict {
  const path = conflictsPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(c) + "\n", "utf8");
  return c;
}

/** Fold freshly detected findings into stored state, preserving attempt counts. */
export function reconcile(findings: Finding[], stored: Conflict[], dir = DEFAULT_DIR): Conflict[] {
  const byId = new Map(stored.map((c) => [c.id, c]));
  const live: Conflict[] = [];

  for (const f of findings) {
    const id = conflictId(f);
    const existing = byId.get(id);
    if (existing && existing.state !== "resolved") {
      live.push(existing);
      continue;
    }
    const fresh: Conflict = {
      id, subject: f.subject, kind: f.kind,
      between: [f.decisions[0]?.id ?? "", f.decisions[1]?.id ?? ""],
      owner: f.owner, attempts: 0, state: "open", notes: [],
      at: new Date().toISOString(),
    };
    writeConflict(fresh, dir);
    live.push(fresh);
  }

  // Anything stored, still open, and no longer detected has been settled.
  const liveIds = new Set(live.map((c) => c.id));
  for (const c of stored) {
    if (c.state !== "resolved" && !liveIds.has(c.id)) {
      writeConflict({ ...c, state: "resolved", notes: [...c.notes, "no longer detected"] }, dir);
    }
  }
  return live;
}
