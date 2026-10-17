window.__SESSION = [
  {
    "kind": "prompt",
    "text": "add refunds — split it across a backend and a frontend worker"
  },
  {
    "kind": "say",
    "text": "I'll write the contract first, then fan out."
  },
  {
    "kind": "cmd",
    "text": "concord-engine spec --from add-refunds.json"
  },
  {
    "kind": "out",
    "text": "contract accepted  add-refunds  -> .concord-engine/contracts/add-refunds.json\n  4 units, 2 binding decisions, 4 acceptance criteria\n  waves: api+client+schema -> tests",
    "code": 0
  },
  {
    "kind": "say",
    "text": "Binding it, so the decisions hold before anyone writes code."
  },
  {
    "kind": "cmd",
    "text": "concord-engine bind --contract add-refunds"
  },
  {
    "kind": "out",
    "text": "  bound    refund creation endpoint\n  bound    refund status values\n\n  2 bound, 0 refused",
    "code": 0
  },
  {
    "kind": "cmd",
    "text": "concord-engine fleet --contract add-refunds"
  },
  {
    "kind": "out",
    "text": "wave 1  3 workers in parallel\n    api              Serve the refund endpoint over the refunds table.\n    client           Call the refund endpoint and surface failures to the caller.\n    schema           Add the refunds table and the migration that creates it.\nwave 2  1 worker in parallel\n    tests            Cover the refund path end to end, including a refusal.\n\n  one brief per unit: concord-engine brief --contract add-refunds <unit>",
    "code": 0
  },
  {
    "kind": "say",
    "text": "Each worker gets its brief — not the contract, and not this conversation."
  },
  {
    "kind": "cmd",
    "text": "concord-engine brief --contract add-refunds api"
  },
  {
    "kind": "out",
    "text": "You are one worker on \"add-refunds\". Your unit is \"api\".\n\nGOAL\n  Serve the refund endpoint over the refunds table.\n\nFILES YOU OWN\n  src/api/refunds.ts\n  Do not edit files outside this list. Another worker owns them.\n\nDECISIONS ALREADY IN FORCE — these are not suggestions\n  - [api-contract] refund creation endpoint = POST /api/orders/:orderId/refunds -> 201  (201 is correct for creation and the client branches on it)\n  - [enum] refund status values = [failed, requested, settled]  (the API serialises these and the client renders them)\n\nWHAT YOU MAY DECIDE\n  convention\n\nWHAT YOU MUST NOT DECIDE ALONE\n  naming, api-contract, enum, schema\n\nSTILL TO BE DECIDED — use these subject lines VERBATIM\n  [convention] error response body shape\n      the server writes it and the client parses it — settle it once\n  The gate matches subjects by wording. Rephrasing one of these creates a\n  second, unrelated decision, and a disagreement between the two will not\n  be detected. Copy the line exactly.\n\nRECORD A DECISION LIKE THIS — the flags are what enforce the two lists above\n  concord-engine decide --contract add-refunds --unit api \\\n    --kind <kind> --subject \"<what>\" --value '<value>' --as api --rationale \"<why>\"\n\n  Omitting --unit skips the check on what you may decide. Use the MCP tool\n  record_decision if you have it; it gates the same way.\n  A refusal means a decision already covers this: adopt the existing value.\n  Do not work around it, and do not --force it.\n\nDONE MEANS\n  [a-api] the endpoint answers 201\n       $ true",
    "code": 0
  },
  {
    "kind": "say",
    "text": "The api worker settles the error shape."
  },
  {
    "kind": "cmd",
    "text": "concord-engine decide --unit api --kind convention --subject \"error response body shape\" ..."
  },
  {
    "kind": "out",
    "text": "recorded d-003  convention: error response body shape = every non-2xx body is {\"error\":\"<message>\"}",
    "code": 0
  },
  {
    "kind": "say",
    "text": "Meanwhile the client worker, in parallel, reaches a different answer."
  },
  {
    "kind": "cmd",
    "text": "concord-engine decide --unit client --kind convention --subject \"error response body shape\" ..."
  },
  {
    "kind": "out",
    "text": "refused this contradicts a decision already in force.\n  d-003  api (lead): error response body shape = every non-2xx body is {\"error\":\"<message>\"}\n  because: the client shows it to a person\n  yours:   every non-2xx body is {\"code\":\"<slug>\",\"detail\":\"<message>\"}\n\n  Adopt the existing value, or supersede it deliberately:\n    --supersedes d-003 --layer pm      (an override, recorded as one)\n    --force                                  (record the disagreement for `check` to surface)",
    "code": 1
  },
  {
    "kind": "say",
    "text": "Refused at the moment it was written — not found at integration."
  },
  {
    "kind": "cmd",
    "text": "concord-engine accept --contract add-refunds"
  },
  {
    "kind": "out",
    "text": "  pass  a-schema   the migration applies cleanly (6ms)\n  pass  a-api      the endpoint answers 201 (5ms)\n  pass  a-client   the client surfaces a refusal (5ms)\n  pass  a-tests    the refund path is covered end to end (4ms)\n\n  4/4 criteria satisfied",
    "code": 0
  },
  {
    "kind": "cmd",
    "text": "concord-engine cost --contract add-refunds"
  },
  {
    "kind": "out",
    "text": "  schema             1347 B brief   vs 1807 B whole contract\n  api                1306 B brief   vs 1807 B whole contract\n  client             1337 B brief   vs 1807 B whole contract\n  tests              1403 B brief   vs 1807 B whole contract\n\n  5393 B sent instead of 7228 B — 25% less\n  ~1348 vs ~1807 tokens, ESTIMATED at 4 chars/token.\n  No tokenizer ships with this package; these are divisions, not counts.",
    "code": 0
  }
];
