/**
 * The contract: what the fleet is held to.
 *
 * Nothing here authors anything. The host agent writes the JSON; this file
 * decides whether it is well-formed, stores it, and works out what each worker
 * is told. Every judgement below is a comparison, a lookup or a graph walk —
 * which is the property the whole tool rests on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_IDS, kindSpec, normalizeSubject } from "./compare.js";
import { DEFAULT_DIR } from "./log.js";
import type { Acceptance, Brief, Contract, ContractDecision, Decision, Kind, Unit } from "./types.js";

export const contractsDir = (dir = DEFAULT_DIR) => join(dir, "contracts");
export const contractPath = (id: string, dir = DEFAULT_DIR) => join(contractsDir(dir), `${id}.json`);

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The shape the host agent fills in. Published rather than described, so the
 * agent has something exact to target and the package has something exact to
 * reject against.
 */
export const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "orchestraguard contract",
  type: "object",
  required: ["id", "goal", "scope", "decisions", "units", "acceptance"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: ID.source, description: "kebab-case, unique per project" },
    goal: { type: "string", minLength: 1, description: "one sentence a reviewer can judge the result against" },
    scope: {
      type: "object", required: ["in", "out"], additionalProperties: false,
      properties: {
        in: { type: "array", items: { type: "string" } },
        out: { type: "array", items: { type: "string" }, description: "what this run will NOT do" },
      },
    },
    decisions: {
      type: "array",
      description: "binding from t=0, recorded at PM layer before any code exists",
      items: {
        type: "object", required: ["kind", "subject", "value"], additionalProperties: false,
        properties: {
          kind: { enum: [...KIND_IDS] },
          subject: { type: "string", minLength: 1 },
          value: {},
          rationale: { type: "string", description: "why this and not the alternative" },
        },
      },
    },
    openSubjects: {
      type: "array",
      description: "things this run will have to settle but has not. Workers must reuse these exact subject strings, because the gate matches subjects by wording — two spellings of one subject are two unrelated decisions and will not be compared.",
      items: {
        type: "object", required: ["kind", "subject"], additionalProperties: false,
        properties: {
          kind: { enum: [...KIND_IDS] },
          subject: { type: "string", minLength: 1 },
          note: { type: "string" },
        },
      },
    },
    units: {
      type: "array", minItems: 1,
      description: "one worker each",
      items: {
        type: "object", required: ["id", "goal", "files", "mayDecide", "dependsOn"], additionalProperties: false,
        properties: {
          id: { type: "string", pattern: ID.source },
          goal: { type: "string", minLength: 1 },
          files: { type: "array", items: { type: "string" }, description: "globs the unit owns" },
          mayDecide: { type: "array", items: { enum: [...KIND_IDS] }, description: "every other kind must be requested" },
          dependsOn: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
      },
    },
    acceptance: {
      type: "array", minItems: 1,
      items: {
        type: "object", required: ["id", "statement", "check", "unit"], additionalProperties: false,
        properties: {
          id: { type: "string", pattern: ID.source },
          statement: { type: "string", minLength: 1 },
          check: { type: "string", minLength: 1, description: "a command; exit 0 means satisfied" },
          unit: { type: "string" },
        },
      },
    },
  },
} as const;

