import type { Kind, KindSpec, KindValueShape } from "./types.js";

/**
 * Subjects are written by different agents, so "user identifier in API payloads"
 * and "User Identifier in API Payloads" must collide — otherwise two leads
 * describe the same thing differently and the contradiction is silently missed,
 * which is the exact failure this tool exists to catch.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const json = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

/**
 * A value this kind cannot accept, said in full.
 *
 * The old messages named the offending field and stopped there — "method must
 * be a non-empty string, got undefined". That says which word was wrong and
 * nothing about what right looks like, so every correction is a guess, and a
 * peer session spent three round trips guessing. Every rejection now carries
 * the kind, the rule it broke, the whole shape, and a value that works.
 */
export class KindValueError extends Error {
  constructor(
    readonly kind: Kind,
    /** The rule the value broke, e.g. "a non-empty string". */
    readonly rule: string,
    readonly got: unknown,
    /** Where it broke: "value", or "value.method". */
    readonly at: string = "value",
    /** One extra line, when what was sent says what was probably meant. */
    readonly hint?: string,
  ) {
    super([
      got === undefined
        ? `${kind} ${at} must be ${rule}, but is missing`
        : `${kind} ${at} must be ${rule}, got ${json(got)}`,
      `  shape:  ${KINDS[kind].shape.summary}`,
      `  valid:  ${json(KINDS[kind].shape.example)}`,
      ...(hint ? [`  note:   ${hint}`] : []),
      `  see:    concord-engine kinds`,
    ].join("\n"));
    this.name = "KindValueError";
  }
}

const asString = (raw: unknown, kind: Kind, at: string): string => {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new KindValueError(kind, "a non-empty string", raw, at);
  }
  return raw.trim();
};

const obj = (raw: unknown, kind: Kind): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new KindValueError(kind, "a JSON object", raw);
  }
  return raw as Record<string, unknown>;
};

/** Path params are named differently by every framework; compare their shape. */
export function normalizePath(path: string): string {
  return path
    // ${id} must be handled before {id}, or the inner braces match first and
    // leave a stray "$" behind — which reads as a different route and invents
    // a conflict that does not exist.
    .replace(/\$\{[^}]+\}/g, ":p")      // ${id}     template literals
    .replace(/\{[^}]+\}/g, ":p")        // {id}      FastAPI / OpenAPI
    .replace(/<[^>]+>/g, ":p")          // <int:id>  Flask / Django
    .replace(/:[A-Za-z_][\w]*/g, ":p")  // :id       Express
    .replace(/\/+$/, "")                 // the trailing slash that caused the outage
    .toLowerCase() || "/";
}

/* ------------------------------------------------------------------ *
 * The value shapes — one definition, four readers.                   *
 *                                                                    *
 * `kinds` prints these, `spec --schema` publishes them, the MCP tool  *
 * descriptions quote them, and the parsers below enforce them. They   *
 * were three separate descriptions of the same rules while the        *
 * published schema said only `"value": {}` — so an agent handed that  *
 * schema learned the real shapes by being refused, one field per      *
 * round trip. The suite asserts every example here is a value its own *
 * parse() accepts, which is what stops the readers drifting again.    *
 * ------------------------------------------------------------------ */

const stringShape = (what: string, example: string): KindValueShape => ({
  schema: { type: "string", minLength: 1, description: what, examples: [example] },
  summary: `a non-empty string — ${what}`,
  example,
});

const API_CONTRACT_SHAPE: KindValueShape = {
  schema: {
    type: "object",
    required: ["method", "path"],
    description: "one HTTP endpoint. Keys other than these three are ignored.",
    properties: {
      method: { type: "string", minLength: 1, description: "upper-cased when stored" },
      path: { type: "string", minLength: 1, description: "stored exactly as authored; parameter names are ignored when two paths are compared" },
      status: { type: ["integer", "null"], description: "omit it, or null, when unspecified — an unspecified status does not contradict a specified one. A string of digits is coerced to an integer." },
    },
    examples: [{ method: "POST", path: "/orders", status: 201 }],
  },
  summary: '{"method": a non-empty string, "path": a non-empty string, "status": an integer or omitted}',
  example: { method: "POST", path: "/orders", status: 201 },
};

const ENUM_SHAPE: KindValueShape = {
  schema: {
    type: "array",
    minItems: 1,
    items: { type: "string", minLength: 1 },
    description: "the members. Duplicates are dropped and the list is sorted when stored.",
    examples: [["pending", "paid", "shipped"]],
  },
  summary: "a non-empty array of non-empty strings",
  example: ["pending", "paid", "shipped"],
};

const SCHEMA_SHAPE: KindValueShape = {
  schema: {
    type: "object",
    required: ["field", "type"],
    description: "one field of a stored shape. Keys other than these three are ignored.",
    properties: {
      field: { type: "string", minLength: 1 },
      type: { type: "string", minLength: 1, description: "lower-cased when stored" },
      nullable: { type: ["boolean", "null"], description: "omit it, or null, when unspecified" },
    },
    examples: [{ field: "id", type: "uuid", nullable: false }],
  },
  summary: '{"field": a non-empty string, "type": a non-empty string, "nullable": a boolean or omitted}',
  example: { field: "id", type: "uuid", nullable: false },
};

