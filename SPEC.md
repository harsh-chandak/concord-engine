# agentguard — spec

**Agents that can't contradict each other.**

Status: draft, 2026-10-16. Nothing here is built yet.

---

## The problem

A hierarchy of coding agents — PM delegates to team leads, leads delegate to
workers — drifts apart. Each layer is locally correct and the product is still
broken:

- The backend lead decides the identifier is `user_id`. The frontend lead,
  working in parallel, decides `userId`. Both decisions are reasonable. Both
  sets of workers implement them faithfully. Both pass their own verification.
- A worker is told to return `201` on create and returns `200`. Its tests pass,
  because it wrote the tests.

Nobody catches either, because every check only sees one side. The human catches
them, which is why the human is in the loop constantly and spends the day
re-explaining things that were already decided.

## What exists, and why it doesn't cover this

| Tool | Does | Doesn't |
| --- | --- | --- |
| OpenHandoff, carrot-handoff, ai-memory, myc, catchup, hermes | carry context between agents | tell you two agents disagree |
| Sol-Luna | supervisor re-runs verification instead of trusting a worker's PASS | hold decisions across workers |
| STORM | detects conflicting *edits* at write time | detects conflicting *decisions* |
| Spec Kit `/speckit.analyze` | checks spec, plan and tasks agree with each other | checks code against any of them |

Memory is storage. Verification asks "did you do the task." Neither asks
**"did these two agents just decide incompatible things."**

## The differentiator

**Agreement is decided by rules, not by a model.**

The obvious build stores decisions as prose and asks an LLM whether two of them
conflict. That is slow, costs a call per check, and is wrong often enough that
people stop trusting the answer — at which point the tool is worse than nothing,
because it adds latency and false alarms to a workflow that already had neither.

agentguard makes decisions typed and narrow, so a contradiction is a comparison.
Deterministic, no model call, same answer every time.

---

## Model

### Decision

Issued by a **lead** or the **PM**. Never by a worker — workers write code.

```yaml
id: d-014
kind: naming                       # one of a fixed set, see Kinds
subject: user identifier in API payloads
value: user_id
layer: lead                        # lead | pm
author: backend-lead
rationale: matches the column name in the users table
supersedes: null
at: 2026-10-16T09:14:22Z
```

`subject` is the key. Two decisions with the same `subject` and different
`value` are a contradiction. Everything else is metadata for the human who
eventually reads it.

### Kinds

A fixed, small set. Each kind defines how `value` is compared, so comparison
never falls back to free text.

| kind | value shape | compared by |
| --- | --- | --- |
| `naming` | string | exact |
| `api-contract` | `{method, path, status}` | structural |
| `enum` | list of strings | set equality |
| `schema` | `{field, type, nullable}` | structural |
| `dependency` | `{name, version-range}` | semver intersection non-empty |
| `convention` | string | exact |

Anything that doesn't fit a kind is not a decision. That is deliberate: the
value of the log comes from everything in it being checkable.

### Precedence

PM decision beats lead decision. Lead decision binds that lead's workers.
Workers issue none. Precedence is read off the layer, so adjudication needs no
judgement.

### Supersession

A decision is never silently overwritten. A new decision names the one it
replaces and carries a rationale. The old one stays in the log, marked
superseded. One bad lead call must be reversible, and the reversal must be
visible.

---

## The two checks

### Horizontal — decision vs decision

Two decisions, same `subject`, different `value`, neither superseding the
other → **contradiction**. Few writers, large blast radius: a lead's decision
reaches every worker under it.

### Vertical — decision vs code

A decision that reached the code can be checked against it. This is where
detectors live:

- `api-contract` → the route exists in the server and is called that way by the
  client
- `naming` → the field name appears as decided
- `enum` → the set in the code matches the set decided

Vertical failures are **non-compliance**, not contradiction: the worker was
given an instruction and did something else.

Detectors are pluggable. v1 ships one.

---

## Escalation

Resolution happens at the layer above the conflict.

```
worker vs worker   ->  team lead
lead   vs lead     ->  PM
PM cannot resolve  ->  human
```

**Two attempts, then up.** An agent asked to resolve will keep trying and burn
tokens; the budget is what stops a deadlock moving one layer up instead of
being solved.

**A resolution is written back as a decision** at the resolving layer. Without
that step the same conflict re-escalates forever, and the tool becomes an
efficient way to interrupt yourself.

**What reaches the human is a packet, not a transcript**:

```
CONFLICT c-007   naming: user identifier in API payloads
  backend-lead   user_id    "matches the users table column"
  frontend-lead  userId     "matches the TypeScript style guide"

  PM attempted: proposed user_id, frontend-lead rejected (3 call sites already
  shipped with userId in the public API)

  needs: a ruling
```

If escalation means "go read the logs," nothing has been saved.

---

## The metric

The complaint this exists to fix is *too much human in the loop*. So the product
reports how rarely it needed you:

```
this week: 47 conflicts
  resolved by leads     38
  escalated to PM        6
  reached you            3   (6.4%)
```

Measurable, comparable week to week, and checkable before and after adopting the
tool. No other orchestrator reports this — they report agents launched, tokens
spent, tasks completed. None of those say whether the system handled itself.

---

## Shape

Files in the repo. No service, no daemon, no account. Works with Claude Code
subagents, Codex, Copilot or a hand-rolled loop, because the integration surface
is a CLI and a directory:

```
.agentguard/
  decisions.yaml      # append-only, superseded entries retained
  conflicts.yaml      # open conflicts and their escalation state
```

```bash
agentguard decide --kind naming --subject "..." --value user_id --as backend-lead
agentguard check                 # horizontal + vertical, exit non-zero on conflict
agentguard conflicts             # what is open and whose turn it is
agentguard report                # the metric
```

## v1 scope

In:

- decision schema, the six kinds, append-only log with supersession
- horizontal contradiction detection (deterministic)
- escalation state machine with the two-attempt budget
- the packet format
- `agentguard report`
- one vertical detector: `api-contract`, server-side routes for Express and
  FastAPI

Out, deliberately:

- any LLM call anywhere in the decision path
- agent-side integration beyond the CLI
- a UI
- the other five detectors

## Open questions

1. How does a worker *read* the decisions that bind it — full log injected, or
   a query by subject? Full log is simpler and probably small enough; needs a
   size measurement on a real feature before committing.
2. Does `subject` need to be a controlled vocabulary, or is free text plus exact
   match enough? Free text risks two leads describing the same subject
   differently and never colliding — a silent miss, which is the exact failure
   class this tool exists to catch.
3. Who runs `agentguard check` — a hook, the orchestrator, or CI? Probably all three,
   but the default matters.

Question 2 is the one that decides whether this works.