export class ContractError extends Error {
  constructor(public readonly problems: string[]) {
    super(`contract is not valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ContractError";
  }
}

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Collects every problem rather than throwing on the first, because an agent
 * fixing one error at a time across four round trips is the expensive way to
 * find out the shape was wrong.
 */
export function validateContract(raw: unknown): Contract {
  const p: string[] = [];
  const bad = (m: string) => { p.push(m); };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractError(["contract must be a JSON object"]);
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.id !== "string" || !ID.test(c.id)) bad(`id must be kebab-case matching ${ID.source}`);
  if (typeof c.goal !== "string" || !c.goal.trim()) bad("goal must be a non-empty sentence");

  const scope = c.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object") bad("scope must be an object with `in` and `out`");
  else {
    if (!isStrArray(scope.in)) bad("scope.in must be an array of strings");
    if (!isStrArray(scope.out)) bad("scope.out must be an array of strings — say what this run will not do");
  }

  // --- decisions -------------------------------------------------------
  const decisions: ContractDecision[] = [];
  if (!Array.isArray(c.decisions)) bad("decisions must be an array");
  else {
    c.decisions.forEach((d: unknown, i) => {
      const o = d as Record<string, unknown>;
      if (!o || typeof o !== "object") return bad(`decisions[${i}] must be an object`);
      if (typeof o.kind !== "string" || !(KIND_IDS as readonly string[]).includes(o.kind)) {
        return bad(`decisions[${i}].kind must be one of ${KIND_IDS.join(", ")}`);
      }
      if (typeof o.subject !== "string" || !o.subject.trim()) return bad(`decisions[${i}].subject must be a non-empty string`);
      try {
        kindSpec(o.kind as Kind).parse(o.value);
      } catch (err) {
        return bad(`decisions[${i}] (${o.subject}): ${(err as Error).message}`);
      }
      decisions.push(o as unknown as ContractDecision);
    });

    // A contract that contradicts itself is the failure this tool exists to
    // catch, arriving before the fleet has even started.
    const seen = new Map<string, ContractDecision>();
    for (const d of decisions) {
      const key = `${d.kind}::${normalizeSubject(d.subject)}`;
      const prior = seen.get(key);
      if (!prior) { seen.set(key, d); continue; }
      const spec = kindSpec(d.kind);
      if (spec.conflicts(spec.parse(prior.value), spec.parse(d.value))) {
        bad(`decisions contradict each other on "${d.subject}": ${spec.render(spec.parse(prior.value))} vs ${spec.render(spec.parse(d.value))}`);
      }
    }
  }

  // --- open subjects ---------------------------------------------------
  if (c.openSubjects !== undefined) {
    if (!Array.isArray(c.openSubjects)) bad("openSubjects must be an array");
    else {
      const decided = new Set(decisions.map((d) => `${d.kind}::${normalizeSubject(d.subject)}`));
      const seen = new Set<string>();
      c.openSubjects.forEach((o: unknown, i) => {
        const x = o as Record<string, unknown>;
        if (!x || typeof x !== "object") return bad(`openSubjects[${i}] must be an object`);
        if (typeof x.kind !== "string" || !(KIND_IDS as readonly string[]).includes(x.kind)) {
          return bad(`openSubjects[${i}].kind must be one of ${KIND_IDS.join(", ")}`);
        }
        if (typeof x.subject !== "string" || !x.subject.trim()) {
          return bad(`openSubjects[${i}].subject must be a non-empty string`);
        }
        const key = `${x.kind}::${normalizeSubject(x.subject)}`;
        if (decided.has(key)) {
          bad(`"${x.subject}" is listed as open but the contract already decides it`);
        }
        if (seen.has(key)) bad(`openSubjects lists "${x.subject}" twice`);
        seen.add(key);
      });
    }
  }

  // --- units -----------------------------------------------------------
  const units: Unit[] = [];
  if (!Array.isArray(c.units) || c.units.length === 0) bad("units must be a non-empty array");
  else {
    const ids = new Set<string>();
    c.units.forEach((u: unknown, i) => {
      const o = u as Record<string, unknown>;
      if (!o || typeof o !== "object") return bad(`units[${i}] must be an object`);
      if (typeof o.id !== "string" || !ID.test(o.id)) return bad(`units[${i}].id must be kebab-case`);
      if (ids.has(o.id)) bad(`two units share the id "${o.id}"`);
      ids.add(o.id);
      if (typeof o.goal !== "string" || !o.goal.trim()) bad(`units[${o.id}].goal must be a non-empty sentence`);
      if (!isStrArray(o.files)) bad(`units[${o.id}].files must be an array of globs`);
      if (!isStrArray(o.mayDecide) || !o.mayDecide.every((k) => (KIND_IDS as readonly string[]).includes(k))) {
        bad(`units[${o.id}].mayDecide must contain only: ${KIND_IDS.join(", ")}`);
      }
      if (!isStrArray(o.dependsOn)) bad(`units[${o.id}].dependsOn must be an array of unit ids`);
      units.push(o as unknown as Unit);
    });

    for (const u of units) {
      for (const dep of u.dependsOn ?? []) {
        if (dep === u.id) bad(`unit "${u.id}" depends on itself`);
        else if (!ids.has(dep)) bad(`unit "${u.id}" depends on "${dep}", which is not a unit in this contract`);
      }
    }

    const cycle = findCycle(units);
    if (cycle) bad(`units form a dependency cycle: ${cycle.join(" -> ")}`);
  }

  // --- acceptance ------------------------------------------------------
  if (!Array.isArray(c.acceptance) || c.acceptance.length === 0) {
    bad("acceptance must be a non-empty array — a run with no criteria cannot be finished, only abandoned");
  } else {
    const unitIds = new Set(units.map((u) => u.id));
    const ids = new Set<string>();
    c.acceptance.forEach((a: unknown, i) => {
      const o = a as Record<string, unknown>;
      if (!o || typeof o !== "object") return bad(`acceptance[${i}] must be an object`);
      if (typeof o.id !== "string" || !ID.test(o.id)) return bad(`acceptance[${i}].id must be kebab-case`);
      if (ids.has(o.id)) bad(`two acceptance criteria share the id "${o.id}"`);
      ids.add(o.id);
      if (typeof o.statement !== "string" || !o.statement.trim()) bad(`acceptance[${o.id}].statement must be a non-empty sentence`);
      if (typeof o.check !== "string" || !o.check.trim()) {
        bad(`acceptance[${o.id}] has no check — a criterion without a command is a wish`);
      }
      if (typeof o.unit !== "string" || !unitIds.has(o.unit)) {
        bad(`acceptance[${o.id}].unit must name a unit in this contract`);
      }
    });

    const covered = new Set(c.acceptance.map((a) => (a as Acceptance).unit));
    for (const u of units) {
      if (!covered.has(u.id)) bad(`unit "${u.id}" has no acceptance criterion — nothing would prove it was done`);
    }
  }

  if (p.length) throw new ContractError(p);
  return c as unknown as Contract;
}

/** Depth-first cycle detection, returning the cycle so the message is useful. */
function findCycle(units: Unit[]): string[] | null {
  const edges = new Map(units.map((u) => [u.id, u.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (state.get(id) === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const u of units) {
    const found = walk(u.id);
    if (found) return found;
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * storage                                                           *
 * ---------------------------------------------------------------- */

export function saveContract(contract: Contract, dir = DEFAULT_DIR): string {
  mkdirSync(contractsDir(dir), { recursive: true });
  const path = contractPath(contract.id, dir);
  writeFileSync(path, JSON.stringify(contract, null, 2) + "\n", "utf8");
  return path;
}

export function loadContract(id: string, dir = DEFAULT_DIR): Contract {
  const path = contractPath(id, dir);
  if (!existsSync(path)) throw new Error(`no contract "${id}" in ${contractsDir(dir)}`);
  return validateContract(JSON.parse(readFileSync(path, "utf8")));
}

export function listContracts(dir = DEFAULT_DIR): string[] {
  const d = contractsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/* ---------------------------------------------------------------- *
 * briefing                                                          *
 * ---------------------------------------------------------------- */

const UNSET = "(not yet decided)";

/**
 * What one worker is told. Deliberately not the contract: a worker that can
 * read every other unit's goal will reason about them, and reasoning about
 * work you were not given is how a fleet talks itself into a contradiction.
 */
export function briefFor(contract: Contract, unitId: string, active: Decision[] = []): Brief {
  const unit = contract.units.find((u) => u.id === unitId);
  if (!unit) throw new Error(`no unit "${unitId}" in contract "${contract.id}"`);

  // Decisions in force: the contract's own, plus anything the log has gained
  // since. The log wins, because it is what the gate compares against.
  const binding = new Map<string, { kind: Kind; subject: string; value: unknown; rationale?: string }>();
  for (const d of contract.decisions) {
    binding.set(`${d.kind}::${normalizeSubject(d.subject)}`, { kind: d.kind, subject: d.subject, value: d.value, rationale: d.rationale });
  }
  for (const d of active) {
    binding.set(`${d.kind}::${normalizeSubject(d.subject)}`, { kind: d.kind, subject: d.subject, value: d.value, rationale: d.rationale });
  }

  const mayDecide = unit.mayDecide ?? [];
  const mustRequest = (KIND_IDS as readonly Kind[]).filter((k) => !mayDecide.includes(k));
  const acceptance = contract.acceptance
    .filter((a) => a.unit === unit.id)
    .map((a) => ({ id: a.id, statement: a.statement, check: a.check }));

  // Only the open subjects still open: one may have been settled since the
  // contract was written, and telling a worker to decide a decided thing is
  // how a second spelling gets created.
  const openForUnit = (contract.openSubjects ?? [])
    .filter((o) => !binding.has(`${o.kind}::${normalizeSubject(o.subject)}`));

  const lines = [...binding.values()].map((d) => `  - [${d.kind}] ${d.subject} = ${kindSpec(d.kind).render(kindSpec(d.kind).parse(d.value))}${d.rationale ? `  (${d.rationale})` : ""}`);

  const instructions = [
    `You are one worker on "${contract.id}". Your unit is "${unit.id}".`,
    ``,
    `GOAL`,
    `  ${unit.goal}`,
    ``,
    `FILES YOU OWN`,
    unit.files.length ? unit.files.map((f) => `  ${f}`).join("\n") : `  ${UNSET}`,
    `  Do not edit files outside this list. Another worker owns them.`,
    ``,
    `DECISIONS ALREADY IN FORCE — these are not suggestions`,
    lines.length ? lines.join("\n") : `  (none yet)`,
    ``,
    `WHAT YOU MAY DECIDE`,
    mayDecide.length ? `  ${mayDecide.join(", ")}` : `  nothing — you write code and decide nothing`,
    ``,
    `WHAT YOU MUST NOT DECIDE ALONE`,
    `  ${mustRequest.join(", ")}`,
    ``,
    openForUnit.length ? [
      `STILL TO BE DECIDED — use these subject lines VERBATIM`,
      ...openForUnit.map((o) => `  [${o.kind}] ${o.subject}${o.note ? `\n      ${o.note}` : ""}`),
      `  The gate matches subjects by wording. Rephrasing one of these creates a`,
      `  second, unrelated decision, and a disagreement between the two will not`,
      `  be detected. Copy the line exactly.`,
      ``,
    ].join("\n") : null,
    `RECORD A DECISION LIKE THIS — the flags are what enforce the two lists above`,
    `  orchestraguard decide --contract ${contract.id} --unit ${unit.id} \\`,
    `    --kind <kind> --subject "<what>" --value '<value>' --as ${unit.id} --rationale "<why>"`,
    ``,
    `  Omitting --unit skips the check on what you may decide. Use the MCP tool`,
    `  record_decision if you have it; it gates the same way.`,
    `  A refusal means a decision already covers this: adopt the existing value.`,
    `  Do not work around it, and do not --force it.`,
    ``,
    `DONE MEANS`,
    acceptance.length
      ? acceptance.map((a) => `  [${a.id}] ${a.statement}\n       $ ${a.check}`).join("\n")
      : `  ${UNSET}`,
    ``,
    unit.dependsOn?.length ? `WAIT FOR\n  ${unit.dependsOn.join(", ")}\n` : null,
    unit.notes ? `NOTES\n  ${unit.notes}` : null,
  ].filter((l) => l !== null).join("\n");

  return {
    contract: contract.id,
    unit: unit.id,
    goal: unit.goal,
    files: unit.files ?? [],
    binding: [...binding.values()],
    mayDecide,
    mustRequest,
    acceptance,
    dependsOn: unit.dependsOn ?? [],
    instructions,
  };
}

/** Units in dependency order, so a host fanning out knows what can start now. */
export function waves(contract: Contract): string[][] {
  const pending = new Map(contract.units.map((u) => [u.id, new Set(u.dependsOn ?? [])]));
  const out: string[][] = [];
  const done = new Set<string>();

  while (pending.size) {
    const ready = [...pending.entries()].filter(([, deps]) => [...deps].every((d) => done.has(d))).map(([id]) => id);
    // validateContract rejects cycles, so this cannot empty while work remains.
    if (!ready.length) throw new Error("dependency cycle in contract units");
    ready.sort();
    out.push(ready);
    for (const id of ready) { done.add(id); pending.delete(id); }
  }
  return out;
}

/**
 * Every subject this contract names, decided or open, keyed the way the gate
 * keys them. A decision whose subject is not in here is a subject nobody
 * declared — which is exactly how two workers end up describing one thing
 * two ways and the contradiction goes unseen.
 */
export function declaredSubjects(contract: Contract): Map<string, { kind: Kind; subject: string; state: "decided" | "open" }> {
  const out = new Map<string, { kind: Kind; subject: string; state: "decided" | "open" }>();
  for (const d of contract.decisions) {
    out.set(`${d.kind}::${normalizeSubject(d.subject)}`, { kind: d.kind, subject: d.subject, state: "decided" });
  }
  for (const o of contract.openSubjects ?? []) {
    const key = `${o.kind}::${normalizeSubject(o.subject)}`;
    if (!out.has(key)) out.set(key, { kind: o.kind, subject: o.subject, state: "open" });
  }
  return out;
}
