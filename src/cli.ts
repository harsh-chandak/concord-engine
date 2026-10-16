#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { detect, escalate } from "./detect.js";
import { KIND_IDS, kindSpec } from "./compare.js";
import { appendDecision, readDecisions, nextId, DEFAULT_DIR } from "./log.js";
import { conflictId, reconcile, readConflicts, writeConflict } from "./conflicts.js";
import { banner, packet, overrideLine, report, dim, green, red } from "./format.js";
import { extractRoutes, sourceFiles, verifyRoutes } from "./detectors/routes.js";
import type { Decision, Layer } from "./types.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const USAGE = `
orchestraguard — agents that can't contradict each other.

  orchestraguard decide --kind <kind> --subject "<what>" --value <v> --as <author>
      [--layer lead|pm] [--rationale "<why>"] [--supersedes <id>]

  orchestraguard check          detect contradictions; exit 1 if any are open
  orchestraguard conflicts      what is open, and whose turn it is
  orchestraguard attempt <id>   record a failed resolution attempt; escalates on the 2nd
  orchestraguard verify [path]  check api-contract decisions against the code
  orchestraguard report         how often conflicts reached a human
  orchestraguard kinds          the decision kinds and their value shapes

  --dir <path>   where the log lives (default ${DEFAULT_DIR})
  --json         machine-readable output

Decisions are issued by leads and the PM. Workers write code and issue none.
Contradiction is decided by comparison, never by a model.
`;

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { throw new Error(`--value looks like JSON but does not parse: ${t}`); }
  }
  return raw;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" }, subject: { type: "string" }, value: { type: "string" },
      as: { type: "string" }, layer: { type: "string" }, rationale: { type: "string" },
      supersedes: { type: "string" }, note: { type: "string" },
      dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "help";
  const dir = values.dir ?? DEFAULT_DIR;
  const quiet = Boolean(values.json) || !process.stdout.isTTY;
  const show = (s: string) => { if (!quiet) process.stdout.write(s); };

  if (values.help || cmd === "help") { show(banner(VERSION)); console.log(USAGE); return 0; }

  if (cmd === "kinds") {
    show(banner(VERSION));
    console.log("\n  kind           value shape\n  " + "-".repeat(58));
    const shapes: Record<string, string> = {
      naming: "a string",
      convention: "a string",
      "api-contract": '{"method":"POST","path":"/orders","status":201}',
      enum: '["pending","paid","shipped"]',
      schema: '{"field":"id","type":"uuid","nullable":false}',
    };
    for (const k of KIND_IDS) console.log(`  ${k.padEnd(15)}${shapes[k]}`);
    console.log("");
    return 0;
  }

  if (cmd === "decide") {
    for (const r of ["kind", "subject", "value", "as"] as const) {
      if (!values[r]) { console.error(`--${r} is required`); return 2; }
    }
    const layer = (values.layer ?? "lead") as Layer;
    if (layer !== "lead" && layer !== "pm") { console.error(`--layer must be lead or pm`); return 2; }
    const all = readDecisions(dir);
    const d: Decision = {
      id: nextId(all), kind: values.kind as Decision["kind"], subject: values.subject!,
      value: kindSpec(values.kind!).parse(parseValue(values.value!)),
      layer, author: values.as!, rationale: values.rationale,
      supersedes: values.supersedes ?? null, at: new Date().toISOString(),
    };
    appendDecision(d, dir);
    if (values.json) console.log(JSON.stringify(d, null, 2));
    else console.log(`${green("recorded")} ${d.id}  ${d.kind}: ${d.subject} = ${kindSpec(d.kind).render(d.value)}`);
    return 0;
  }

  if (cmd === "check" || cmd === "conflicts") {
    const all = readDecisions(dir);
    const result = detect(all);
    const live = reconcile(result.conflicts, readConflicts(dir), dir);
    const byId = new Map(live.map((c) => [c.id, c]));

    if (values.json) {
      console.log(JSON.stringify({ ...result, conflicts: result.conflicts.map((f, i) => ({ ...f, stored: live[i] })) }, null, 2));
      return result.conflicts.length ? 1 : 0;
    }

    show(banner(VERSION));
    if (cmd === "check" && result.overrides.length) {
      for (const o of result.overrides) console.log(overrideLine(o));
      console.log("");
    }
    if (!result.conflicts.length) {
      console.log(`  ${green("no contradictions")}  ${dim(`${result.decisionsConsidered} active decisions`)}\n`);
      return 0;
    }
    for (const f of result.conflicts) console.log(packet(f, byId.get(conflictId(f))));
    console.log(`  ${red(String(result.conflicts.length))} open ${result.conflicts.length === 1 ? "conflict" : "conflicts"}\n`);
    return 1;
  }

  if (cmd === "verify") {
    const root = positionals[1] ?? ".";
    const files = sourceFiles(root);
    const served = extractRoutes(files);
    const violations = verifyRoutes(readDecisions(dir), served);
    if (values.json) {
      console.log(JSON.stringify({ filesRead: files.length, routesFound: served.length, violations }, null, 2));
      return violations.length ? 1 : 0;
    }
    show(banner(VERSION));
    console.log(`  ${dim(`read ${files.length} files, found ${served.length} served routes`)}`);
    if (!violations.length) {
      console.log(`  ${green("every api-contract decision is served")}\n`);
      return 0;
    }
    console.log("");
    for (const v of violations) {
      console.log(`  ${red("NOT SERVED")}  ${v.expected}   ${dim(`decided by ${v.decision.author} (${v.decision.layer})`)}`);
      if (v.nearest) console.log(`              ${dim(`the path exists as ${v.nearest.method} at ${v.nearest.file}:${v.nearest.line}`)}`);
    }
    console.log(`\n  ${red(String(violations.length))} unserved ${violations.length === 1 ? "decision" : "decisions"}`);
    console.log(`  ${dim("static extraction only sees literal paths; a mounted prefix or a runtime path is invisible.")}\n`);
    return 1;
  }

  if (cmd === "attempt") {
    const id = positionals[1];
    if (!id) { console.error("usage: orchestraguard attempt <conflict-id> [--note \"what was tried\"]"); return 2; }
    const stored = readConflicts(dir).find((c) => c.id === id);
    if (!stored) { console.error(`no conflict ${id}`); return 2; }
    const noted = values.note ? { ...stored, notes: [...stored.notes, values.note] } : stored;
    const next = escalate(noted);
    writeConflict(next, dir);
    console.log(next.owner === stored.owner
      ? `${dim("recorded attempt")} ${next.attempts}/2 — still with ${next.owner}`
      : `${red("escalated")} ${id} to ${next.owner}`);
    return 0;
  }

  if (cmd === "report") {
    show(banner(VERSION));
    const conflicts = readConflicts(dir);
    if (values.json) { console.log(JSON.stringify(conflicts, null, 2)); return 0; }
    console.log(report(conflicts));
    return 0;
  }

  console.error(`Unknown command "${cmd}".`);
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => { console.error(`\norchestraguard: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); },
);
