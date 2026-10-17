# Concord Engine

**Scale parallelism. Preserve alignment.**

Describe a task. A fleet of agents builds it. They come back with work that is
finished, tested and documented — and that agrees with itself, because none of
them was allowed to contradict a decision another had already made.

Parallel agents don't scale past the human in the middle. You run five to go
faster, four of them are right, the product is broken, and the only thing that
catches it is you — reading everything, holding the whole picture,
re-explaining choices that were already settled.

That isn't a prompting problem. Your agents have **memory** and they have
**verification**, and neither answers the question that actually breaks a
parallel run:

> Did these two agents just settle the same question differently?

concord-engine answers it by comparison, never by a model, and refuses the
second answer at the moment it is written.

[![A real Claude Code session: a refunds feature is split across four workers, two of them settle the error format differently, and the second is refused with the decision already in force, who made it and why.](assets/brag.gif)](https://github.com/harsh-chandak/concord-engine/blob/main/assets/brag.gif)

<sub>Recorded, not drawn. `brag/record.mjs` runs the real CLI and captures its
output verbatim; `brag/video.html` only renders what was captured.</sub>

## What a decision is

This is the part that gets undersold. A "decision" is not a variable name. It
is **any question two agents could answer differently and both be reasonable** —
and the cost is never the question itself, it's that nothing goes red.

| Kind | Real examples |
| --- | --- |
| `convention` | money is integer minor units, never a float · timestamps are UTC ISO-8601 strings · pagination is cursor-based · every non-2xx body is `{"error":"<message>"}` · retries are idempotent and capped at 3 · migrations ship in two reversible stages |
| `api-contract` | `POST /api/orders` returns 201, not 200 · tenant scoping lives in the path, not a header |
| `enum` | order status is `pending\|paid\|shipped` · roles are `owner\|admin\|member` · webhook events are a closed set |
| `schema` | `id` is a uuid and not null · `amount_cents` is an integer · soft deletes use `deleted_at`, not a boolean |
| `naming` | the identifier is `user_id` · the destination field is `url`, not `target` |

Four agents implementing four reasonable answers to "what does an error body
look like" produce four green test suites and one broken product. That is the
whole category, and it is much wider than route paths.

## The failure it stops

A refunds feature, split across a backend worker and a client worker. The
backend settles the error shape. The client, working in parallel and with no
visibility into the backend's files, reaches a different answer:

```
$ concord-engine decide --unit client --kind convention \
    --subject "error response body shape" \
    --value 'every non-2xx body is {"code":"<slug>","detail":"<message>"}' --as client

refused this contradicts a decision already in force.
  d-003  api (lead): error response body shape = every non-2xx body is {"error":"<message>"}
  because: the client shows it to a person
  yours:   every non-2xx body is {"code":"<slug>","detail":"<message>"}

  Adopt the existing value, or supersede it deliberately:
    --supersedes d-003 --layer pm      (an override, recorded as one)
    --force                            (record the disagreement for `check` to surface)
```

<sub>Verbatim from the recording above.</sub>

The agent is stopped at the moment it tries to disagree, and told what is in
force, who decided it, why, and the two legitimate ways out. Not at
integration. Not by you.

## Three ways to run it

**As a skill, which is how most people will use it.** Describe the task; the
agent runs the whole loop — authors the contract, binds it, briefs each
worker, fans out, gates every decision, runs the acceptance checks, writes the
design doc.

```
/concord-engine:concord-engine add refunds across the API, the client and the schema
/concord-engine:concord-engine migrate us off the legacy auth tables, five workers
/concord-engine:concord-engine rename the tenant concept to workspace everywhere
```

Nothing about the task has to be small, and nothing has to be a route.

**As an MCP server**, so an agent already mid-task can reach the gate without
being handed a workflow. Twelve tools: `write_contract`, `bind_contract`,
`brief_unit`, `fleet_plan`, `run_acceptance`, `generate_docs`, `cost_report`,
plus `record_decision`, `binding_decisions`, `open_conflicts`,
`record_attempt`, `status`.

**As a CLI**, for humans and for CI. `concord-engine check` exits non-zero
when anything contradicts, which is a one-line pipeline step.

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

**concord-engine decides agreement by comparison, never by a model.** Decisions are
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
concord-engine spec --schema              # the contract shape, as JSON Schema
concord-engine spec --from contract.json  # validate and store it
concord-engine bind   --contract add-refunds
concord-engine fleet  --contract add-refunds            # every brief, as JSON
concord-engine brief  --contract add-refunds api        # one worker's brief
concord-engine accept --contract add-refunds            # run every check
concord-engine docs   --contract add-refunds
concord-engine cost   --contract add-refunds
```

Every loop command takes `--contract`. The MCP server exposes the same set as
`write_contract`, `bind_contract`, `brief_unit`, `fleet_plan`, `run_acceptance`,
`generate_docs` and `cost_report`.

## The contract

One JSON document. The agent writes it; the package decides whether it holds.

`openSubjects` is the part people skip and shouldn't. Naming a thing before
anyone decides it is what stops two workers inventing two different names for
it — see **Honest limits** for the run where that went wrong.

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
  "openSubjects": [                   // known to need deciding, not yet decided
    { "kind": "convention", "subject": "error response body shape",
      "note": "the server and the client both serialise this" }
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
$ concord-engine spec --from contract.json

concord-engine: contract is not valid:
  - unit "api" depends on "ui", which is not a unit in this contract
  - acceptance[a1] has no check — a criterion without a command is a wish
```

`bind` then puts the contract's decisions into the log at PM layer. If one of
them contradicts a decision already live, binding **refuses** — a new contract
quietly overriding decisions in force is the exact failure this tool exists to
prevent.

## What one worker gets

A brief, and not the conversation. This is the actual brief the unit that wrote
this file was given. Verbatim, abridged only where marked:

```
$ concord-engine brief --contract concord-engine-v2 readme

You are one worker on "concord-engine-v2". Your unit is "readme".

GOAL
  Rewrite README.md around the loop without losing the v0.1 pitch that the gate is the product.

FILES YOU OWN
  README.md
  Do not edit files outside this list. Another worker owns them.

DECISIONS ALREADY IN FORCE — these are not suggestions
  - [convention] model calls inside the package = no file in the package may call a model or open a network connection; enforced by a test  (the one defensible sentence is that agreement is decided by comparison, never by a model — if authoring moves inside the package that stops being true)
  - [naming] cli flag for selecting a contract = --contract  (every loop command takes it, so it has to be the same word everywhere)
  ... 3 more decisions in force

WHAT YOU MAY DECIDE
  nothing — you write code and decide nothing

WHAT YOU MUST NOT DECIDE ALONE
  naming, convention, api-contract, enum, schema

RECORD A DECISION LIKE THIS — the flags are what enforce the two lists above
  concord-engine decide --contract concord-engine-v2 --unit readme \
    --kind <kind> --subject "<what>" --value '<value>' --as readme --rationale "<why>"

  Omitting --unit skips the check on what you may decide. Use the MCP tool
  record_decision if you have it; it gates the same way.
  A refusal means a decision already covers this: adopt the existing value.
  Do not work around it, and do not --force it.

DONE MEANS
  [a-readme] the README covers the loop and keeps the gate pitch
       $ test -f README.md && grep -q 'spec --schema' README.md && grep -q 'refus' README.md && grep -q -i 'estimate' README.md
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
claude plugin install concord-engine@harsh-chandak
```

<sub>The `harsh-chandak` marketplace is hosted in the shadowjoin repo and carries
both tools — that first line is not a typo.</sub>

Then describe the work and let it run the loop:

```
/concord-engine:concord-engine add refunds across the API, the client and the schema
```

Or without Claude Code:

```bash
npx concord-engine --help
```

## Use

Leads and the PM decide. **Workers write code and decide nothing.**

```bash
# a decision, gated: --unit enforces what this unit is allowed to settle,
# and the subject must be one the contract declares
concord-engine decide --contract add-refunds --unit api \
  --kind convention --subject "error response body shape" \
  --value 'every non-2xx body is {"error":"<message>"}' \
  --as api --rationale "the client shows it to a person"

concord-engine check     # exits 1 if anything contradicts
concord-engine verify    # are the decided routes actually served?
concord-engine report    # how often did a conflict reach you?
```

Outside a contract, `decide` still refuses a decision that contradicts one in
force — it just cannot check what a unit was allowed to settle, because
without `--unit` there is nothing that says.

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

`.concord-engine/decisions.jsonl`, in the working directory — append-only JSON
Lines, one decision per line, no parser needed to read it. Contracts sit beside
it in `.concord-engine/contracts/`.

**Commit it.** The log is the contract between your agents, so it has to travel
with the code the way a migration does. Set `CONCORD_ENGINE_DIR` or pass
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
$ concord-engine report

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
this repo's own contract — five units, five binding decisions. Reproduce it
by cloning and running the same command:

```
$ concord-engine cost --contract concord-engine-v2
  mcp                2333 B brief   vs 4132 B whole contract
  skill              2470 B brief   vs 4132 B whole contract
  tests              2286 B brief   vs 4132 B whole contract
  readme             2297 B brief   vs 4132 B whole contract
  e2e                2214 B brief   vs 4132 B whole contract

  11600 B sent instead of 20660 B — 44% less
  ~2900 vs ~5165 tokens, ESTIMATED at 4 chars/token.
  No tokenizer ships with this package; these are divisions, not counts.
```

Every token figure it prints is labelled an estimate and states the
chars-per-token assumption behind it. The baseline is the whole contract per
worker, not your real session — your actual saving is larger, and this tool
will not guess by how much.

## A worked example

`examples/linkfold.contract.json` is the contract from the run this README
keeps citing: a URL shortener built by four workers who never saw each other's
code, which came out working — 55 tests and a real HTTP round trip between
three units that agreed on a wire format they never discussed.

It carries the `openSubjects` the original run was missing, which is why that
run settled the error format twice under two names. CI revalidates it on every
push.

```bash
concord-engine spec --from examples/linkfold.contract.json
concord-engine fleet --contract linkfold
concord-engine brief --contract linkfold api
```

## Honest limits

- **Only what's recorded is checked.** A lead who decides something in prose and
  never records it is invisible to this.
- **Subjects are matched by wording, not by meaning.** Case, punctuation and
  accents are normalised, so "User Identifier" and "user identifier" collide.
  Two agents who describe the same thing in genuinely different words do not.
  This is the tool's sharpest edge, and it is not theoretical: on the first
  run of this loop against another project, two workers settled the error
  format under "error response body shape" and "api error response body",
  chose incompatible payloads, and `check` reported no contradiction because
  it never compared them.

  The mitigation is `openSubjects`: name the thing in the contract before
  anyone decides it, and `decide --contract <id> --unit <id>` refuses a
  subject the contract never declared, offering the declared spelling instead.
  That makes subject identity a lookup rather than a guess. Matching subjects
  by similarity would close the gap too, and would put a judgement back in the
  decision path — which is the one thing this package will not do.

  The residual risk is real: a decision recorded without `--contract`, or with
  `--new-subject`, is matched by wording again.
- **`verify` only recognises Express-shaped registrations.** It looks for
  `app`/`router`/`server`/`api` followed by a method call, plus FastAPI and
  Flask decorators. A plain `node:http` server that switches on
  `req.url` serves routes it cannot see. Broadening the pattern to any
  identifier would make `cache.get("key")` look like a route, so it stays
  narrow and under-reports.
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
- **A worker can still bypass the gate.** `decide` without `--unit` skips the
  check on what that unit may decide, and `--force` records a contradiction
  deliberately. Both are visible in the log, and `report` counts them. The
  gate is a guardrail, not a sandbox.
- **Five kinds, deliberately.** `dependency` is deferred until semver range
  intersection is implemented properly; a comparator that calls `^1.0.0` and
  `^1.2.0` incompatible would be worse than not having it.

## License

MIT © Harsh N. Chandak
