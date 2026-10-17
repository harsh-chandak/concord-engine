#!/usr/bin/env bash
# End-to-end matrix for the v0.2 loop against the real CLI. Contract in,
# briefs out, acceptance run, docs and cost rendered — plus a contract that
# is wrong in six ways and has to be told so in one pass.
#
# Everything happens in a throwaway directory. This script never reads or
# writes the repo's own .concord-engine/.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $ROOT/dist/cli.js"
pass=0; fail=0
ok()   { pass=$((pass+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "  \033[31m✗\033[0m %s\n     %s\n" "$1" "${2:-}"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
W="$TMP/state"
# Belt and braces: the flag is what the CLI reads, the environment is what
# anything it spawns would read. Both point away from the repo.
export CONCORD_ENGINE_DIR="$W"
og()   { $CLI --dir "$W" "$@"; }
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(new Function('j','return '+process.argv[1])(JSON.parse(s)))}catch{console.log('ERR')}})" "$1"; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }

# ---------------------------------------------------------------- fixtures
cat > "$TMP/ok.json" <<'JSON'
{
  "id": "loop-ok",
  "goal": "Ship the ingest path with one row shape agreed before anyone writes a line.",
  "scope": { "in": ["ingest", "the cli surface"], "out": ["the web console", "billing"] },
  "decisions": [
    { "kind": "naming", "subject": "id column name", "value": "user_id",
      "rationale": "the warehouse already spells it user_id and renaming it would break every saved query" },
    { "kind": "convention", "subject": "timestamp storage", "value": "UTC ISO-8601 strings",
      "rationale": "local times in the log made two incidents unreconstructable" }
  ],
  "units": [
    { "id": "core", "goal": "Own the row shape and the on-disk format.",
      "files": ["src/core.ts"], "mayDecide": ["schema"], "dependsOn": [] },
    { "id": "api", "goal": "Serve the ingest endpoint over the core row shape.",
      "files": ["src/api.ts"], "mayDecide": [], "dependsOn": ["core"] },
    { "id": "cli", "goal": "Drive the ingest endpoint from a terminal.",
      "files": ["src/cli.ts"], "mayDecide": [], "dependsOn": ["api"] },
    { "id": "ui", "goal": "Render ingest progress in the dashboard.",
      "files": ["src/ui.tsx"], "mayDecide": [], "dependsOn": ["api"] }
  ],
  "acceptance": [
    { "id": "a-core", "statement": "the row shape round-trips", "check": "true", "unit": "core" },
    { "id": "a-api", "statement": "the endpoint accepts a row", "check": "true", "unit": "api" },
    { "id": "a-cli", "statement": "the cli posts a row", "check": "true", "unit": "cli" },
    { "id": "a-ui", "statement": "progress renders", "check": "true", "unit": "ui" }
  ]
}
JSON

cat > "$TMP/bad.json" <<'JSON'
{
  "id": "loop-bad",
  "goal": "A contract that is wrong in every way the validator is supposed to catch.",
  "scope": { "in": ["everything"], "out": [] },
  "decisions": [
    { "kind": "naming", "subject": "id column name", "value": "user_id" },
    { "kind": "naming", "subject": "ID Column Name", "value": "userId" }
  ],
  "units": [
    { "id": "alpha", "goal": "a", "files": [], "mayDecide": [], "dependsOn": ["beta"] },
    { "id": "beta",  "goal": "b", "files": [], "mayDecide": [], "dependsOn": ["alpha"] },
    { "id": "gamma", "goal": "g", "files": [], "mayDecide": [], "dependsOn": ["ghost"] },
    { "id": "delta", "goal": "d", "files": [], "mayDecide": [], "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a-alpha", "statement": "alpha is done", "check": "", "unit": "alpha" },
    { "id": "a-beta",  "statement": "beta is done",  "check": "true", "unit": "beta" },
    { "id": "a-gamma", "statement": "gamma is done", "check": "true", "unit": "gamma" },
    { "id": "a-ghost", "statement": "the ghost is done", "check": "true", "unit": "nosuchunit" }
  ]
}
JSON

cat > "$TMP/clash.json" <<'JSON'
{
  "id": "loop-clash",
  "goal": "A second contract that quietly renames a column the first one already fixed.",
  "scope": { "in": ["reporting"], "out": ["ingest"] },
  "decisions": [
    { "kind": "naming", "subject": "id column name", "value": "userId",
      "rationale": "the reporting code is camelCase throughout" }
  ],
  "units": [
    { "id": "reports", "goal": "Roll the rows up nightly.", "files": ["src/reports.ts"], "mayDecide": [], "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a-reports", "statement": "the rollup runs", "check": "true", "unit": "reports" }
  ]
}
JSON