/**
 * `pending,paid,shipped` is a reasonable thing to type and the wrong thing to
 * accept. An enum member may legitimately contain a comma — "paid, awaiting
 * capture" is one value, not two — so splitting on commas would record a
 * different enum than the one that was written, into a log other agents then
 * implement from. The gate would compare it, find no contradiction, and
 * everyone would build the corrupted list.
 *
 * So it is refused, and the text is handed back as the JSON array it would be,
 * which costs no round trip: the fix is a paste, and choosing it stays with
 * the author. This is the line `expectsString` draws — for naming and
 * convention the value IS a string, so unparseable text has exactly one
 * possible meaning and taking it is not a guess. Here it has two.
 */
const commaHint = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || !raw.includes(",")) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  return `a comma-separated list is not a JSON array. If you meant ${parts.length} members, send ${JSON.stringify(parts)} — commas are not split for you, because an enum member may contain one.`;
};

/** naming and convention: the value is the string itself, compared exactly. */
const exact = (kind: Kind, shape: KindValueShape): KindSpec => ({
  id: kind,
  label: kind,
  shape,
  parse: (raw) => asString(raw, kind, "value"),
  conflicts: (a, b) => a !== b,
  render: (v) => String(v),
});

export const KINDS: Record<Kind, KindSpec> = {
  naming: exact("naming", stringShape("the name itself", "user_id")),
  convention: exact("convention", stringShape("the convention, in prose", "all JSON keys are snake_case")),

  "api-contract": {
    id: "api-contract",
    label: "api contract",
    shape: API_CONTRACT_SHAPE,
    parse(raw) {
      const o = obj(raw, "api-contract");
      const method = asString(o.method, "api-contract", "value.method").toUpperCase();
      // Keep the path AS AUTHORED. Normalisation is how two paths are
      // compared, not what a path is: storing the normalised form rewrote
      // "/api/links/:code" to "/api/links/:p" in the log, so the brief told
      // workers the parameter was named `p`.
      const path = asString(o.path, "api-contract", "value.path");
      // null is how an agent writes "unspecified" in JSON, and Number(null) is
      // 0 — so a null status was stored as status 0, which is not a status,
      // contradicts every real one, and was published here as an integer.
      const status = o.status === undefined || o.status === null ? null : Number(o.status);
      if (status !== null && !Number.isInteger(status)) {
        throw new KindValueError("api-contract", "an integer", o.status, "value.status");
      }
      return { method, path, status };
    },
    conflicts(a, b) {
      const x = a as { method: string; path: string; status: number | null };
      const y = b as typeof x;
      if (x.method !== y.method) return true;
      if (normalizePath(x.path) !== normalizePath(y.path)) return true;
      // An unspecified status doesn't contradict a specified one.
      if (x.status === null || y.status === null) return false;
      return x.status !== y.status;
    },
    render(v) {
      const x = v as { method: string; path: string; status: number | null };
      return `${x.method} ${x.path}${x.status === null ? "" : ` -> ${x.status}`}`;
    },
  },

  enum: {
    id: "enum",
    label: "enum",
    shape: ENUM_SHAPE,
    parse(raw) {
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new KindValueError("enum", "a non-empty array of non-empty strings", raw, "value", commaHint(raw));
      }
      return [...new Set(raw.map((v, i) => asString(v, "enum", `value[${i}]`)))].sort();
    },
    conflicts(a, b) {
      const x = a as string[], y = b as string[];
      return x.length !== y.length || x.some((v, i) => v !== y[i]);
    },
    render: (v) => `[${(v as string[]).join(", ")}]`,
  },

  schema: {
    id: "schema",
    label: "schema",
    shape: SCHEMA_SHAPE,
    parse(raw) {
      const o = obj(raw, "schema");
      // Boolean("false") is true, so a non-boolean `nullable` was stored as
      // the opposite of what was written — silently, and against a published
      // shape that says boolean.
      if (o.nullable !== undefined && o.nullable !== null && typeof o.nullable !== "boolean") {
        throw new KindValueError("schema", "a boolean", o.nullable, "value.nullable");
      }
      return {
        field: asString(o.field, "schema", "value.field"),
        type: asString(o.type, "schema", "value.type").toLowerCase(),
        nullable: o.nullable === undefined || o.nullable === null ? null : o.nullable,
      };
    },
    conflicts(a, b) {
      const x = a as { field: string; type: string; nullable: boolean | null };
      const y = b as typeof x;
      if (x.field !== y.field || x.type !== y.type) return true;
      if (x.nullable === null || y.nullable === null) return false;
      return x.nullable !== y.nullable;
    },
    render(v) {
      const x = v as { field: string; type: string; nullable: boolean | null };
      return `${x.field}: ${x.type}${x.nullable === null ? "" : x.nullable ? " (nullable)" : " (not null)"}`;
    },
  },
};

export const KIND_IDS = Object.keys(KINDS) as Kind[];

export function kindSpec(kind: string): KindSpec {
  const k = KINDS[kind as Kind];
  if (!k) throw new Error(`Unknown kind "${kind}". Known kinds: ${KIND_IDS.join(", ")}`);
  return k;
}

/**
 * True when this kind's value IS a string, so text that does not parse as JSON
 * is simply the value. Read off the published shape rather than listed again
 * here: a second list is how `--value` came to refuse a legitimate convention
 * that happened to start with "{".
 */
export function expectsString(kind: string): boolean {
  const k = KINDS[kind as Kind];
  return Boolean(k) && k.shape.schema.type === "string";
}

/** The shapes on one line, for a help string or an MCP tool description. */
export function shapeHelp(): string {
  return KIND_IDS.map((k) => `${k} takes ${KINDS[k].shape.summary}`).join("; ");
}
