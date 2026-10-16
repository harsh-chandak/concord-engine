# orchestraguard

**Agent orchestration never drifts.**

Parallel agents don't scale past the human in the middle.

You run five agents to go faster. Four of them are right. The product is broken,
and the only thing that catches it is you — reading everything, holding the
whole picture, re-explaining decisions that were already made.

That's not a prompting problem. Your agents have **memory** and they have
**verification**, and neither one answers the question that actually breaks a
parallel run:

> Did these two agents just decide incompatible things?

orchestraguard answers it, and refuses the second decision.

[![Two leads decide the same field differently inside one Claude Code session. The second decision is refused, the PM overrides, and both leads build the same thing.](assets/brag.gif)](https://github.com/harsh-chandak/orchestraguard/blob/main/assets/brag.mp4)

## The failure it stops

Your backend lead decides the identifier is `user_id`. Your frontend lead,
working in parallel, decides `userId`.

Both are defensible. Both sets of workers implement them faithfully. Both pass
their own tests. Nothing is red. You find out at integration — because *you*
noticed.

```
● frontend-lead · record_decision
    naming: User Identifier in API Payloads = userId

    ✗ REFUSED — contradicts a decision already in force
        existing   user_id   backend-lead (lead)
                   "matches the users table column"
        resolve by pm
```

The agent is stopped at the moment it tries to disagree. Not at integration.
Not by you.

## Why this isn't another memory tool

| Tool | Answers | Doesn't answer |
| --- | --- | --- |
| Handoff / memory tools | "what did the last agent know?" | "do these two agree?" |
| Orchestrator verification | "did this worker do its task?" | "do these two agree?" |
| Edit-conflict detection | "did two agents touch one file?" | "do these two agree?" |

And the obvious way to answer it — store decisions as prose, ask a model whether
two of them conflict — is slow, costs a call per check, and is wrong often
enough that people stop trusting it. A coordination layer nobody trusts is
worse than none, because it adds latency and false alarms to a workflow that
had neither.

**orchestraguard decides agreement by comparison, never by a model.** Decisions are
typed and narrow, so a contradiction is a comparison: same subject, different
value. No API call exists anywhere in the decision path — there's a test that
fails if any file in that path can reach outside the process, and a second one
that fails if any file in the package, anywhere, calls a model.

## The loop

The gate above is one organ. v0.2 is the body around it: you describe a task,
and the fleet that builds it is bound to one set of decisions from before the
first line of code.

```
  describe a task
        |
   [1]  CONTRACT     the agent authors JSON to a published schema;
        |            the package validates it and stores it
        v
   [2]  BIND         the contract's decisions enter the log at PM layer,
        |            binding before any code exists
        v
   [3]  BRIEF        one brief per unit: its slice, the decisions it must
        |            honour, what it may not decide, how it will be judged
        v
   [4]  FAN OUT      the host spawns one worker per unit, each getting a
        |            brief and nothing else
        v
   [5]  GATE         a worker that tries to decide something contradictory
        |            is refused, told what is in force and who may override
        v
   [6]  ACCEPT       every acceptance criterion carries a command; the run
        |            is not done until all of them exit 0
        v
   [7]  DOCS         the design doc is generated from the decision log —
        |            what was decided, by whom, and why
        v
   [8]  COST         what the fan-out sent, in bytes
```

```bash
orchestraguard spec --schema              # the contract shape, as JSON Schema
orchestraguard spec --from contract.json  # validate and store it
orchestraguard bind   --contract add-refunds
orchestraguard fleet  --contract add-refunds            # every brief, as JSON
orchestraguard brief  --contract add-refunds api        # one worker's brief
orchestraguard accept --contract add-refunds            # run every check
orchestraguard docs   --contract add-refunds
orchestraguard cost   --contract add-refunds
```

Every loop command takes `--contract`. The MCP server exposes the same set as
`write_contract`, `bind_contract`, `brief_unit`, `fleet_plan`, `run_acceptance`,
`generate_docs` and `cost_report`.

## The contract

One JSON document. The agent writes it; the package decides whether it holds.

```jsonc
{
  "id": "add-refunds",
  "goal": "one sentence a reviewer can judge the result against",
  "scope": { "in": ["..."], "out": ["..."] },
  "decisions": [                      // binding from t=0, at PM layer
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

Validation is not a formality. A contract is rejected when two of its own
decisions contradict each other, when a unit depends on one that doesn't exist,
when the dependency graph has a cycle, when a unit has no acceptance criterion,
or when a criterion has no command. All of it in one pass, because fixing one
error per round trip is the expensive way to find four:

```
$ orchestraguard spec --from contract.json

orchestraguard: contract is not valid:
  - unit "api" depends on "ui", which is not a unit in this contract
  - acceptance[a1] has no check — a criterion without a command is a wish
```

`bind` then puts the contract's decisions into the log at PM layer. If one of
them contradicts a decision already live, binding **refuses** — a new contract
quietly overriding decisions in force is the exact failure this tool exists to
prevent.

## What one worker gets

A brief, and not the conversation. This is the actual brief the unit that wrote
this file was given, abridged where marked and rewrapped to fit:

```
$ orchestraguard brief --contract orchestraguard-v2 readme

You are one worker on "orchestraguard-v2". Your unit is "readme".

GOAL
  Rewrite README.md around the loop without losing the v0.1 pitch that the
  gate is the product.

FILES YOU OWN
  README.md
  Do not edit files outside this list. Another worker owns them.

DECISIONS ALREADY IN FORCE — these are not suggestions
  - [naming] cli command that runs acceptance checks = accept  (verify already
    means route verification in v0.1 and renaming it would break installed users)
  - [convention] how token figures are presented = every token figure is
    labelled an estimate and states its chars-per-token assumption  (the package
    measures bytes; calling bytes tokens would be the kind of unsourced number
    this project exists to avoid)
  ...

WHAT YOU MAY DECIDE
  nothing — you write code and decide nothing

WHAT YOU MUST NOT DECIDE ALONE
  naming, convention, api-contract, enum, schema
  If your work requires one of these, call record_decision. If it is refused,
  a decision already covers it: adopt the existing value, do not work around it.

DONE MEANS
  [a-readme] the README covers the loop and keeps the gate pitch
       $ grep -q 'loop' README.md && grep -q 'refus' README.md
```

`fleet` prints all of them at once, grouped into waves by `dependsOn`, so the
host knows what it can run in parallel.

## What the package decides, and what it doesn't

**The package never calls a model.** The agent authors; the host spawns; the
package decides everything that can be decided by comparison.

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
code. Two tests enforce the split: nothing in the decision path may leave the
process by any means, and no file anywhere — including `accept`, which exists
to spawn subprocesses — may reach a model.

This is the differentiator, not a gap. Fan-out is a loop and a prompt; every
orchestrator has one. What nobody does is make the fleet's decisions binding on
each other, and that only stays trustworthy while no model is in the path.

## Install

```bash
claude plugin marketplace add harsh-chandak/shadowjoin
claude plugin install orchestraguard@harsh-chandak
```

<sub>The `harsh-chandak` marketplace is hosted in the shadowjoin repo and carries
both tools — that first line is not a typo.</sub>

Or without Claude Code:

```bash
npx orchestraguard --help
```

## Use

Leads and the PM decide. **Workers write code and decide nothing.**

```bash
orchestraguard decide --kind naming \
  --subject "user identifier in API payloads" \
  --value user_id --as backend-lead \
  --rationale "matches the users table column"

orchestraguard check     # exits 1 if anything contradicts
orchestraguard verify    # are the decided routes actually served?
orchestraguard report    # how often did a conflict reach you?
```

`verify` means route verification, as it did in v0.1. Acceptance criteria are
run by `accept`.

Five kinds, each with its own comparison rule:

| kind | value | compared by |
| --- | --- | --- |
| `naming` | `"user_id"` | exact |
| `convention` | `"snake_case in payloads"` | exact |
| `api-contract` | `{"method":"POST","path":"/orders","status":201}` | structurally, ignoring trailing slashes and param naming |
| `enum` | `["pending","paid","shipped"]` | set equality |
| `schema` | `{"field":"id","type":"uuid","nullable":false}` | structurally |

## Where the log lives

`.orchestraguard/decisions.jsonl`, in the working directory — append-only JSON
Lines, one decision per line, no parser needed to read it. Contracts sit beside
it in `.orchestraguard/contracts/`.

**Commit it.** The log is the contract between your agents, so it has to travel
with the code the way a migration does. Set `ORCHESTRAGUARD_DIR` or pass
`--dir` to put it elsewhere; the CLI and the MCP server resolve the location
the same way, so `check` always audits the file the server writes.

## Who resolves what

```
worker vs worker   ->  team lead
lead   vs lead     ->  PM
PM can't resolve   ->  you
```

Adjudication is read off the hierarchy, not judged. A PM decision overrides a
lead's — that's an override, not a conflict. Two leads who disagree go to the
PM. Two PMs who disagree reach you, because nothing outranks them.

Two attempts at a layer, then it escalates. What reaches you is a packet — both
positions, who holds each, why, and what has already been tried:

```
CONFLICT c-01fc0217  naming: user identifier in API payloads
    backend-lead (lead)   user_id  "matches the users table column"
    frontend-lead (lead)  userId   "matches the TypeScript style guide"

    tried: proposed user_id; frontend-lead rejected, 3 call sites already public
    tried: proposed an alias field; rejected as duplication
    owner: you
```

Not "something went wrong, go read the logs."

## The design doc nobody writes

`docs` renders the run from the decision log: the goal, what was in and out of
scope, every decision in force with its author, timestamp and rationale, and a
table of the commands that proved the work. It is generated, so it can't drift
from what was actually decided — and it's the first design doc that costs
nothing to keep current, because nobody writes it.

## The number that matters

```
$ orchestraguard report

  47 conflicts recorded
    settled without you     44
    reached the PM          11
    reached you              3   6.4%
```

Every other orchestrator reports agents launched, tokens spent, tasks
completed. None of them reports whether the system handled itself — which is
the only number that says whether running ten agents actually cost you less
than running one.

## What the fan-out cost

The saving is structural, not a trick: **a worker receives its brief, not the
conversation.** A brief is one unit's slice plus the decisions that bind it —
small, fixed, and identical across the run. A transcript is none of those
things.

The package measures **bytes**, because bytes are what it can count. Run on
this repo's own v0.2 contract — five units, five binding decisions:

```
$ orchestraguard cost --contract orchestraguard-v2

  mcp                2007 B brief   vs 3847 B whole contract
  skill              2009 B brief   vs 3847 B whole contract
  tests              1895 B brief   vs 3847 B whole contract
  readme             1900 B brief   vs 3847 B whole contract
  e2e                1860 B brief   vs 3847 B whole contract

  9671 B sent instead of 19235 B — 50% less
  ~2418 vs ~4809 tokens, ESTIMATED at 4 chars/token.
  No tokenizer ships with this package; these are divisions, not counts.
```

Every token figure it prints is labelled an estimate and states the
chars-per-token assumption behind it. The baseline is the whole contract per
worker, not your real session — your actual saving is larger, and this tool
will not guess by how much.

## Honest limits

- **Only what's recorded is checked.** A lead who decides something in prose and
  never records it is invisible to this.
- **Subjects are matched loosely** — case, punctuation and accents are
  normalised, so "User Identifier" and "user identifier" collide. Two leads who
  describe the same thing in genuinely different words still won't. That's a
  real miss.
- **`verify` reads literal paths only.** A router mounted under a prefix, or a
  path built at runtime, is invisible to static extraction. It under-reports
  rather than accusing falsely, and prints how many files it read so the number
  isn't mistaken for completeness.
- **It doesn't spawn workers.** `fleet` emits briefs; your host spawns. A package
  that shells out to another agent CLI inherits that tool's auth, rate limits
  and failure modes, and stops being a library.
- **It doesn't write the contract.** Authoring is a model call, and model calls
  happen outside the package.
- **It doesn't count tokens.** No tokenizer ships. Bytes are measured; tokens are
  divided and labelled.
- **It doesn't verify the work was done.** `accept` runs the commands the
  contract named. If the contract named weak commands, it will pass.
- **It doesn't judge which decision is better.** It reports that two can't both
  hold, and who gets to rule.
- **Five kinds, deliberately.** `dependency` is deferred until semver range
  intersection is implemented properly; a comparator that calls `^1.0.0` and
  `^1.2.0` incompatible would be worse than not having it.

## License

MIT © Harsh N. Chandak