cat > "$TMP/failing.json" <<'JSON'
{
  "id": "loop-failing",
  "goal": "A contract whose work is not finished, so one criterion must fail.",
  "scope": { "in": ["the report"], "out": [] },
  "decisions": [],
  "units": [
    { "id": "solo", "goal": "Write the nightly report.", "files": ["src/solo.ts"], "mayDecide": [], "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a-builds", "statement": "the package still builds", "check": "true", "unit": "solo" },
    { "id": "a-report", "statement": "the nightly report is written",
      "check": "echo 'no report was written' >&2; exit 7", "unit": "solo" }
  ]
}
JSON

# ---------------------------------------------------------------- contract
echo "CONTRACT"
out=$(og spec --from "$TMP/ok.json" 2>&1)
if [ $? -eq 0 ] && has "$out" "contract accepted"; then ok "a valid contract is accepted"
else bad "a valid contract is accepted" "$(printf '%s' "$out" | head -3)"; fi
has "$out" "waves: core -> api -> cli+ui" \
  && ok "an accepted contract reports its wave plan" \
  || bad "an accepted contract reports its wave plan" "$(printf '%s' "$out" | grep -i wave)"
[ -f "$W/contracts/loop-ok.json" ] && ok "the contract is stored under the chosen dir" || bad "the contract is stored under the chosen dir" "nothing at $W/contracts/loop-ok.json"

echo "REJECTION"
out=$(og spec --from "$TMP/bad.json" 2>&1)
[ $? -ne 0 ] && ok "an invalid contract exits non-zero" || bad "an invalid contract exits non-zero" "exit 0"
has "$out" "contract is not valid" && ok "the rejection says the contract is not valid" || bad "the rejection says the contract is not valid" "$(printf '%s' "$out" | head -2)"
has "$out" 'decisions contradict each other on "ID Column Name": user_id vs userId' \
  && ok "names the self-contradicting decisions" || bad "names the self-contradicting decisions" "not in the message"
has "$out" "units form a dependency cycle: alpha -> beta -> alpha" \
  && ok "names the dependency cycle, with the path" || bad "names the dependency cycle, with the path" "not in the message"
has "$out" 'unit "gamma" depends on "ghost", which is not a unit in this contract' \
  && ok "names the unknown dependency" || bad "names the unknown dependency" "not in the message"
has "$out" "acceptance[a-alpha] has no check" \
  && ok "names the acceptance criterion with an empty check" || bad "names the acceptance criterion with an empty check" "not in the message"
has "$out" "acceptance[a-ghost].unit must name a unit in this contract" \
  && ok "names the acceptance criterion pointing at an unknown unit" || bad "names the acceptance criterion pointing at an unknown unit" "not in the message"
has "$out" 'unit "delta" has no acceptance criterion' \
  && ok "names the unit nothing would prove was done" || bad "names the unit nothing would prove was done" "not in the message"
n=$(printf '%s\n' "$out" | grep -c '^  - ')
[ "$n" -ge 6 ] && ok "all six problems arrive in one pass" || bad "all six problems arrive in one pass" "reported $n"
[ ! -f "$W/contracts/loop-bad.json" ] && ok "a rejected contract is not stored" || bad "a rejected contract is not stored" "it was written anyway"

echo "BIND"
out=$(og bind --contract loop-ok 2>&1)
[ $? -eq 0 ] && ok "binding a fresh contract exits 0" || bad "binding a fresh contract exits 0" "$(printf '%s' "$out" | tail -2)"
has "$out" "2 bound, 0 refused" && ok "bind records both contract decisions" || bad "bind records both contract decisions" "$(printf '%s' "$out" | tail -1)"
log="$W/decisions.jsonl"
if [ -f "$log" ] && grep -qF 'user_id' "$log" && grep -qF 'UTC ISO-8601 strings' "$log"; then
  ok "the bound decisions are in the log"
else bad "the bound decisions are in the log" "decisions.jsonl does not hold them"; fi
og check --json >/dev/null 2>&1 && ok "the log has no contradictions after binding" || bad "the log has no contradictions after binding" "check found one"
out=$(og bind --contract loop-ok 2>&1)
has "$out" "0 bound, 0 refused" && ok "binding twice records nothing new" || bad "binding twice records nothing new" "$(printf '%s' "$out" | tail -1)"

og spec --from "$TMP/clash.json" >/dev/null 2>&1
out=$(og bind --contract loop-clash 2>&1)
[ $? -ne 0 ] && ok "a contradicting contract exits non-zero on bind" || bad "a contradicting contract exits non-zero on bind" "exit 0"
has "$out" "refused" && ok "the contradicting decision is refused, not applied" || bad "the contradicting decision is refused, not applied" "$(printf '%s' "$out" | tail -2)"
if has "$out" "contract says userId" && has "$out" "already decided user_id"; then
  ok "the refusal names both values and who holds the live one"
