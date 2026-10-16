import type { Kind, KindSpec } from "./types.js";

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

const asString = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${field} must be a non-empty string, got ${JSON.stringify(raw)}`);
  }
  return raw.trim();
};

const obj = (raw: unknown, kind: string): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${kind} value must be an object, got ${JSON.stringify(raw)}`);
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

const exact: Pick<KindSpec, "parse" | "conflicts" | "render"> = {
  parse: (raw) => asString(raw, "value"),
  conflicts: (a, b) => a !== b,
  render: (v) => String(v),
};

export const KINDS: Record<Kind, KindSpec> = {
  naming: { id: "naming", label: "naming", ...exact },
  convention: { id: "convention", label: "convention", ...exact },

  "api-contract": {
    id: "api-contract",
    label: "api contract",
    parse(raw) {
      const o = obj(raw, "api-contract");
      const method = asString(o.method, "method").toUpperCase();
      // Keep the path AS AUTHORED. Normalisation is how two paths are
      // compared, not what a path is: storing the normalised form rewrote
      // "/api/links/:code" to "/api/links/:p" in the log, so the brief told
      // workers the parameter was named `p`.
      const path = asString(o.path, "path");
      const status = o.status === undefined ? null : Number(o.status);
      if (status !== null && !Number.isInteger(status)) {
        throw new Error(`status must be an integer, got ${JSON.stringify(o.status)}`);
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
    parse(raw) {
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`enum value must be a non-empty array, got ${JSON.stringify(raw)}`);
      }
      return [...new Set(raw.map((v, i) => asString(v, `enum[${i}]`)))].sort();
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
    parse(raw) {
      const o = obj(raw, "schema");
      return {
        field: asString(o.field, "field"),
        type: asString(o.type, "type").toLowerCase(),
        nullable: o.nullable === undefined ? null : Boolean(o.nullable),
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
