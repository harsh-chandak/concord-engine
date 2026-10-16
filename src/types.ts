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

/* ------------------------------------------------------------------ *
 * v0.2 — the contract                                                 *
 * ------------------------------------------------------------------ */

/** A decision stated in a contract, before it has an id or a timestamp. */
export interface ContractDecision {
  kind: Kind;
  subject: string;
  value: unknown;
  rationale?: string;
}

/** One worker's share of the work. */
export interface Unit {
  id: string;
  goal: string;
  /** Globs the worker owns. Globs, not contents — the worker has a filesystem. */
  files: string[];
  /**
   * Kinds this unit may settle on its own. Everything else must be requested,
   * which is what makes the gate load-bearing rather than advisory.
   */
  mayDecide: Kind[];
  dependsOn: string[];
  notes?: string;
}

/** A criterion with a command behind it. Without the command it is a wish. */
export interface Acceptance {
  id: string;
  statement: string;
  check: string;
  unit: string;
}

/**
 * Something the run knows it will have to settle, named before anyone starts.
 *
 * This exists because of how the gate actually fails. Contradiction is found
 * by comparing decisions that share a subject, and subjects are matched after
 * folding case, punctuation and accents — but not wording. Two workers who
 * independently name the same thing "error response body shape" and "api
 * error response body" produce two unrelated decisions, and the gate never
 * compares them. Observed, not theorised: it happened on the first run of
 * this loop against a second project, and only a diligent worker reading the
 * log caught it.
 *
 * Declaring the subject up front turns identity into a lookup instead of a
 * guess, which keeps the answer deterministic.
 */
export interface OpenSubject {
  kind: Kind;
  subject: string;
  note?: string;
}

export interface Contract {
  id: string;
  goal: string;
  scope: { in: string[]; out: string[] };
  decisions: ContractDecision[];
  /** Known to need deciding during the run. Workers must use these spellings. */
  openSubjects?: OpenSubject[];
  units: Unit[];
  acceptance: Acceptance[];
}

/** What one worker is told, and nothing else. */
export interface Brief {
  contract: string;
  unit: string;
  goal: string;
  files: string[];
  /** Decisions already in force that this unit must honour. */
  binding: { kind: Kind; subject: string; value: unknown; rationale?: string }[];
  mayDecide: Kind[];
  mustRequest: Kind[];
  acceptance: { id: string; statement: string; check: string }[];
  dependsOn: string[];
  /** Instruction text the host hands the worker verbatim. */
  instructions: string;
}

export interface CheckResult {
  id: string;
  statement: string;
  check: string;
  unit: string;
  passed: boolean;
  code: number | null;
  ms: number;
  output: string;
}
