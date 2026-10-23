#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { detect, escalate } from "./detect.js";
import { KIND_IDS, kindSpec, normalizeSubject } from "./compare.js";
import { appendDecision, readDecisions, nextId, activeDecisions, findContradiction, DEFAULT_DIR, resolveDir } from "./log.js";
import { SCHEMA, validateContract, saveContract, loadContract, briefFor, waves, declaredSubjects } from "./contract.js";
import { runAcceptance, generateDocs, costReport } from "./run.js";
import { conflictId, reconcile, readConflicts, writeConflict } from "./conflicts.js";
import { banner, packet, overrideLine, report, dim, green, red } from "./format.js";
import { extractRoutes, sourceFiles, verifyRoutes } from "./detectors/routes.js";
import type { Decision, Layer } from "./types.js";

const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const USAGE = `
concord-engine — agents that can't contradict each other.

  concord-engine decide --kind <kind> --subject "<what>" --value <v> --as <author>
      [--layer lead|pm] [--rationale "<why>"] [--supersedes <id>]

  concord-engine check          detect contradictions; exit 1 if any are open
  concord-engine conflicts      what is open, and whose turn it is
  concord-engine attempt <id>   record a failed resolution attempt; escalates on the 2nd
  concord-engine verify [path]  check api-contract decisions against the code
  concord-engine report         how often conflicts reached a human
  concord-engine kinds          the decision kinds and their value shapes

the loop — describe a task, run a fleet, finish with it proved and written up:

  concord-engine spec --schema          the contract shape your agent fills in
  concord-engine spec --from <f.json>   validate and store a contract
  concord-engine bind --contract <id>   make its decisions binding, at PM layer
  concord-engine fleet --contract <id>  the waves, and who can start now
  concord-engine brief --contract <id> <unit>
                                        exactly what one worker is told
  concord-engine accept --contract <id> run every acceptance check
  concord-engine docs --contract <id>   the design doc, from the log
  concord-engine cost --contract <id>   what the fan-out saved (estimated)

  --dir <path>   where the log lives (default ${DEFAULT_DIR}, or $CONCORD_ENGINE_DIR)
  --json         machine-readable output
  --version      print the version and exit

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

/** A contract id from --contract or the first positional after the command. */
function requireContract(values: { contract?: string }, positionals: string[]): string {
  const id = values.contract ?? positionals[1];
  if (!id) throw new Error("this command needs --contract <id> (see `concord-engine spec --from ...`)");
  return id;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" }, subject: { type: "string" }, value: { type: "string" },
      as: { type: "string" }, layer: { type: "string" }, rationale: { type: "string" },
      supersedes: { type: "string" }, note: { type: "string" },
      dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" }, force: { type: "boolean" },
      schema: { type: "boolean" }, from: { type: "string" }, contract: { type: "string" },
      "new-subject": { type: "boolean" },
      unit: { type: "string" }, out: { type: "string" },
    },
  });
  const cmd = positionals[0] ?? "help";
  const dir = resolveDir(values.dir);
  const quiet = Boolean(values.json) || !process.stdout.isTTY;
  const show = (s: string) => { if (!quiet) process.stdout.write(s); };

  if (values.version || cmd === "version") { console.log(VERSION); return 0; }

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

    // A unit may only settle the kinds its contract allows. Without this the
    // brief's promise — "if your work needs one of these, it will be refused"
    // — was false on the CLI path, and a worker could quietly write a kind it
    // had been told it could not.
    if (values.unit) {
      const c = loadContract(requireContract(values, positionals), dir);
      const unit = c.units.find((u) => u.id === values.unit);
      if (!unit) { console.error(`no unit "${values.unit}" in contract "${c.id}": ${c.units.map((u) => u.id).join(", ")}`); return 2; }
      // A subject the contract never named is how two workers describe one
      // thing two ways. The gate compares subjects by wording, so the second
      // spelling is simply a different decision and the disagreement between
      // them is never seen. Refusing here is the only deterministic fix —
      // matching subjects by similarity would put a judgement back in the
      // decision path.
      const declared = declaredSubjects(c);
      const key = `${values.kind}::${normalizeSubject(values.subject!)}`;
      if (!declared.has(key) && !values["new-subject"]) {
        const sameKind = [...declared.values()].filter((d) => d.kind === values.kind);
        console.error(`${red("refused")} "${values.subject}" is not a subject contract "${c.id}" declares.`);
        console.error(sameKind.length
          ? `  declared ${values.kind} subjects:\n${sameKind.map((d) => `    ${d.state === "open" ? "(open)    " : "(decided) "}${d.subject}`).join("\n")}`
          : `  the contract declares no ${values.kind} subjects at all.`);
        console.error(`\n  Reuse one of those lines verbatim, or if this really is new:`);
        console.error(`    --new-subject    (and tell whoever owns the contract to declare it)`);
        return 1;
      }
      if (!(unit.mayDecide ?? []).includes(values.kind as Decision["kind"])) {
        console.error(`${red("refused")} unit "${unit.id}" may not decide ${values.kind} on its own.`);
        console.error(`  it may decide: ${(unit.mayDecide ?? []).join(", ") || "nothing"}`);
        console.error(`  ask the layer above, or record it as that layer with --layer pm.`);
        return 1;
      }
    }

    // The gate, on the CLI path. The MCP server refused a contradicting
    // decision from the first release while `decide` recorded it silently, so
    // which interface you used decided whether the product's central promise
    // held. --force records anyway, for the deliberate case.
    // A deliberate override is the other way through, and it has to be a real
    // one: the id must already be in the log. That also stops a decision
    // naming the id it is about to be given, which superseded it out of force
    // the moment it was written — "recorded", exit 0, and not in force.
    if (values.supersedes && !all.some((d) => d.id === values.supersedes)) {
      console.error(`${red("refused")} --supersedes ${values.supersedes}: no decision has that id.`);
      console.error(`  \`concord-engine check --json\` lists the ids in force.`);
      return 1;
    }

    // An override replaces what it names, so that decision is no longer in
    // force to be contradicted. This is the same reading detect() takes
    // through activeDecisions(), which is why record_decision on the MCP side
    // never had this bug and `decide` did.
    const inForce = activeDecisions(all).filter((d) => d.id !== values.supersedes);
    const clash = findContradiction(inForce, values.kind as Decision["kind"], values.subject!, parseValue(values.value!));
    if (clash && !values.force) {
      const spec = kindSpec(values.kind as Decision["kind"]);
      console.error(`${red("refused")} this contradicts a decision already in force.`);
      console.error(`  ${clash.id}  ${clash.author} (${clash.layer}): ${clash.subject} = ${spec.render(spec.parse(clash.value))}`);
      if (clash.rationale) console.error(`  because: ${clash.rationale}`);
      console.error(`  yours:   ${spec.render(spec.parse(parseValue(values.value!)))}`);
      console.error(`\n  Adopt the existing value, or supersede it deliberately:`);
      console.error(`    --supersedes ${clash.id} --layer pm      (an override, recorded as one)`);
      console.error(`    --force                                  (record the disagreement for \`check\` to surface)`);
      return 1;
    }

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
    if (!id) { console.error("usage: concord-engine attempt <conflict-id> [--note \"what was tried\"]"); return 2; }
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


  /* ---------------- v0.2: the loop ---------------- */

  if (cmd === "spec") {
    if (values.schema) { console.log(JSON.stringify(SCHEMA, null, 2)); return 0; }
    const from = values.from ?? positionals[1];
    if (!from) { console.error("spec needs --schema, or --from <file.json>"); return 2; }
    const raw = from === "-" ? readFileSync(0, "utf8") : readFileSync(from, "utf8");
    const contract = validateContract(JSON.parse(raw));
    const path = saveContract(contract, dir);
    if (values.json) { console.log(JSON.stringify(contract, null, 2)); return 0; }
    show(banner(VERSION));
    console.log(`${green("contract accepted")}  ${contract.id}  ${dim(`-> ${path}`)}`);
    console.log(`  ${contract.units.length} units, ${contract.decisions.length} binding decisions, ${contract.acceptance.length} acceptance criteria`);
    console.log(`  waves: ${waves(contract).map((w) => w.join("+")).join(" -> ")}`);
    return 0;
  }

  if (cmd === "bind") {
    const contract = loadContract(requireContract(values, positionals), dir);
    const active = activeDecisions(readDecisions(dir));
    const author = values.as ?? `contract:${contract.id}`;
    const recorded: string[] = [];
    const refused: string[] = [];

    for (const d of contract.decisions) {
      const key = `${d.kind}::${normalizeSubject(d.subject)}`;
      const prior = active.find((x) => `${x.kind}::${normalizeSubject(x.subject)}` === key);
      const spec = kindSpec(d.kind);
      if (prior && spec.conflicts(spec.parse(prior.value), spec.parse(d.value))) {
        // A new contract silently overriding a live decision is the exact
        // failure this tool exists to prevent, so binding refuses rather
        // than supersedes. Superseding stays a deliberate, authored act.
        refused.push(`${d.subject}: contract says ${spec.render(spec.parse(d.value))}, ${prior.author} already decided ${spec.render(spec.parse(prior.value))} (${prior.id})`);
        continue;
      }
      if (prior) continue;
      appendDecision({
        id: nextId(readDecisions(dir)), kind: d.kind, subject: d.subject, value: d.value,
        layer: "pm", author, rationale: d.rationale, supersedes: null, at: new Date().toISOString(),
      }, dir);
      recorded.push(d.subject);
    }

    if (values.json) { console.log(JSON.stringify({ bound: recorded, refused }, null, 2)); return refused.length ? 1 : 0; }
    show(banner(VERSION));
    for (const r of recorded) console.log(`  ${green("bound")}    ${r}`);
    for (const r of refused) console.log(`  ${red("refused")}  ${r}`);
    console.log(`\n  ${recorded.length} bound, ${refused.length} refused`);
    return refused.length ? 1 : 0;
  }

  if (cmd === "brief") {
    const contract = loadContract(requireContract(values, positionals), dir);
    // Two call shapes: `brief --contract X unit` leaves the unit at
    // positionals[1]; `brief X unit` puts the contract there and the unit at
    // positionals[2]. Taking the last positional treated the command name
    // itself as a unit when neither was given.
    const unit = values.unit ?? (values.contract ? positionals[1] : positionals[2]);
    if (!unit) { console.error(`brief needs a unit: ${contract.units.map((u) => u.id).join(", ")}`); return 2; }
    const brief = briefFor(contract, unit, activeDecisions(readDecisions(dir)));
    console.log(values.json ? JSON.stringify(brief, null, 2) : brief.instructions);
    return 0;
  }

  if (cmd === "fleet") {
    const contract = loadContract(requireContract(values, positionals), dir);
    const active = activeDecisions(readDecisions(dir));
    const plan = waves(contract).map((w, i) => ({
      wave: i + 1,
      units: w.map((u) => briefFor(contract, u, active)),
    }));
    if (values.json) { console.log(JSON.stringify({ contract: contract.id, waves: plan }, null, 2)); return 0; }
    show(banner(VERSION));
    for (const w of plan) {
      console.log(`${dim(`wave ${w.wave}`)}  ${w.units.length} worker${w.units.length === 1 ? "" : "s"} in parallel`);
      for (const b of w.units) console.log(`    ${b.unit.padEnd(16)} ${dim(b.goal)}`);
    }
    console.log(`\n  ${dim("one brief per unit:")} concord-engine brief --contract ${contract.id} <unit>`);
    return 0;
  }

  if (cmd === "accept") {
    const contract = loadContract(requireContract(values, positionals), dir);
    const results = runAcceptance(contract);
    const failed = results.filter((r) => !r.passed);
    if (values.json) { console.log(JSON.stringify(results, null, 2)); return failed.length ? 1 : 0; }
    show(banner(VERSION));
    for (const r of results) {
      console.log(`  ${r.passed ? green("pass") : red("FAIL")}  ${r.id.padEnd(10)} ${r.statement} ${dim(`(${r.ms}ms)`)}`);
      if (!r.passed) console.log(`${dim(r.output.split("\n").map((l) => `          ${l}`).join("\n"))}`);
    }
    console.log(`\n  ${results.length - failed.length}/${results.length} criteria satisfied`);
    return failed.length ? 1 : 0;
  }

  if (cmd === "docs") {
    const contract = loadContract(requireContract(values, positionals), dir);
    const md = generateDocs(contract, readDecisions(dir));
    if (values.out) { writeFileSync(values.out, md, "utf8"); console.log(`${green("wrote")} ${values.out}`); return 0; }
    console.log(md);
    return 0;
  }

  if (cmd === "cost") {
    const contract = loadContract(requireContract(values, positionals), dir);
    const rep = costReport(contract, activeDecisions(readDecisions(dir)));
    if (values.json) { console.log(JSON.stringify(rep, null, 2)); return 0; }
    show(banner(VERSION));
    for (const l of rep.lines) {
      console.log(`  ${l.unit.padEnd(16)} ${String(l.briefBytes).padStart(6)} B brief   ${dim(`vs ${l.baselineBytes} B whole contract`)}`);
    }
    const pct = Math.round((1 - rep.ratio) * 100);
    console.log(pct >= 0
      ? `\n  ${rep.briefTotal} B sent instead of ${rep.baselineTotal} B — ${pct}% less`
      : `\n  ${rep.briefTotal} B sent against a ${rep.baselineTotal} B baseline — ${-pct}% MORE.\n  ${dim("A brief carries headings and standing instructions; on a contract this small they outweigh it.")}`);
    console.log(`  ${dim(`~${rep.estimatedBriefTokens} vs ~${rep.estimatedBaselineTokens} tokens, ESTIMATED at ${rep.charsPerToken} chars/token.`)}`);
    console.log(`  ${dim("No tokenizer ships with this package; these are divisions, not counts.")}`);
    return 0;
  }

  console.error(`Unknown command "${cmd}".`);
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => { console.error(`\nconcord-engine: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); },
);
