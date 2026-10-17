#!/usr/bin/env node
/**
 * concord-engine MCP server.
 *
 * The important behaviour is that `record_decision` REFUSES a decision that
 * contradicts one already in force, and returns the conflict instead. The
 * agent is stopped at the moment it tries to disagree, rather than told
 * afterwards by a human who had to notice.
 *
 * The v0.2 tools put the whole loop behind the same gate: a contract is
 * written, bound, briefed out one unit at a time, and proved by the commands
 * it named. A host agent that never shells out still cannot skip the refusal.
 *
 * Nothing here calls a model. Agreement is a comparison.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { detect, escalate } from "./detect.js";
import { KIND_IDS, kindSpec, normalizeSubject } from "./compare.js";
import { appendDecision, readDecisions, nextId, activeDecisions, resolveDir } from "./log.js";
import { conflictId, reconcile, readConflicts, writeConflict } from "./conflicts.js";
import {
  ContractError, SCHEMA, briefFor, loadContract, saveContract, validateContract, waves,
} from "./contract.js";
import { costReport, generateDocs, runAcceptance } from "./run.js";
import type { Contract, Decision, Layer } from "./types.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;
const DIR = resolveDir();

async function loadSdk() {
  try {
    const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    return { Server, StdioServerTransport, ...types };
  } catch {
    process.stderr.write(
      "concord-engine-mcp needs @modelcontextprotocol/sdk, an optional peer dependency.\n" +
        "Run it with the SDK provided:\n" +
        "  npx -y -p concord-engine -p @modelcontextprotocol/sdk concord-engine-mcp\n" +
        "or install it alongside concord-engine:\n" +
        "  npm i concord-engine @modelcontextprotocol/sdk\n",
    );
    process.exit(1);
  }
}

const KIND_HELP = `One of: ${KIND_IDS.join(", ")}. api-contract takes {method,path,status}; enum takes a list of strings; schema takes {field,type,nullable}; naming and convention take a string.`;

const TOOLS = [
  {
    name: "record_decision",
    description:
      "Record a decision as a team lead or PM. REFUSES and returns the conflict if it contradicts a decision already in force, so you find out before the work is done rather than at integration. Workers do not call this — they write code. Read-only on conflict.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: KIND_HELP },
        subject: { type: "string", description: "What the decision is about, e.g. 'user identifier in API payloads'. Matched loosely, so phrasing need not be identical to another lead's." },
        value: { description: "Shape depends on kind. See the kind description." },
        author: { type: "string", description: "Who is deciding, e.g. 'backend-lead'." },
        layer: { type: "string", enum: ["lead", "pm"], description: "Default lead. A pm decision overrides a lead's on the same subject." },
        rationale: { type: "string", description: "Why. Shown to whoever has to adjudicate a conflict — write it for them." },
        supersedes: { type: "string", description: "Id of a decision this replaces. Required to change an existing decision; the old one stays visible." },
      },
      required: ["kind", "subject", "value", "author"],
    },
  },
  {
    name: "binding_decisions",
    description:
      "The decisions currently in force. Call this BEFORE writing code so you implement what was actually decided rather than guessing. Optionally filter by subject.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Only decisions whose subject matches this, loosely." },
        kind: { type: "string", description: KIND_HELP },
      },
    },
  },
  {
    name: "open_conflicts",
    description:
      "Conflicts that are unresolved, with whose turn it is and what has already been tried. Each one is a packet you can act on without reading a transcript.",
    inputSchema: { type: "object", properties: { owner: { type: "string", enum: ["lead", "pm", "human"] } } },
  },
  {
    name: "record_attempt",
    description:
      "Record a failed attempt to resolve a conflict, with what was tried and why it failed. Two attempts at a layer and it escalates to the layer above; from the PM it escalates to the human.",
    inputSchema: {
      type: "object",
      properties: { conflictId: { type: "string" }, note: { type: "string", description: "What was tried and why it failed." } },
      required: ["conflictId", "note"],
    },
  },
  {
    name: "status",
    description:
      "How often conflicts reached a human. The number this tool exists to drive to zero.",
    inputSchema: { type: "object", properties: {} },
  },

  /* ---------------- v0.2: the loop ---------------- */

  {
    name: "write_contract",
    description:
      "Validate a contract and store it. REFUSES an invalid one and returns every problem at once, with the schema, so you repair it in a single round trip instead of four. A contract that contradicts itself is caught here, before any worker has started.",
    inputSchema: {
      type: "object",
      properties: {
        contract: { description: "The contract, as an object or a JSON string. A refusal returns the schema it was measured against." },
      },
      required: ["contract"],
    },
  },
  {
    name: "bind_contract",
    description:
      "Put a stored contract's decisions in force at PM layer. Refuses any that contradict a decision already recorded rather than overriding it — a new contract quietly winning over a live decision is the failure this tool exists to prevent. Run this before briefing anyone.",
    inputSchema: {
      type: "object",
      properties: {
        contract: { type: "string", description: "Contract id." },
        as: { type: "string", description: "Who is binding. Default contract:<id>." },
      },
      required: ["contract"],
    },
  },
  {
    name: "brief_unit",
    description:
      "Everything one worker is told, and nothing else: its goal, the files it owns, the decisions it must honour, what it may not decide alone, and what done means. Hand `instructions` to the worker verbatim. Do not also hand it the contract — a worker that can read other units' work reasons about it.",
    inputSchema: {
      type: "object",
      properties: {
        contract: { type: "string", description: "Contract id." },
        unit: { type: "string", description: "Unit id from the contract." },
      },
      required: ["contract", "unit"],
    },
  },
  {
    name: "fleet_plan",
    description:
      "The units in dependency order, with each one's brief, so you can fan out a wave at a time and know what is allowed to start now. Give each worker only its own brief.",
    inputSchema: {
      type: "object",
      properties: { contract: { type: "string", description: "Contract id." } },
      required: ["contract"],
    },
  },
  {
    name: "run_acceptance",
    description:
      "Runs the command behind every acceptance criterion and reports which passed. The contract's own commands, not an opinion about whether the work looks finished.",
    inputSchema: {
      type: "object",
      properties: { contract: { type: "string", description: "Contract id." } },
      required: ["contract"],
    },
  },
  {
    name: "generate_docs",
    description:
      "The design doc nobody writes, rendered from the decision log — so it cannot drift from what was actually decided and enforced. Returns markdown, or writes it to a path.",
    inputSchema: {
      type: "object",
      properties: {
        contract: { type: "string", description: "Contract id." },
        out: { type: "string", description: "Write the markdown here instead of returning it." },
      },
      required: ["contract"],
    },
  },
  {
    name: "cost_report",
    description:
      "What briefing cost against handing every worker the whole contract. Byte counts are measured; token figures are estimates from a stated chars-per-token divisor, and are labelled as such wherever they appear.",
    inputSchema: {
      type: "object",
      properties: {
        contract: { type: "string", description: "Contract id." },
        charsPerToken: { type: "number", description: "The divisor behind the token estimate. Default 4." },
      },
      required: ["contract"],
    },
  },
];

const { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = await loadSdk();
const server = new Server({ name: "concord-engine", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/**
 * Loads the contract a loop tool was pointed at. Named rather than inlined so
 * the missing-argument message says what to do next, which is the difference
 * between an agent recovering and an agent guessing an id.
 */
function contractArg(a: Record<string, any>): Contract {
  const id = typeof a.contract === "string" ? a.contract.trim() : "";
  if (!id) throw new Error("this tool needs `contract`: the id of a contract stored with write_contract");
  return loadContract(id, DIR);
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const ok = (p: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }] });

  try {
    if (name === "record_decision") {
      const all = readDecisions(DIR);
      const layer = (a.layer ?? "lead") as Layer;
      const candidate: Decision = {
        id: nextId(all), kind: a.kind, subject: String(a.subject),
        value: kindSpec(a.kind).parse(a.value), layer, author: String(a.author),
        rationale: a.rationale, supersedes: a.supersedes ?? null,
        at: new Date().toISOString(),
      };

      // The gate: would this contradict something already in force?
      const would = detect([...all, candidate]).conflicts
        .filter((f) => f.decisions.some((d) => d.id === candidate.id));
      if (would.length) {
        const f = would[0];
        return ok({
          recorded: false,
          refused: "this contradicts a decision already in force",
          conflict: {
            kind: f.kind, subject: f.subject, ownerToResolve: f.owner, reason: f.reason,
            existing: f.decisions.filter((d) => d.id !== candidate.id)
              .map((d) => ({ id: d.id, author: d.author, layer: d.layer, value: d.value, rationale: d.rationale })),
            yours: { value: candidate.value, rationale: candidate.rationale },
          },
          next: `Either adopt the existing value, or escalate to ${f.owner}. To override deliberately, record with layer "pm" and supersedes set to the decision you are replacing.`,
        });
      }

      appendDecision(candidate, DIR);
      return ok({ recorded: true, decision: candidate });
    }

    if (name === "binding_decisions") {
      let active = activeDecisions(readDecisions(DIR));
      if (a.kind) active = active.filter((d) => d.kind === a.kind);
      if (a.subject) {
        const q = normalizeSubject(String(a.subject));
        active = active.filter((d) => normalizeSubject(d.subject).includes(q) || q.includes(normalizeSubject(d.subject)));
      }
      return ok({
        count: active.length,
        decisions: active.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, value: d.value, by: `${d.author} (${d.layer})`, rationale: d.rationale })),
        note: "These are in force. Implement them as written; if one is wrong, say so rather than deviating silently.",
      });
    }

    if (name === "open_conflicts") {
      const result = detect(readDecisions(DIR));
      const live = reconcile(result.conflicts, readConflicts(DIR), DIR);
      const byId = new Map(live.map((c) => [c.id, c]));
      let out = result.conflicts.map((f) => {
        const stored = byId.get(conflictId(f));
        return {
          id: stored?.id, kind: f.kind, subject: f.subject,
          owner: stored?.owner ?? f.owner, attempts: stored?.attempts ?? 0,
          tried: stored?.notes ?? [], reason: f.reason,
          positions: f.decisions.map((d) => ({ by: `${d.author} (${d.layer})`, value: d.value, rationale: d.rationale })),
        };
      });
      if (a.owner) out = out.filter((c) => c.owner === a.owner);
      return ok({ count: out.length, conflicts: out });
    }

    if (name === "record_attempt") {
      const stored = readConflicts(DIR).find((c) => c.id === a.conflictId);
      if (!stored) throw new Error(`no conflict ${a.conflictId}`);
      const next = escalate({ ...stored, notes: [...stored.notes, String(a.note)] });
      writeConflict(next, DIR);
      return ok({
        conflictId: next.id, owner: next.owner, attempts: next.attempts,
        escalated: next.owner !== stored.owner,
        next: next.owner === "human" ? "A human has to rule on this. Stop and surface it." : `Now with ${next.owner}.`,
      });
    }

    if (name === "status") {
      const cs = readConflicts(DIR);
      const reached = cs.filter((c) => c.owner === "human").length;
      return ok({
        conflicts: cs.length,
        settledWithoutHuman: cs.length - reached,
        reachedHuman: reached,
        reachedHumanPct: cs.length ? Number(((reached / cs.length) * 100).toFixed(1)) : 0,
      });
    }

    /* ---------------- v0.2: the loop ---------------- */

    if (name === "write_contract") {
      let raw: unknown = a.contract;
      if (typeof raw === "string") {
        // Raised as a ContractError so a host that sent a malformed string
        // gets the schema back on the same footing as a structural problem.
        try { raw = JSON.parse(raw); } catch { throw new ContractError(["contract was sent as a string but is not valid JSON"]); }
      }
      const contract = validateContract(raw);
      const path = saveContract(contract, DIR);
      return ok({
        written: true,
        contract: contract.id,
        path,
        units: contract.units.map((u) => u.id),
        decisions: contract.decisions.length,
        acceptance: contract.acceptance.length,
        waves: waves(contract),
        next: "Call bind_contract to put its decisions in force, then brief_unit for each unit in the first wave.",
      });
    }

    if (name === "bind_contract") {
      const contract = contractArg(a);
      const active = activeDecisions(readDecisions(DIR));
      const author = (typeof a.as === "string" && a.as.trim()) || `contract:${contract.id}`;
      const bound: string[] = [];
      const refused: Record<string, unknown>[] = [];

      for (const d of contract.decisions) {
        const key = `${d.kind}::${normalizeSubject(d.subject)}`;
        const prior = active.find((x) => `${x.kind}::${normalizeSubject(x.subject)}` === key);
        const spec = kindSpec(d.kind);
        if (prior && spec.conflicts(spec.parse(prior.value), spec.parse(d.value))) {
          // Refuse rather than supersede: superseding a live decision stays a
          // deliberate, authored act, not something a new contract does on the way in.
          refused.push({
            subject: d.subject,
            contractSays: spec.render(spec.parse(d.value)),
            alreadyDecided: spec.render(spec.parse(prior.value)),
            by: `${prior.author} (${prior.layer})`,
            decisionId: prior.id,
          });
          continue;
        }
        if (prior) continue;
        appendDecision({
          id: nextId(readDecisions(DIR)), kind: d.kind, subject: d.subject, value: d.value,
          layer: "pm", author, rationale: d.rationale, supersedes: null, at: new Date().toISOString(),
        }, DIR);
        bound.push(d.subject);
      }

      return ok({
        contract: contract.id,
        bound,
        refused,
        next: refused.length
          ? "Each refusal is a real disagreement. Adopt the existing value, or record_decision at layer \"pm\" with supersedes set to the decision you are replacing."
          : "All binding decisions are in force. Brief the first wave.",
      });
    }

    if (name === "brief_unit") {
      const contract = contractArg(a);
      const unit = typeof a.unit === "string" ? a.unit.trim() : "";
      if (!contract.units.some((u) => u.id === unit)) {
        throw new Error(`no unit "${unit}" in "${contract.id}" — units are: ${contract.units.map((u) => u.id).join(", ")}`);
      }
      const brief = briefFor(contract, unit, activeDecisions(readDecisions(DIR)));
      return ok({
        ...brief,
        next: "Hand `instructions` to the worker verbatim, and nothing else from this contract.",
      });
    }

    if (name === "fleet_plan") {
      const contract = contractArg(a);
      const active = activeDecisions(readDecisions(DIR));
      return ok({
        contract: contract.id,
        waves: waves(contract).map((w, i) => ({ wave: i + 1, units: w.map((u) => briefFor(contract, u, active)) })),
        next: "Units within a wave run in parallel. Give each worker only its own brief.",
      });
    }

    if (name === "run_acceptance") {
      const contract = contractArg(a);
      const results = runAcceptance(contract);
      const failed = results.filter((r) => !r.passed);
      return ok({
        contract: contract.id,
        satisfied: failed.length === 0,
        passed: results.length - failed.length,
        total: results.length,
        results,
        note: "These are the commands the contract named. A criterion nobody can run is not evidence.",
      });
    }

    if (name === "generate_docs") {
      const contract = contractArg(a);
      const markdown = generateDocs(contract, readDecisions(DIR));
      if (typeof a.out === "string" && a.out.trim()) {
        writeFileSync(a.out, markdown, "utf8");
        return ok({ contract: contract.id, path: a.out, bytes: markdown.length });
      }
      return ok({ contract: contract.id, markdown });
    }

    if (name === "cost_report") {
      const contract = contractArg(a);
      const cpt = typeof a.charsPerToken === "number" && a.charsPerToken > 0 ? a.charsPerToken : 4;
      const rep = costReport(contract, activeDecisions(readDecisions(DIR)), cpt);
      return ok({
        ...rep,
        savedPct: Math.round((1 - rep.ratio) * 100),
        // The package measures bytes. Saying so next to every token figure is
        // the whole reason these numbers can be quoted at all.
        estimate: `Token figures are ESTIMATES: bytes divided by ${rep.charsPerToken} chars per token. No tokenizer ships with this package, so these are divisions, not counts.`,
      });
    }

    throw new Error(`Unknown tool "${name}"`);
  } catch (err) {
    // The validator collects every problem in one pass. Flattening it to a
    // single message would hand the caller one fix per round trip, which is
    // the cost the one-pass validator was written to avoid.
    if (err instanceof ContractError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: "contract is not valid", problems: err.problems, schema: SCHEMA }, null, 2) }],
      };
    }
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
});

await server.connect(new StdioServerTransport());
