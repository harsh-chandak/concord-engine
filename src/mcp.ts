#!/usr/bin/env node
/**
 * orchestraguard MCP server.
 *
 * The important behaviour is that `record_decision` REFUSES a decision that
 * contradicts one already in force, and returns the conflict instead. The
 * agent is stopped at the moment it tries to disagree, rather than told
 * afterwards by a human who had to notice.
 *
 * Nothing here calls a model. Agreement is a comparison.
 */
import { createRequire } from "node:module";
import { detect, escalate } from "./detect.js";
import { KIND_IDS, kindSpec, normalizeSubject } from "./compare.js";
import { appendDecision, readDecisions, nextId, activeDecisions, DEFAULT_DIR } from "./log.js";
import { conflictId, reconcile, readConflicts, writeConflict } from "./conflicts.js";
import type { Decision, Layer } from "./types.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;
const DIR = process.env.ORCHESTRAGUARD_DIR ?? DEFAULT_DIR;

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
      "orchestraguard-mcp needs @modelcontextprotocol/sdk, an optional peer dependency.\n" +
        "Run it with the SDK provided:\n" +
        "  npx -y -p orchestraguard -p @modelcontextprotocol/sdk orchestraguard-mcp\n" +
        "or install it alongside orchestraguard:\n" +
        "  npm i orchestraguard @modelcontextprotocol/sdk\n",
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
];

const { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = await loadSdk();
const server = new Server({ name: "orchestraguard", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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

    throw new Error(`Unknown tool "${name}"`);
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
});

await server.connect(new StdioServerTransport());
