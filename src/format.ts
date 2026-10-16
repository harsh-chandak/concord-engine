import { kindSpec } from "./compare.js";
import type { Finding, Override } from "./detect.js";
import type { Conflict, Decision } from "./types.js";

const isTty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code: string, s: string) => (isTty() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const red = (s: string) => c("38;5;203", s);
export const green = (s: string) => c("38;5;114", s);
export const amber = (s: string) => c("38;5;214", s);
export const blue = (s: string) => c("38;5;75", s);

export function banner(version: string): string {
  if (!isTty()) return "";
  return `\n  ${blue("▌")}${bold(" agentguard ")}${dim("v" + version)}\n  ${blue("▌")}${dim(" agents that can't contradict each other")}\n\n`;
}

/**
 * What reaches a human has to be a packet, not a transcript. Two decisions,
 * who made each, why, and what has already been tried — enough to rule on
 * without opening anything else.
 */
export function packet(f: Finding, stored?: Conflict): string {
  const spec = kindSpec(f.kind);
  const who = (d: Decision) => `${d.author} (${d.layer})`;
  const w = Math.max(...f.decisions.map((d) => who(d).length));
  const out: string[] = [];

  const id = stored ? stored.id : "";
  out.push(`  ${red("CONFLICT")} ${dim(id)}  ${bold(`${f.kind}: ${f.subject}`)}`);
  for (const d of f.decisions) {
    const why = d.rationale ? dim(`  "${d.rationale}"`) : "";
    out.push(`      ${who(d).padEnd(w)}  ${amber(spec.render(spec.parse(d.value)))}${why}`);
  }
  out.push("");
  if (stored?.notes.length) for (const n of stored.notes) out.push(`      ${dim("tried:")} ${n}`);
  // Whose turn it is comes from stored state, not from the fresh finding —
  // escalation has already moved it, and showing the original owner would send
  // the human looking for someone who has already given up.
  const owner = stored?.owner ?? f.owner;
  out.push(`      ${dim("owner:")} ${owner === "human" ? red("you") : owner}   ${dim(f.reason)}`);
  if (stored) out.push(`      ${dim(`attempts at this layer: ${stored.attempts}`)}`);
  out.push("");
  return out.join("\n");
}

export function overrideLine(o: Override): string {
  const names = o.overridden.map((d) => d.author).join(", ");
  return `  ${green("settled")}  ${o.subject}  ${dim(`— ${o.winner.author} (pm) overrode ${names}`)}`;
}

/**
 * Counted by OUTCOME, not by current owner. "Escalated to PM" must include
 * conflicts that passed through the PM and then moved on, or a conflict that
 * reached the human would report as though the PM never saw it.
 */
export function report(conflicts: Conflict[]): string {
  const total = conflicts.length;
  const sawPm = conflicts.filter((c) => c.owner === "pm" || c.owner === "human").length;
  const reached = conflicts.filter((c) => c.owner === "human").length;
  const resolved = conflicts.filter((c) => c.state === "resolved").length;
  const open = total - resolved;
  const pct = total ? ((reached / total) * 100).toFixed(1) : "0.0";
  return [
    "",
    `  ${bold(String(total))} ${total === 1 ? "conflict" : "conflicts"} recorded`,
    `    settled without you  ${String(total - reached).padStart(5)}`,
    `    reached the PM       ${String(sawPm).padStart(5)}`,
    `    reached you          ${String(reached).padStart(5)}   ${reached ? red(pct + "%") : green("0%")}`,
    "",
    `    still open           ${String(open).padStart(5)}`,
    `    resolved             ${String(resolved).padStart(5)}`,
    "",
    `  ${dim("Success is how rarely \"reached you\" is not zero.")}`,
    "",
  ].join("\n");
}
