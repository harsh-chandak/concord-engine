---
name: agentguard
description: Keep a team of coding agents from contradicting each other. Use when running a PM/lead/worker hierarchy or any multi-agent setup, before recording a convention, naming, API contract, enum or schema choice, before writing code that depends on one, and whenever two agents disagree. Requires the agentguard MCP server.
---

# agentguard

In a hierarchy of agents, each layer can be locally correct while the product
is broken. The backend lead decides the identifier is `user_id`; the frontend
lead decides `userId`. Both are reasonable, both sets of workers implement them
faithfully, both pass their own tests, and the human finds out at integration.

agentguard holds those decisions and refuses to accept a contradicting one.

## Who does what

**Leads and the PM decide.** Before delegating anything that constrains the
people below you — a field name, a route shape, an enum, a convention — call
`record_decision`. It is one call, and it is cheaper than the argument later.

**Workers do not decide.** Call `binding_decisions` *before* writing code and
implement what is already in force. If a decision looks wrong, say so. Do not
deviate silently; a silent deviation is the bug this exists to prevent.

## When a decision is refused

`record_decision` returns `recorded: false` and the conflicting decision. This
is the tool working, not an error.

**Do not route around it.** Do not rename the subject, do not pick a third
value, do not record it under a different author. Those all defeat the check
and put the contradiction back into the code where nobody can see it.

Do one of these:

1. **Adopt the existing value.** Usually right. Someone already thought about it.
2. **Escalate.** The response names who resolves it. Hand them the packet.
3. **Override deliberately** — only if you are the PM, only with `layer: "pm"`
   and `supersedes` set to the decision you are replacing, and only with a
   rationale that says why the earlier one was wrong.

## When you are asked to resolve a conflict

Call `open_conflicts` and read what has already been tried. If you fail, call
`record_attempt` with an honest note about what you tried and why it did not
work. Two attempts at a layer and it escalates automatically.

Write the note for the person above you. "Tried user_id, rejected" is useless.
"Proposed user_id; frontend-lead rejected because three call sites already ship
userId in the public API" lets them rule without re-deriving it.

## Reporting to a human

When something reaches the human, give them the packet, not the transcript: the
two positions, who holds each, why, and what has already been tried. If you
find yourself writing "see the logs," you have not saved them anything.

## What this is not

It does not verify the work was done — that is your orchestrator's job. It does
not judge which decision is better; it reports that two cannot both hold and
who gets to rule. No model is consulted anywhere in that path, which is why the
answer is the same every time.
