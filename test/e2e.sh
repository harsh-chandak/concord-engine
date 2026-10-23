#!/usr/bin/env bash
# End-to-end matrix against the real CLI. Every kind, every escalation path,
# both detectors, exit codes and JSON validity.
set -uo pipefail
CLI="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
pass=0; fail=0
ok()   { pass=$((pass+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "  \033[31m✗\033[0m %s\n     %s\n" "$1" "${2:-}"; }
fresh(){ mktemp -d; }

# --- every kind: agreement produces no conflict, disagreement produces one ---
kind_case() {
  local kind="$1" a="$2" b="$3" label="$4"
  local d; d=$(fresh)
  $CLI decide --dir "$d" --kind "$kind" --subject "s" --value "$a" --as lead-a >/dev/null 2>&1
  $CLI decide --dir "$d" --kind "$kind" --subject "S " --value "$a" --as lead-b >/dev/null 2>&1
  if $CLI check --dir "$d" --json >/dev/null 2>&1; then ok "$label: identical values agree"
  else bad "$label: identical values agree" "flagged a conflict that isn't one"; fi
  d=$(fresh)
  $CLI decide --dir "$d" --kind "$kind" --subject "s" --value "$a" --as lead-a >/dev/null 2>&1
  $CLI decide --dir "$d" --kind "$kind" --subject "s" --value "$b" --as lead-b --force >/dev/null 2>&1
  local n; n=$($CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).conflicts.length)}catch{console.log('ERR')}})")
  [ "$n" = "1" ] && ok "$label: differing values conflict" || bad "$label: differing values conflict" "got $n conflicts"
}
echo "KINDS"
kind_case naming        "user_id" "userId"                                                     "naming"
kind_case convention    "snake_case" "camelCase"                                               "convention"
kind_case api-contract  '{"method":"POST","path":"/orders","status":201}' '{"method":"POST","path":"/orders","status":200}' "api-contract"
kind_case enum          '["a","b"]' '["a","b","c"]'                                            "enum"
kind_case schema        '{"field":"id","type":"uuid"}' '{"field":"id","type":"int"}'           "schema"

echo "HIERARCHY"
d=$(fresh)
$CLI decide --dir "$d" --kind naming --subject s --value a --as lead-a >/dev/null 2>&1
$CLI decide --dir "$d" --kind naming --subject s --value b --as boss --layer pm >/dev/null 2>&1
$CLI check --dir "$d" --json >/dev/null 2>&1 && ok "PM overrides a lead (no conflict)" || bad "PM overrides a lead" "still conflicting"

d=$(fresh)
$CLI decide --dir "$d" --kind naming --subject s --value a --as pm-a --layer pm >/dev/null 2>&1
$CLI decide --dir "$d" --kind naming --subject s --value b --as pm-b --layer pm --force >/dev/null 2>&1
o=$($CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).conflicts[0].owner)}catch{console.log('ERR')}})")
[ "$o" = "human" ] && ok "two PMs reach the human" || bad "two PMs reach the human" "owner=$o"

d=$(fresh)
$CLI decide --dir "$d" --kind naming --subject s --value a --as lead-a >/dev/null 2>&1
# --force, so there is a real conflict to clear. Without it this second decide
# is refused, nothing conflicts, and the supersession below proves nothing.
$CLI decide --dir "$d" --kind naming --subject s --value b --as lead-b --force >/dev/null 2>&1
$CLI check --dir "$d" --json >/dev/null 2>&1 && bad "a conflict exists to be cleared" "nothing conflicted" || ok "a conflict exists to be cleared"
$CLI decide --dir "$d" --kind naming --subject s --value a --as lead-b --supersedes d-002 >/dev/null 2>&1 && ok "an override satisfies the gate" || bad "an override satisfies the gate" "refused"
$CLI check --dir "$d" --json >/dev/null 2>&1 && ok "supersession clears the conflict" || bad "supersession clears the conflict" "still conflicting"

echo "ESCALATION"
d=$(fresh)
$CLI decide --dir "$d" --kind naming --subject s --value a --as lead-a >/dev/null 2>&1
$CLI decide --dir "$d" --kind naming --subject s --value b --as lead-b --force >/dev/null 2>&1
id=$($CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{console.log(JSON.parse(s).conflicts[0].stored.id)})")
$CLI attempt "$id" --dir "$d" --note one >/dev/null 2>&1
mid=$($CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{console.log(JSON.parse(s).conflicts[0].stored.owner)})")
$CLI attempt "$id" --dir "$d" --note two >/dev/null 2>&1
end=$($CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{console.log(JSON.parse(s).conflicts[0].stored.owner)})")
[ "$mid" = "pm" ] && ok "one attempt stays at the layer" || bad "one attempt stays at the layer" "owner=$mid"
[ "$end" = "human" ] && ok "two attempts escalate" || bad "two attempts escalate" "owner=$end"

echo "ROUTE DETECTOR"
c=$(fresh); d=$(fresh)
printf "app.get('/api/s/:id', h)\napp.post('/api/o', h)\n" > "$c/s.js"
printf '@app.delete("/api/p/{pid}")\ndef p(): ...\n' > "$c/m.py"
$CLI decide --dir "$d" --kind api-contract --subject a --value '{"method":"GET","path":"/api/s/{sid}/"}' --as lead >/dev/null 2>&1
$CLI decide --dir "$d" --kind api-contract --subject b --value '{"method":"DELETE","path":"/api/p/<int:pid>"}' --as lead >/dev/null 2>&1
$CLI verify "$c" --dir "$d" --json >/dev/null 2>&1 && ok "express + fastapi routes match across param styles" || bad "route match across param styles" "reported a violation"
$CLI decide --dir "$d" --kind api-contract --subject c --value '{"method":"PATCH","path":"/api/o"}' --as lead >/dev/null 2>&1
$CLI verify "$c" --dir "$d" --json >/dev/null 2>&1 && bad "unserved method is caught" "exit 0" || ok "unserved method is caught"

echo "CLI SURFACE"
for cmd in kinds report help; do
  $CLI $cmd >/dev/null 2>&1 && ok "\`$cmd\` exits 0" || bad "\`$cmd\` exits 0"
done
d=$(fresh); $CLI decide --dir "$d" --kind naming --subject s --value a --as l >/dev/null 2>&1
$CLI check --dir "$d" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{JSON.parse(s);process.exit(0)})" && ok "check --json is valid JSON" || bad "check --json is valid JSON"
$CLI decide --dir "$d" --kind nope --subject s --value a --as l >/dev/null 2>&1 && bad "unknown kind is rejected" "exit 0" || ok "unknown kind is rejected"
$CLI decide --dir "$d" --kind enum --subject s --value '[]' --as l >/dev/null 2>&1 && bad "invalid value is rejected" "exit 0" || ok "invalid value is rejected"

echo
printf "%d passed, %d failed\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
