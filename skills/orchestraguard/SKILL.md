---
name: orchestraguard
description: Run a fleet of coding agents on one task without them contradicting each other. Use when a task is big enough to split across subagents, when asked to orchestrate, fan out, parallelize or run a PM/lead/worker hierarchy, when writing a spec contract for a multi-agent run, before recording a naming, convention, API-contract, enum or schema choice, before writing code that depends on one, and whenever two agents disagree. Also use when a fan-out is burning context and the workers need briefs instead of the whole conversation. Requires the orchestraguard MCP server.
---

# orchestraguard

In a hierarchy of agents, each layer can be locally correct while the product
is broken. The backend lead decides the identifier is `user_id`; the frontend
lead decides `userId`. Both are reasonable, both sets of workers implement them
faithfully, both pass their own tests, and the human finds out at integration.

orchestraguard holds those decisions and refuses to accept a contradicting one.
Around that gate it runs a loop: you author a contract, it validates, binds,
briefs, verifies and documents. **The package never calls a model.** You author;
it compares. That is why its answers are the same every time.

## The rule that makes this cheap

**Give each worker its brief. Not the contract, not the conversation.**

`orchestraguard brief --contract <id> <unit>` prints the exact text one worker
should receive: its goal, the files it owns, the decisions binding it, what it
may not decide, and what "done" means. Paste that into the subagent prompt and
stop there.

Two reasons, and the second is the important one:

1. A brief is small and fixed. The conversation is neither, and it grows for
   every worker you spawn after the first.
2. A worker that can read every other unit's goal will reason about them.
   Reasoning about work you were not given is how a fleet talks itself into a
   contradiction — the exact failure this tool exists to stop.

So: no transcript, no contract JSON, no "here's what the other agents are
doing." The brief already contains everything the worker is allowed to know.

## Who decides

**Leads and the PM decide. Workers write code and decide nothing.**

Contract decisions enter the log at PM layer before any code exists, so they
bind from t=0. A worker that hits something undecided calls `record_decision`
and gets refused if a decision already covers it. It does not pick a value and
move on.

## The loop

### 1. Author the contract

Get the shape first — do not guess it:

```bash
orchestraguard spec --schema
```

Write JSON to that schema. One document, six required keys:

```jsonc
{
  "id": "add-refunds",                  // kebab-case
  "goal": "one sentence a reviewer can judge the result against",
  "scope": { "in": ["..."], "out": ["what this run will not do"] },
  "decisions": [                        // binding from t=0, PM layer
    { "kind": "api-contract", "subject": "refund endpoint",
      "value": { "method": "POST", "path": "/api/refunds", "status": 201 },
      "rationale": "why this and not the alternative" }
  ],
  "units": [                            // one worker each
    { "id": "api", "goal": "...", "files": ["src/api/**"],
      "mayDecide": ["convention"],      // every other kind must be requested
      "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a1", "statement": "refunds endpoint returns 201",
      "check": "npm test -- refunds", "unit": "api" }
  ]
}
```

Write it as if nobody will explain it to the workers, because nobody will.

- **`decisions`** are the things two units could reasonably disagree about.
  Decide them now, with a rationale. Five kinds: `naming`, `convention`,
  `api-contract`, `enum`, `schema`.
- **`units`** must not overlap in `files`. Two workers editing one file is a
  merge conflict the tool cannot see.
- **`mayDecide`** is usually `[]`. Grant a kind only when one unit genuinely
  owns that call.
- **`dependsOn`** is for real ordering only. Every dependency serializes the
  fleet and costs you the parallelism you came for.
- **`acceptance`** needs a runnable command per criterion, and every unit needs
  at least one. A worker whose brief ends with a command it can run knows when
  to stop.

### 2. Validate and store

```bash
orchestraguard spec --from contract.json
```

Validation is not a formality. A contract is rejected when a unit depends on a
unit that does not exist, when the dependency graph has a cycle, when a
criterion names no unit or carries no command, when a unit has no criterion, or
when two of its own decisions already contradict each other. Every problem is
reported at once — fix them in one pass and re-run.

### 3. Bind

```bash
orchestraguard bind --contract add-refunds
```

