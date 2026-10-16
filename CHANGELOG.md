# Changelog

## 0.2.2 — the README people actually read

0.2.1's tarball carried the pre-rewrite README: the one that framed the tool
as a check on variable names and route paths, quoted a cost figure that had
since moved, and illustrated the gate with a mocked terminal block rather
than real output. npm serves the README from the tarball, so the package page
was showing all of that. This release ships the rewritten README and skill,
and the demo recorded from the real CLI.

`scripts/prepublish-guard.mjs` now skips its branch and remote checks on a CI
runner, where the checkout is a detached HEAD the workflow chose. The
clean-tree check still applies. Without this the guard would have failed
every trusted-publishing release — the publish path it exists to protect.

## 0.2.1 — what 0.2.0 should have contained

**0.2.0 on npm is a build of an older tree.** Its tarball has none of the five
fixes listed below: no `openSubjects`, no `declaredSubjects` in the CLI, and
`normalizePath()` still inside `api-contract`'s `parse()`. The work was
committed, CI-green and pushed before the publish ran, and nothing in the
publish path noticed the artefact did not match the repository. The MCP
registry then registered that version. Use 0.2.1.

`prepublishOnly` now runs `scripts/prepublish-guard.mjs`, which refuses to
publish unless the working tree is clean, HEAD is on main, and HEAD is what
origin has — and prints the commit so the publish log records what shipped.
It also runs the test suite, which it did not before.

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

### Added after the second-project run

- **`openSubjects`** — a contract can name what it knows will need settling
  before anyone settles it. Each worker's brief then carries those subject
  lines verbatim, and `decide --contract <id> --unit <id>` refuses a subject
  the contract never declared, offering the declared spelling instead.

  This closes the sharpest hole in the tool. The gate compares decisions that
  share a subject, and subjects are matched by wording — so two workers who
  named the error format "error response body shape" and "api error response
  body" produced two unrelated decisions with incompatible values, and
  `check` reported nothing. Declaring the subject makes identity a lookup.
  Matching by similarity would close it too, and would put a judgement back
  in the decision path, which this package will not do.

### Fixed — all four found by running the loop on a second project

A URL shortener built by four workers who never saw each other's code. It
works, and it exposed four defects that building orchestraguard with
orchestraguard did not.

- **`decide` did not gate.** The MCP server refused a contradicting decision
  from the first release while the CLI recorded it silently, so which
  interface a worker used decided whether the product's central promise held
  — and the generated brief promised a refusal the CLI never performed.
  `decide` now refuses by default; a deliberate disagreement is recorded with
  an explicit flag, for `check` to surface.
- **`mayDecide` was advisory.** A unit told it could not settle a `naming`
  decision settled one anyway. `decide --contract <id> --unit <id>` now
  enforces it, and the brief emits that exact command.
- **api-contract decisions lost the authored path.** `parse()` stored
  `normalizePath(path)`, so `/api/links/:code` became `/api/links/:p` in the
  log and the brief handed workers a parameter name nobody chose.
  Normalisation is how two paths are compared, not what a path is.
- **`verify` could never match a parameterised route.** It compared
  extractRoutes' normalised output against the decision's raw path, so every
  route with a parameter reported "not served" — the detector was unusable
  for precisely the routes most likely to drift.

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
