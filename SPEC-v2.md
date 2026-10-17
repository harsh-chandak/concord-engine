# concord-engine v0.2 — the full loop

v0.1 shipped the gate: agents record typed decisions, and a decision that
contradicts one already in force is refused. That is one organ. This is the
body around it.

## The ask

> Anyone calling the package, skill or MCP server describes their task — a
> feature, a bug fix, a chore, anything. concord-engine fans out a development
> fleet and returns work that is finished, tested and documented, having first
> written a spec contract, and does it token-efficiently.

## The problem with building that

Every agent-orchestration project fans out workers. The fan-out is commodity:
a loop and a prompt. What nobody does is make the fleet's decisions **binding
on each other**, which is the organ v0.1 already is.

So the risk is not that this is hard to build. The risk is that it becomes
another orchestrator, and the one defensible sentence — *agreement is decided
by comparison, never by a model* — stops being true the moment the package
starts authoring specs with an LLM.

## The architectural commitment that resolves it

**The package never calls a model. Not once, anywhere.**

The host agent authors. The package defines the shape, validates it, binds it,
briefs the fleet, gates every decision, and verifies the result. Authoring is
a model call that happens *outside* the package, in the skill, in whatever
agent is driving.

Stated as a division:

| | authored by a model | decided by the package |
| --- | --- | --- |
| What the contract says | ✅ | |
| Whether the contract is well-formed | | ✅ |
| What each worker is told | | ✅ |
| The code each worker writes | ✅ | |
| Whether a decision contradicts one in force | | ✅ |
| Whether an acceptance criterion passed | | ✅ |
| What the design doc says | | ✅ (generated from the log) |

Every row on the right is a comparison, a schema check or a subprocess exit
code. The existing test that fails if any file in the decision path can reach
outside the process is extended to cover the new path.

## The loop

```
  describe a task
        |
        v
  [1] CONTRACT      host agent authors JSON to a published schema
        |           package validates it — shape, references, checks
        v
  [2] BIND          the contract's decisions enter the log at PM layer,
        |           binding before a line of code exists
        v
  [3] BRIEF         one brief per work unit: its slice, the decisions it
        |           must honour, and what it may not decide
        v
  [4] FAN OUT       the host spawns one worker per unit, each getting a
        |           brief and nothing else
        v
  [5] GATE          a worker that tries to decide something contradictory
        |           is refused, told what is in force and who may override
        v
  [6] VERIFY        every acceptance criterion carries a command; the run
        |           is not done until all of them exit 0
        v
  [7] DOCUMENT      the design doc is generated from the decision log —
        |           what was decided, by whom, and why
        v
  [8] ACCOUNT       what the fan-out cost, and the structural reason it is
                    cheaper than one agent holding the whole thing
```

## The contract

One JSON document, validated by the package.

```jsonc
{
  "id": "add-refunds",
  "goal": "one sentence a reviewer can judge the result against",
  "scope": { "in": ["..."], "out": ["..."] },
  "decisions": [                      // binding from t=0, PM layer
    { "kind": "api-contract", "subject": "refund endpoint",
      "value": { "method": "POST", "path": "/api/refunds", "status": 201 },
      "rationale": "why this and not the alternative" }
  ],
  "units": [                          // one worker each
    { "id": "api", "goal": "...", "files": ["src/api/**"],
      "mayDecide": ["convention"],    // everything else must be requested
      "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a1", "statement": "refunds endpoint returns 201",
      "check": "npm test -- refunds", "unit": "api" }
  ]
}
```

**Validation is not a formality.** A contract is rejected when a unit depends
on one that does not exist, when the dependency graph has a cycle, when an
acceptance criterion names no unit, when two decisions in the same contract
already contradict each other, or when a criterion has no check — because a
criterion without a command is a wish.

## Token efficiency, stated honestly

The saving is structural, not a trick: **a worker receives its brief, not the
conversation.** A brief is the unit's slice plus the decisions that bind it —
small, fixed, and identical across the run, so it caches. A transcript is
none of those things.

Two figures are worth stating, with their source, because they are the reason
to believe the structure helps: measured over 396 local Claude Code session
transcripts (580MB of JSONL, this machine, October 2026), subagents cost
roughly **5× less per turn** than the main thread, and cache writes were
**40.7% of input cost** at a 94.8% read rate.

**Those are observations about Claude Code, not measurements of this package,
and they must not appear in published material as product claims.** What the
package itself can measure is bytes, which is what `cost` reports.

`concord-engine cost` reports brief bytes against the whole-context baseline
and labels the result an **estimate**, because the package does not ship a
tokenizer and will not pretend to count what it cannot.

## In scope for v0.2

1. `spec --schema` / `spec --from <file>` — publish the shape, validate, store
2. `bind` — contract decisions into the log at PM layer
3. `brief <unit>` — the exact context one worker gets
4. `fleet` — every brief, as JSON, for programmatic fan-out
5. `accept` — run every acceptance check; exit non-zero on any failure
6. `docs` — design doc generated from the log
7. `cost` — brief bytes vs baseline, labelled an estimate
8. MCP tools for all of the above
9. The skill that drives the loop in Claude Code

## Explicitly out of scope

- **Spawning processes.** v0.2 emits briefs; the host spawns. A package that
  shells out to `claude -p` inherits that tool's auth, rate limits and failure
  modes, and stops being a library.
- **Writing the spec.** The package validates. The agent authors.
- **Measuring real tokens.** No tokenizer ships. Estimates are labelled.
- **Retrying failed workers.** The host owns the loop.

## Open questions

1. Should `accept` run checks in dependency order, or all at once? Starting
   with all at once, because a check that depends on ordering is a check with
   a hidden dependency.
2. Does `bind` refuse a contract whose decisions contradict the *existing* log,
   or supersede? Refuse. A new contract quietly overriding live decisions is
   the failure this tool exists to prevent.
3. How much of a brief is the files list? Starting with globs, not contents —
   the worker has a filesystem.
