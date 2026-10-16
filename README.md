# agentguard

**Agents that can't contradict each other.**

Your backend lead decides the identifier is `user_id`. Your frontend lead,
working in parallel, decides `userId`.

Both are reasonable. Both sets of workers implement them faithfully. Both pass
their own tests. Nothing is red. You find out at integration, and you find out
because *you* noticed — which is why you're in the loop all day re-explaining
things that were already decided.

agentguard holds the decisions your leads make and **refuses to accept one that
contradicts another**.

```
$ agentguard check

  CONFLICT c-01fc0217  naming: user identifier in API payloads
      backend-lead (lead)   user_id  "matches the users table column"
      frontend-lead (lead)  userId   "matches the TypeScript style guide"

      owner: pm   leads disagree; resolution belongs to the layer above
```

## Why this isn't another memory tool

Handoff and memory tools carry context between agents. Orchestrators verify a
worker did its task. Neither can answer **"did these two agents just decide
incompatible things?"**

And the obvious way to answer it — store decisions as prose, ask a model
whether two of them conflict — is slow, costs a call per check, and is wrong
often enough that people stop trusting it. At which point the tool is worse
than nothing, because it has added latency and false alarms to a workflow that
had neither.

**agentguard decides agreement by comparison, never by a model.** Decisions are
typed and narrow, so a contradiction is a comparison. No API call exists
anywhere in the decision path — there's a test that fails if one appears.

## Install

```bash
# Claude Code plugin — skill and MCP server together
claude plugin marketplace add harsh-chandak/agentguard
claude plugin install agentguard@harsh-chandak

# or the CLI
npx agentguard --help
```

## Use

```bash
agentguard decide --kind naming \
  --subject "user identifier in API payloads" \
  --value user_id --as backend-lead \
  --rationale "matches the users table column"

agentguard check          # exits 1 if anything contradicts
agentguard conflicts      # what's open, and whose turn
agentguard report         # how often a conflict reached you
```

Five kinds, each with its own comparison rule:

| kind | value | compared by |
| --- | --- | --- |
| `naming` | `"user_id"` | exact |
| `convention` | `"snake_case in payloads"` | exact |
| `api-contract` | `{"method":"POST","path":"/orders","status":201}` | structurally, ignoring trailing slashes and param naming |
| `enum` | `["pending","paid","shipped"]` | set equality |
| `schema` | `{"field":"id","type":"uuid","nullable":false}` | structurally |

Anything that doesn't fit a kind isn't a decision. That's deliberate — the log
is worth something because everything in it is checkable.

## Who resolves what

```
worker vs worker   ->  team lead
lead   vs lead     ->  PM
PM can't resolve   ->  you
```

Adjudication is read off the hierarchy, not judged. A PM decision overrides a
lead's on the same subject — that's an override, not a conflict. Two leads who
disagree go to the PM. Two PMs who disagree reach you, because nothing outranks
them.

Two attempts at a layer, then it escalates. What reaches you is a packet — both
positions, who holds each, why, and what has already been tried — not a
transcript.

## The number that matters

```
$ agentguard report

  47 conflicts recorded
    settled without you     44
    reached the PM          11
    reached you              3   6.4%

  Success is how rarely "reached you" is not zero.
```

Every other orchestrator reports agents launched, tokens spent, tasks
completed. None of them reports whether the system handled itself.

## Honest limits

- **It doesn't verify the work was done.** That's your orchestrator's job.
- **It doesn't judge which decision is better.** It reports that two can't both
  hold, and who gets to rule.
- **Subjects are matched loosely** — case, punctuation and accents are
  normalised, so "User Identifier" and "user identifier" collide. Two leads who
  describe the same thing in genuinely different words still won't, and that's
  a real miss.
- **Only what's recorded is checked.** A lead who decides something in prose and
  never records it is invisible to this.
- **Five kinds, deliberately.** `dependency` is deferred until semver range
  intersection is implemented properly; a comparator that calls `^1.0.0` and
  `^1.2.0` incompatible would be worse than not having it.

## License

MIT © Harsh N. Chandak