else bad "the refusal names both values and who holds the live one" "$(printf '%s' "$out" | grep -i refused)"; fi
grep -qF '"value":"userId"' "$log" && bad "the refused value never reaches the log" "userId was written" || ok "the refused value never reaches the log"

echo "BRIEF"
out=$(og brief --contract loop-ok api 2>&1)
has "$out" "Serve the ingest endpoint over the core row shape." \
  && ok "the brief carries the unit's own goal" || bad "the brief carries the unit's own goal" "goal missing"
has "$out" "[naming] id column name = user_id" \
  && ok "the brief carries the binding decisions" || bad "the brief carries the binding decisions" "decision missing"
has "$out" "the warehouse already spells it user_id" \
  && ok "the brief carries each decision's rationale" || bad "the brief carries each decision's rationale" "rationale missing"
has "$out" "Render ingest progress in the dashboard." \
  && bad "the brief does not leak another unit's goal" "ui's goal is in api's brief" \
  || ok "the brief does not leak another unit's goal"
has "$out" "WAIT FOR" && ok "the brief says what it waits for" || bad "the brief says what it waits for" "no WAIT FOR section"
out=$(og brief --contract loop-ok no-such-unit 2>&1)
[ $? -ne 0 ] && ok "brief on an unknown unit exits non-zero" || bad "brief on an unknown unit exits non-zero" "exit 0"
has "$out" "no unit" && ok "brief on an unknown unit says so" || bad "brief on an unknown unit says so" "$(printf '%s' "$out" | head -2)"
og brief --contract no-such-contract core >/dev/null 2>&1 && bad "brief on an unknown contract exits non-zero" "exit 0" || ok "brief on an unknown contract exits non-zero"

echo "FLEET"
sig=$(og fleet --contract loop-ok --json 2>/dev/null | json "j.waves.map(w=>w.units.map(u=>u.unit).join('+')).join(' -> ')")
[ "$sig" = "core -> api -> cli+ui" ] && ok "fleet orders a real dependency chain into waves" || bad "fleet orders a real dependency chain into waves" "got: $sig"
out=$(og fleet --contract loop-ok 2>&1)
first=$(printf '%s\n' "$out" | grep -n 'wave 1' | cut -d: -f1)
last=$(printf '%s\n' "$out" | grep -n 'wave 3' | cut -d: -f1)
if [ -n "$first" ] && [ -n "$last" ] && [ "$first" -lt "$last" ]; then
  ok "the human-readable plan lists the waves in order"
else bad "the human-readable plan lists the waves in order" "$(printf '%s' "$out" | grep wave | tr '\n' ' ')"; fi
has "$out" "2 workers in parallel" && ok "fleet says which units can run in parallel" || bad "fleet says which units can run in parallel" "no parallel wave reported"

echo "ACCEPT"
out=$(og accept --contract loop-ok 2>&1)
[ $? -eq 0 ] && ok "accept exits 0 when every check passes" || bad "accept exits 0 when every check passes" "$(printf '%s' "$out" | tail -2)"
has "$out" "4/4 criteria satisfied" && ok "accept counts every criterion" || bad "accept counts every criterion" "$(printf '%s' "$out" | tail -1)"
og spec --from "$TMP/failing.json" >/dev/null 2>&1
out=$(og accept --contract loop-failing 2>&1)
[ $? -ne 0 ] && ok "accept exits non-zero when a check fails" || bad "accept exits non-zero when a check fails" "exit 0"
if has "$out" "a-report" && has "$out" "the nightly report is written"; then
  ok "accept names the failing criterion"
else bad "accept names the failing criterion" "$(printf '%s' "$out" | tail -3)"; fi
has "$out" "no report was written" && ok "accept shows the failing command's output" || bad "accept shows the failing command's output" "output swallowed"
has "$out" "1/2 criteria satisfied" && ok "accept does not fail the criteria that passed" || bad "accept does not fail the criteria that passed" "$(printf '%s' "$out" | tail -1)"

echo "DOCS"
out=$(og docs --contract loop-ok 2>&1)
[ $? -eq 0 ] && ok "docs exits 0" || bad "docs exits 0" "$(printf '%s' "$out" | head -2)"
has "$out" "id column name" && ok "docs contains a decision" || bad "docs contains a decision" "decision missing"
has "$out" "the warehouse already spells it user_id" && ok "docs contains that decision's rationale" || bad "docs contains that decision's rationale" "rationale missing"
has "$out" "concord-engine docs" && ok "docs says it was generated, not written" || bad "docs says it was generated, not written" "no provenance line"

