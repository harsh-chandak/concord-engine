import { kindSpec, normalizeSubject } from "./compare.js";
import { activeDecisions, subjectKey } from "./log.js";
import type { Conflict, Decision, Layer } from "./types.js";

export interface Finding {
  kind: Decision["kind"];
  subject: string;
  /** Decisions that cannot all hold. */
  decisions: Decision[];
  /** Layer that owns resolving it, per the escalation ladder. */
  owner: Layer | "human";
  reason: string;
}

export interface Override {
  subject: string;
  winner: Decision;
  overridden: Decision[];
}

export interface DetectResult {
  conflicts: Finding[];
  /** PM decisions that settled a disagreement without escalation. */
  overrides: Override[];
  decisionsConsidered: number;
}

/**
 * Horizontal detection: decisions against decisions.
 *
 * Adjudication is read off the hierarchy, not judged. A PM decision outranks a
 * lead decision on the same subject, so that pairing is an override and not a
 * conflict. Two leads who disagree escalate to the PM. Two PM decisions that
 * disagree have nobody above them, so they go to the human.
 */
export function detect(all: Decision[]): DetectResult {
  const active = activeDecisions(all);
  const groups = new Map<string, Decision[]>();
  for (const d of active) {
    const k = subjectKey(d);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(d);
  }

  const conflicts: Finding[] = [];
  const overrides: Override[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const spec = kindSpec(group[0].kind);
    const parsed = group.map((d) => ({ d, v: spec.parse(d.value) }));

    const pms = parsed.filter((p) => p.d.layer === "pm");
    const leads = parsed.filter((p) => p.d.layer === "lead");

    if (pms.length > 1) {
      const differing = pms.filter((p) => spec.conflicts(p.v, pms[0].v));
      if (differing.length) {
        conflicts.push({
          kind: group[0].kind,
          subject: group[0].subject,
          decisions: pms.map((p) => p.d),
          owner: "human",
          reason: "two PM decisions disagree and there is no layer above them",
        });
        continue;
      }
    }

    if (pms.length === 1) {
      const loses = leads.filter((p) => spec.conflicts(p.v, pms[0].v));
      if (loses.length) {
        overrides.push({
          subject: group[0].subject,
          winner: pms[0].d,
          overridden: loses.map((p) => p.d),
        });
      }
      continue; // the PM decision settles the subject
    }

    const differing = leads.filter((p) => spec.conflicts(p.v, leads[0].v));
    if (differing.length) {
      conflicts.push({
        kind: group[0].kind,
        subject: group[0].subject,
        decisions: leads.map((p) => p.d),
        owner: "pm",
        reason: "leads disagree; resolution belongs to the layer above",
      });
    }
  }

  return { conflicts, overrides, decisionsConsidered: active.length };
}

/** Escalation ladder. Two attempts at a layer, then up. */
export const LADDER: Array<Layer | "human"> = ["lead", "pm", "human"];
export const MAX_ATTEMPTS = 2;

export function nextOwner(current: Layer | "human"): Layer | "human" {
  const i = LADDER.indexOf(current);
  return i === -1 || i === LADDER.length - 1 ? "human" : LADDER[i + 1];
}

export function escalate(conflict: Conflict): Conflict {
  if (conflict.attempts + 1 < MAX_ATTEMPTS) {
    return { ...conflict, attempts: conflict.attempts + 1 };
  }
  const owner = nextOwner(conflict.owner);
  return {
    ...conflict,
    owner,
    attempts: 0,
    state: owner === "human" ? "escalated" : conflict.state,
    notes: [...conflict.notes, `escalated to ${owner} after ${MAX_ATTEMPTS} attempts`],
  };
}

export { normalizeSubject };
