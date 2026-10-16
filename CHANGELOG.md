# Changelog

## 0.2.0 — the loop

v0.1 was the gate: agents record typed decisions, and a decision that
contradicts one already in force is refused. v0.2 is the loop around it.

**The commitment that shapes all of it: the package never calls a model.**
The host agent authors the contract; the package validates it, binds it,
briefs the fleet, gates every decision, runs the acceptance commands and
generates the design doc. Two tests enforce the line — one says nothing in the
decision path may leave the process at all, the other says no file anywhere
may reach a model, including the verification path that is allowed to spawn
subprocesses.

### Added

- `spec --schema` — the contract shape, published so an agent has something
  exact to target.
- `spec --from <file>` — validate and store. Rejections are collected in one
  pass rather than one per round trip: self-contradicting decisions, dependency
  cycles, a unit depending on one that does not exist, an acceptance criterion
  with no command, a criterion naming an unknown unit, and a unit that no
  criterion would prove.
- `bind --contract <id>` — the contract's decisions enter the log at PM layer,
  binding before any code exists. Refuses, rather than supersedes, when a
  contract contradicts a decision already in force.
- `fleet --contract <id>` — the waves, in dependency order.
- `brief --contract <id> <unit>` — exactly what one worker is told: its slice,
  the decisions it must honour, what it may decide and what it must request.
- `accept --contract <id>` — runs every acceptance command. `verify` still
  means route verification, so installed users keep what they had.
- `docs --contract <id>` — the design doc, generated from the log.
- `cost --contract <id>` — brief bytes against the whole-contract baseline.
  Token figures are labelled estimates and state their chars-per-token
  assumption, because no tokenizer ships with this package.
- `--version` / `-v`.
- MCP tools for the loop, alongside the existing five.

### Fixed

- The log directory is resolved in one place by both the CLI and the MCP
  server. They resolved it separately before, so with `ORCHESTRAGUARD_DIR` set
  the server wrote to one file while `check` audited another — the gate and
  the audit reading different logs. Empty and whitespace now count as unset,
  which matters because a host that expands an unset config placeholder to
  `""` previously sent the log to the process working directory.

### Notes

This release was built using its own loop. `contracts/orchestraguard-v2.json`
is the contract that drove it, CI revalidates it on every push, and the five
units in it were built by five workers that each received only their brief.