The contract's decisions enter the log at PM layer. If one contradicts a
decision already live in the log, `bind` **refuses it and exits non-zero**. It
does not supersede. A new contract quietly overriding live decisions is the
failure this tool exists to prevent; superseding stays a deliberate, authored
act (see below).

Read what was refused. Either adopt the live value in the contract and re-run,
or override on purpose.

### 4. Plan the waves

```bash
orchestraguard fleet --contract add-refunds
```

Units that can run in parallel, grouped. Everything in wave 1 starts now;
wave 2 starts when wave 1 is done and accepted.

### 5. Fan out — one subagent per unit

For each unit in the wave:

```bash
orchestraguard brief --contract add-refunds api
```

Spawn one subagent and give it that output as its whole prompt. One unit, one
worker. Do not batch two units into one agent to save a spawn: they stop being
independently briefable, and the file ownership that keeps them apart stops
meaning anything.

Add nothing except the repo path and how to report back. If you find yourself
pasting the contract "for context", that is the token argument going out the
window.

### 6. Let the gate do its job

A worker that needs something undecided calls `record_decision`. If it is
refused, the response names the decision in force and who may override it. The
worker adopts the existing value. It does not rename the subject, pick a third
value, or record under a different author — those all defeat the check and put
the contradiction back into the code where nobody can see it.

Three ways out of a refusal, in order of how often they are right:

1. **Adopt the existing value.** Usually right. Someone already thought about it.
2. **Escalate.** The response names who resolves it. Hand them the packet.
3. **Override deliberately** — only as PM, only with `layer: "pm"` and
   `supersedes` set to the decision being replaced, and only with a rationale
   that says why the earlier one was wrong.

Call `open_conflicts` to see what is open and whose turn it is. If you try to
resolve one and fail, call `record_attempt` with an honest note. Two attempts
at a layer and it escalates automatically.

Write the note for the person above you. "Tried user_id, rejected" is useless.
"Proposed user_id; frontend-lead rejected because three call sites already ship
userId in the public API" lets them rule without re-deriving it.

### 7. Accept

```bash
orchestraguard accept --contract add-refunds
```

Runs every acceptance check and exits non-zero if any fail. All at once, not in
dependency order: a check that only passes after another check has a hidden
dependency, and hiding it in the runner is how it stays hidden.

A worker reporting "done" is a claim. This is the evidence. Do not advance a
wave on the claim.

### 8. Document

```bash
orchestraguard docs --contract add-refunds --out DESIGN.md
```

The design doc is generated from the decision log — what was decided, by whom,
and why. It cannot drift from what the gate enforced, because it is the same
data rendered.

### 9. Account

```bash
orchestraguard cost --contract add-refunds
```

Brief bytes against the whole-context baseline. Every token figure it prints is
labelled an **estimate** and states its chars-per-token assumption, because the
package measures bytes and ships no tokenizer. Report it the same way. Calling
bytes tokens would be exactly the unsourced number this project exists to
avoid.

## Flags

`--contract <id>` selects the contract for every loop command — same word
everywhere. `--json` gives machine-readable output on all of them, which is
what you want when you are driving the fan-out programmatically. `--dir <path>`
or `ORCHESTRAGUARD_DIR` moves the log and contract store off the default
`.orchestraguard/`.

## MCP tools

Same loop, if you are calling tools rather than the CLI: `write_contract`,
`bind_contract`, `brief_unit`, `fleet_plan`, `run_acceptance`, `generate_docs`,
`cost_report`, alongside the gate's `record_decision`, `binding_decisions`,
`open_conflicts`, `record_attempt` and `status`. No prefix on any of them.

## Reporting to a human

Give them the packet, not the transcript: the two positions, who holds each,
why, and what has already been tried. If you find yourself writing "see the
logs," you have not saved them anything.

`orchestraguard report` prints how often a conflict reached a human. That
number, not agents launched, is what says whether the fleet handled itself.

## What this is not

It does not spawn anything — it emits briefs and you spawn. It does not write
the contract; you author, it validates. It does not retry a failed worker. It
does not judge which of two decisions is better; it reports that both cannot
hold and who gets to rule. And no model is consulted anywhere in that path,
which is why the answer is the same every time.
