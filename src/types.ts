/** Who issued a decision. Workers issue none — they write code. */
export type Layer = "pm" | "lead";

/**
 * The fixed set of decision kinds. Fixed on purpose: every kind defines how its
 * value is compared, so a contradiction is always a comparison and never a
 * judgement. Anything that doesn't fit a kind is not a decision.
 */
export type Kind = "naming" | "api-contract" | "enum" | "schema" | "convention";

export interface Decision {
  id: string;
  kind: Kind;
  /** What the decision is about. The key a contradiction is detected on. */
  subject: string;
  /** Shape depends on `kind`. Validated and canonicalised by that kind's spec. */
  value: unknown;
  layer: Layer;
  author: string;
  rationale?: string;
  /** Id of the decision this replaces. The replaced entry stays in the log. */
  supersedes?: string | null;
  at: string;
}

export type ConflictState = "open" | "resolved" | "escalated";

export interface Conflict {
  id: string;
  /** Normalised subject the two decisions collided on. */
  subject: string;
  kind: Kind;
  /** The two decision ids in conflict. */
  between: [string, string];
  /** Which layer currently owns resolving it. */
  owner: Layer | "human";
  attempts: number;
  state: ConflictState;
  /** Decision id that resolved it, once resolved. */
  resolvedBy?: string;
  notes: string[];
  at: string;
}

/** How one kind of value is validated, compared and displayed. */
export interface KindSpec {
  id: Kind;
  label: string;
  /** Canonicalise a raw value, or throw with a message a human can act on. */
  parse(raw: unknown): unknown;
  /** True when two canonical values cannot both hold. */
  conflicts(a: unknown, b: unknown): boolean;
  /** One-line rendering for the escalation packet. */
  render(value: unknown): string;
}
