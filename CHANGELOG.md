# Changelog

## 0.4.1 — the registry listing can start the server

`server.json`'s identifier was the npm package `concord-engine`, and a host
resolving a registry entry runs the bin matching that name — which is the
**CLI**. It prints help to stdout and exits 0, so over a stdio transport the
host received garbage on the protocol channel and then a closed stream. Every
published registry version behaved this way. The Claude Code plugin was never
affected: it names `concord-engine-mcp` explicitly.

The identifier now points at `concord-engine-mcp`, the launcher introduced in
0.4.0 — one file importing `concord-engine/mcp`, whose bin name equals its
package name and which declares `@modelcontextprotocol/sdk` as a real
dependency. Installing only the launcher pulls in the SDK and this package
transitively; `npx concord-engine-mcp` starts the server with no arguments.

That changes what `packages[0].version` means: it is the launcher's version,
not this package's. The release gate used to compare it against `package.json`
and would now pass while the registry resolved a launcher version npm had
never served, so it checks four things instead of three — the two versions,
the launcher's version, the launcher's dependency on this package, and that
the identifier is in fact the launcher's name.

The launcher publishes from CI in lockstep. Its first version went up by hand
because npm's trusted publishing cannot bootstrap a name that does not exist
yet; from here a release that reaches npm reaches the registry with a launcher
the registry can resolve.

## 0.4.0 — the gate's own failure modes

Eight fixes, every one a case where the gate stayed quiet or answered
confidently with the wrong thing. They were found by running the loop on real
fleet work rather than by reading the code.

**A contract could hand one file to two units.** `units[].files` was
documentation — nothing read it. Two units could own the same path, land in the
same wave (waves come from `dependsOn` alone), and each receive a brief saying
"Do not edit files outside this list. Another worker owns them." Both workers
were told they owned it; the second to finish won, silently. Detection is
glob-aware, because the collision that matters is `web/app/**` against
`web/app/page.tsx`, not a typo. All 31 contracts written on the authors'
machines still validate.

**A contract could name a path no unit was allowed to touch.** An acceptance
criterion ran a command against a file its unit did not own, and a `scope.in`
entry that no unit covered claimed a surface and assigned it to nobody.

**The server would not say which decision log it answered from.** Launched with
an unresolved `${user_config.decisions_dir}`, it defaulted silently and
answered from whatever log sat under its working directory — in practice
another project's. `binding_decisions`' own description says "Call this BEFORE
writing code," so `count: 0` read as permission to choose freely. Every answer
now carries its absolute path, and an empty result says that empty is not
proof.

**The published value shapes were not the enforced ones.** `spec --schema`
advertised `"value": {}` while the validator enforced a different shape per
kind, so a correctly-filled schema was refused anyway and the refusal never
stated the rule. One definition per kind now feeds `kinds`, `spec --schema`,
the MCP descriptions and every rejection. Two parser bugs surfaced while making
that true: `Number(null)` stored a null status as status `0`, and
`Boolean("false")` recorded a non-boolean `nullable` as its opposite.

**`verify` passed after extracting zero routes.** It matched only receivers
literally named `app`/`router`/`server`/`api`, so `express.Router()` bound to
anything else was invisible — and extracting nothing printed the same green
line as extracting everything. Receivers are now identified by what the file
binds them to, vacuity is part of the result, and `verify` exits non-zero
rather than passing. Router paths mount-match as a suffix, which can only
suppress a violation, never invent one.

**The plugin launched a path that a fresh install does not contain.** The
manifest points at `${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`, but the marketplace
installs from GitHub where `dist/` is gitignored. There was no `prepare`
script, so `npm install` succeeded and left nothing to launch. This was
invisible locally only because the installed cache had a `dist/` built by hand
1h43m after the install.

**The smoke probe reported a timeout for every unexpected error.** Its async
driver had no rejection handler, so anything the probe did not anticipate hung
to the watchdog and was reported as a slow server.

**Duplication is measured on `src/` only.** The quality gate was failing on
test fixtures that repeat deliberately — several exist to pin down which
receiver shapes are *not* routes, which a reader can only check inline.
Duplication inside `src/` still fails.

### Known: the registry listing still cannot start the server

`server.json`'s identifier is the npm package `concord-engine`, and a host
resolving that runs `npx concord-engine` — the **CLI** bin, which prints help
to stdout and exits 0. On a stdio transport that is garbage on the protocol
channel followed by a closed stream. The listing has never been able to launch
the server; the Claude Code plugin is unaffected because it names
`concord-engine-mcp` explicitly.

`packages/concord-engine-mcp` is the fix: a thin package whose single bin *is*
the server and which depends on the SDK, so `npx concord-engine-mcp` works with
no arguments. It ships separately, and the identifier moves to it once it is on
npm — npm's trusted publishing cannot bootstrap a package that does not exist
yet, so its first publish is manual.

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
works, and it exposed four defects that building concord-engine with
concord-engine did not.

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
  server. They resolved it separately before, so with `CONCORD_ENGINE_DIR` set
  the server wrote to one file while `check` audited another — the gate and
  the audit reading different logs. Empty and whitespace now count as unset,
  which matters because a host that expands an unset config placeholder to
  `""` previously sent the log to the process working directory.

### Notes

This release was built using its own loop. `contracts/concord-engine-v2.json`
is the contract that drove it, CI revalidates it on every push, and the five
units in it were built by five workers that each received only their brief.