echo "COST"
out=$(og cost --contract loop-ok 2>&1)
[ $? -eq 0 ] && ok "cost exits 0" || bad "cost exits 0" "$(printf '%s' "$out" | head -2)"
has "$out" "ESTIMATED" && ok "cost labels its token figures an estimate" || bad "cost labels its token figures an estimate" "$(printf '%s' "$out" | tail -2)"
has "$out" "chars/token" && ok "cost states its chars-per-token assumption" || bad "cost states its chars-per-token assumption" "assumption unstated"
unlabelled=$(printf '%s\n' "$out" | grep -F "tokens" | grep -vF "ESTIMATED")
[ -z "$unlabelled" ] && ok "no token figure is printed unlabelled" || bad "no token figure is printed unlabelled" "$unlabelled"

echo "ISOLATION"
[ ! -e "$ROOT/.concord-engine/contracts/loop-ok.json" ] && ok "the repo's own log was never touched" || bad "the repo's own log was never touched" "loop-ok leaked into $ROOT/.concord-engine"

echo

echo "DECLARED SUBJECTS"
# The failure this section exists for: two workers named one subject two ways,
# chose incompatible values, and `check` saw no contradiction because it never
# compared them. Observed on a real run before these guards existed.
cat > "$TMP/declared.json" <<'JSON'
{
  "id": "declared", "goal": "Two units settle one shared convention.",
  "scope": { "in": ["api", "web"], "out": [] }, "decisions": [],
  "openSubjects": [
    { "kind": "convention", "subject": "error response body shape", "note": "both sides serialise it" }
  ],
  "units": [
    { "id": "api", "goal": "serve", "files": ["src/api.js"], "mayDecide": ["convention"], "dependsOn": [] },
    { "id": "web", "goal": "consume", "files": ["src/web.js"], "mayDecide": ["naming"], "dependsOn": [] }
  ],
  "acceptance": [
    { "id": "a1", "statement": "api works", "check": "true", "unit": "api" },
    { "id": "a2", "statement": "web works", "check": "true", "unit": "web" }
  ]
}
JSON
out=$(og spec --from "$TMP/declared.json" 2>&1)
[ $? -eq 0 ] && ok "a contract may declare open subjects" || bad "a contract may declare open subjects" "$out"

out=$(og brief --contract declared api 2>&1)
has "$out" "STILL TO BE DECIDED" && ok "the brief names what is still open" || bad "the brief names what is still open" "no open section"
has "$out" "error response body shape" && ok "the brief gives the exact subject line" || bad "the brief gives the exact subject line" "subject missing"

out=$(og decide --contract declared --unit api --kind convention --subject "error response body shape" --value 'json {"error":"<message>"}' --as api --rationale "shown to a person" 2>&1)
[ $? -eq 0 ] && ok "a declared subject is accepted" || bad "a declared subject is accepted" "$out"

out=$(og decide --contract declared --unit api --kind convention --subject "api error response body" --value 'json {"error":"<code>"}' --as api --rationale "machine readable" 2>&1)
[ $? -ne 0 ] && ok "a rephrased subject is refused" || bad "a rephrased subject is refused" "exit 0"
has "$out" "is not a subject contract" && ok "the refusal says the subject is undeclared" || bad "the refusal says the subject is undeclared" "$out"
has "$out" "error response body shape" && ok "the refusal offers the declared spelling" || bad "the refusal offers the declared spelling" "$out"

out=$(og decide --contract declared --unit api --kind convention --subject "error response body shape" --value 'json {"error":"<code>"}' --as api --rationale "machine readable" 2>&1)
[ $? -ne 0 ] && ok "the same subject with a different value is refused" || bad "the same subject with a different value is refused" "exit 0"
has "$out" "contradicts a decision already in force" && ok "the refusal names the decision in force" || bad "the refusal names the decision in force" "$out"

out=$(og decide --contract declared --unit web --kind naming --subject "destination field" --value url --as web --new-subject 2>&1)
[ $? -eq 0 ] && ok "--new-subject allows a genuinely new subject" || bad "--new-subject allows a genuinely new subject" "$out"

out=$(og decide --contract declared --unit web --kind convention --subject "error response body shape" --value 'anything' --as web 2>&1)
[ $? -ne 0 ] && ok "a unit may not decide a kind outside its mayDecide" || bad "a unit may not decide a kind outside its mayDecide" "exit 0"
has "$out" "may not decide" && ok "the refusal says which kinds the unit may decide" || bad "the refusal says which kinds the unit may decide" "$out"

printf "%d passed, %d failed\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
