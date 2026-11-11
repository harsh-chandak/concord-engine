/**
 * The published contract shape and the validator must agree.
 *
 * Both defects covered here cost a peer session real round trips:
 *
 *   A. `spec --schema` published `"value": {}` for a decision — any type — while
 *      the validator enforced per-kind shapes that appeared nowhere in it. An
 *      agent handed that schema filled it in correctly by the schema's own
 *      lights and was refused three times. The refusals named the offending
 *      field and never stated the rule, so each fix was a guess.
 *
 *   B. `--value` refused any text starting with `{` or `[` that did not parse as
 *      JSON, including a legitimate convention written in prose
 *      ("{message, data, success}; errors thrown as HttpError ..."). The kind
 *      being decided says whether a string is even possible, so the refusal was
 *      answerable from information the CLI already had.
 *
 * The shapes are tested as ONE definition on purpose: `kinds`, `spec --schema`
 * and the validator reading from three copies is how they drifted apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIND_IDS, kindSpec, SCHEMA } from "../dist/index.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const box = () => mkdtempSync(join(tmpdir(), "concord-engine-shapes-"));

/** The real CLI, not an internal. Both defects were on the CLI surface. */
function cli(args, dir) {
  const r = spawnSync(
    process.execPath,
    [CLI, ...args, ...(dir ? ["--dir", dir] : [])],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return {
    code: r.status,
    out: r.stdout ?? "",
    err: r.stderr ?? "",
    all: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

const schemaOf = () => JSON.parse(cli(["spec", "--schema"]).out);
const valueDef = (schema, kind) => schema.$defs?.[`${kind}-value`];

/* ---------------------------------------------------------------- *
 * DEFECT A, half one: the schema carries the per-kind value shapes  *
 * ---------------------------------------------------------------- */

test("REGRESSION: spec --schema publishes a value shape for every kind", () => {
  const schema = schemaOf();
  for (const kind of KIND_IDS) {
    const def = valueDef(schema, kind);
    assert.ok(def, `the published schema says nothing about a ${kind} value`);
    // `{}` — the old published shape — accepts anything, which is the bug.
    assert.ok(Object.keys(def).length > 0, `${kind} value shape is empty`);
    assert.ok(
      def.type || def.anyOf || def.oneOf,
      `${kind} value shape names no type`,
    );
  }
});

test("REGRESSION: the schema binds the value shape to the kind that was chosen", () => {
  const items = schemaOf().properties.decisions.items;
  assert.ok(
    Array.isArray(items.allOf),
    "nothing in the schema connects `kind` to `value`",
  );
  for (const kind of KIND_IDS) {
    const branch = items.allOf.find(
      (b) => b.if?.properties?.kind?.const === kind,
    );
    assert.ok(
      branch,
      `the schema never says what a "${kind}" decision's value must look like`,
    );
    assert.equal(branch.then.properties.value.$ref, `#/$defs/${kind}-value`);
  }
});

test("the published shapes are the validator's own definition, not a second copy", () => {
  const schema = schemaOf();
  for (const kind of KIND_IDS) {
    assert.deepEqual(
      valueDef(schema, kind),
      JSON.parse(JSON.stringify(kindSpec(kind).shape.schema)),
      `the schema's ${kind} shape has drifted from the spec the validator uses`,
    );
  }
});

test("every example the schema publishes is a value the validator accepts", () => {
  const schema = schemaOf();
  for (const kind of KIND_IDS) {
    const examples = valueDef(schema, kind).examples;
    assert.ok(
      Array.isArray(examples) && examples.length,
      `${kind} publishes no example value`,
    );
    for (const ex of examples) {
      assert.doesNotThrow(
        () => kindSpec(kind).parse(ex),
        `the ${kind} example in the schema does not validate`,
      );
    }
  }
});

test("the shapes a peer was refused for are all stated in the schema now", () => {
  const schema = schemaOf();

  // "kind convention: value must be a non-empty STRING" — the peer passed an object.
  for (const kind of ["convention", "naming"]) {
    assert.equal(valueDef(schema, kind).type, "string");
    assert.equal(valueDef(schema, kind).minLength, 1);
  }

  // "kind schema: value must contain a non-empty string `field`".
  const s = valueDef(schema, "schema");
  assert.ok(
    s.required.includes("field"),
    "the schema kind's required `field` is still unpublished",
  );
  assert.equal(s.properties.field.type, "string");

  // "kind api-contract: requires `method`, `path`, and `status` must be an INTEGER".
  const a = valueDef(schema, "api-contract");
  assert.ok(
    a.required.includes("method"),
    "api-contract's required `method` is still unpublished",
  );
  assert.ok(
    a.required.includes("path"),
    "api-contract's required `path` is still unpublished",
  );
  assert.ok(
    [a.properties.status.type].flat().includes("integer"),
    "api-contract's status is still not published as an integer",
  );
});

test("kinds, spec --schema and the validator agree on every example", () => {
  const schema = schemaOf();
  const printed = cli(["kinds"]).out;
  for (const kind of KIND_IDS) {
    const example = JSON.stringify(kindSpec(kind).shape.example);
    assert.ok(
      printed.includes(example),
      `\`kinds\` does not show the ${kind} example the schema publishes`,
    );
    assert.deepEqual(
      valueDef(schema, kind).examples[0],
      kindSpec(kind).shape.example,
    );
  }
});

test("SCHEMA stays plain, published JSON", () => {
  // It is handed to agents verbatim; a function or an undefined in it would
  // vanish silently on the way out.
  assert.deepEqual(
    JSON.parse(JSON.stringify(SCHEMA)),
    JSON.parse(cli(["spec", "--schema"]).out),
  );
});

/* ---------------------------------------------------------------- *
 * DEFECT A, half two: a refusal states the rule and shows an example *
 * ---------------------------------------------------------------- */

// The four refusals the peer actually hit, with the value they actually sent.
const REFUSALS = [
  {
    name: "an object where a convention takes prose",
    kind: "convention",
    value: '{"shape":"{message, data, success}"}',
  },
  {
    name: "a schema value with no field",
    kind: "schema",
    value: '{"name":"id","type":"uuid"}',
  },
  {
    name: "an api-contract with no method",
    kind: "api-contract",
    value: '{"path":"/r/:code","status":200}',
  },
  {
    name: "prose in an api-contract status",
    kind: "api-contract",
    value:
      '{"method":"GET","path":"/r/:code","status":"200 means live, 403 means dead"}',
  },
];

for (const c of REFUSALS) {
  test(`REGRESSION: refusing ${c.name} states the rule and shows a valid example`, () => {
    const d = box();
    try {
      const r = cli(
        [
          "decide",
          "--kind",
          c.kind,
          "--subject",
          "s",
          "--value",
          c.value,
          "--as",
          "peer",
        ],
        d,
      );
      assert.notEqual(
        r.code,
        0,
        "this value is not valid for this kind and must be refused",
      );

      const spec = kindSpec(c.kind);
      assert.ok(
        r.all.includes(c.kind),
        "the message never says which kind was being decided",
      );
      assert.ok(
        r.all.includes(spec.shape.summary),
        "the message never states the rule the value must satisfy",
      );
      assert.ok(
        r.all.includes(JSON.stringify(spec.shape.example)),
        "the message shows no valid example, so the next attempt is a guess",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("every kind's refusal carries that kind's rule and example", () => {
  // Table-driven so a kind added later cannot ship a bare refusal.
  const wrong = {
    naming: "[]",
    convention: "[]",
    "api-contract": '"GET /x"',
    enum: "[]",
    schema: '"id"',
  };
  for (const kind of KIND_IDS) {
    const d = box();
    try {
      const r = cli(
        [
          "decide",
          "--kind",
          kind,
          "--subject",
          "s",
          "--value",
          wrong[kind],
          "--as",
          "peer",
        ],
        d,
      );
      assert.notEqual(r.code, 0, `${kind} accepted ${wrong[kind]}`);
      const spec = kindSpec(kind);
      assert.ok(
        r.all.includes(spec.shape.summary),
        `${kind}'s refusal does not state the rule`,
      );
      assert.ok(
        r.all.includes(JSON.stringify(spec.shape.example)),
        `${kind}'s refusal shows no example`,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test("a refusal names the offending field, not just the kind", () => {
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "api-contract",
        "--subject",
        "s",
        "--value",
        '{"path":"/r/:code","status":200}',
        "--as",
        "peer",
      ],
      d,
    );
    assert.match(
      r.all,
      /method/,
      "the message must still say which field was wrong",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * DEFECT B: prose that starts with a brace is prose                 *
 * ---------------------------------------------------------------- */

// Verbatim from the peer session: a real convention, refused as broken JSON.
const PROSE =
  "{message, data, success}; errors thrown as HttpError and shaped by the central errorHandler";

test("REGRESSION: a convention written in prose that starts with { is recorded", () => {
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "convention",
        "--subject",
        "error envelope",
        "--value",
        PROSE,
        "--as",
        "peer",
        "--json",
      ],
      d,
    );
    assert.equal(
      r.code,
      0,
      `refused a legitimate convention string:\n${r.all}`,
    );
    assert.equal(
      JSON.parse(r.out).value,
      PROSE,
      "the convention must be stored as written",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("REGRESSION: a naming value that starts with [ and is not JSON is recorded", () => {
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "naming",
        "--subject",
        "log prefix",
        "--value",
        "[concord] prefix on every log line",
        "--as",
        "peer",
        "--json",
      ],
      d,
    );
    assert.equal(r.code, 0, `refused a legitimate naming string:\n${r.all}`);
    assert.equal(JSON.parse(r.out).value, "[concord] prefix on every log line");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("real JSON still parses as JSON for a kind that takes structure", () => {
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "api-contract",
        "--subject",
        "orders",
        "--value",
        '{"method":"post","path":"/orders","status":201}',
        "--as",
        "peer",
        "--json",
      ],
      d,
    );
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.out).value, {
      method: "POST",
      path: "/orders",
      status: 201,
    });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

for (const kind of ["api-contract", "enum", "schema"]) {
  test(`unparseable JSON is still refused for ${kind}, and the refusal says what was expected`, () => {
    const d = box();
    try {
      const broken =
        kind === "enum" ? "[pending, paid" : "{method: GET, path: /x";
      const r = cli(
        [
          "decide",
          "--kind",
          kind,
          "--subject",
          "s",
          "--value",
          broken,
          "--as",
          "peer",
        ],
        d,
      );
      assert.notEqual(
        r.code,
        0,
        `${kind} needs structure; broken JSON must not be taken as a string`,
      );
      const spec = kindSpec(kind);
      assert.ok(
        r.all.includes(kind),
        "the refusal must say which kind was expected",
      );
      assert.ok(
        r.all.includes(spec.shape.summary),
        "the refusal must state the shape expected",
      );
      assert.ok(
        r.all.includes(JSON.stringify(spec.shape.example)),
        "the refusal must show a valid example",
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("a JSON object is still refused for a kind that takes a string", () => {
  // The inference is kind-aware, not a blanket fallback: text that genuinely
  // parses to an object is an object, and an object is not a convention.
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "convention",
        "--subject",
        "s",
        "--value",
        '{"shape":"{message, data, success}"}',
        "--as",
        "peer",
      ],
      d,
    );
    assert.notEqual(r.code, 0, "an object is not a convention string");
    assert.ok(r.all.includes(kindSpec("convention").shape.summary));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an unknown kind is refused as an unknown kind, not as a broken value", () => {
  const d = box();
  try {
    const r = cli(
      [
        "decide",
        "--kind",
        "nope",
        "--subject",
        "s",
        "--value",
        "{not json",
        "--as",
        "peer",
      ],
      d,
    );
    assert.notEqual(r.code, 0);
    assert.match(
      r.all,
      /Unknown kind/,
      "the kind is what is wrong here, and the message must say so",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * the contract path reads the same definition                       *
 * ---------------------------------------------------------------- */

test("a contract rejected for a bad value shape also gets the rule and the example", () => {
  const d = box();
  const file = join(d, "c.json");
  try {
    const contract = {
      id: "c",
      goal: "g",
      scope: { in: [], out: [] },
      decisions: [
        {
          kind: "api-contract",
          subject: "orders",
          value: { path: "/orders", status: "201 on success" },
        },
      ],
      units: [{ id: "u", goal: "g", files: [], mayDecide: [], dependsOn: [] }],
      acceptance: [{ id: "a", statement: "s", check: "true", unit: "u" }],
    };
    writeFileSync(file, JSON.stringify(contract), "utf8");
    const r = cli(["spec", "--from", file], d);
    assert.notEqual(r.code, 0);
    const spec = kindSpec("api-contract");
    assert.ok(
      r.all.includes(spec.shape.summary),
      "the contract refusal must state the rule too",
    );
    assert.ok(
      r.all.includes(JSON.stringify(spec.shape.example)),
      "the contract refusal must show an example too",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * the comma-separated enum: refused, but answerably                 *
 *                                                                   *
 * Reported from a full fleet run: `--value pending,paid,shipped` for *
 * an enum is a reasonable thing to type and was refused without      *
 * saying what shape was wanted. It is still refused — see the        *
 * reasoning on commaHint in compare.ts — but the refusal now carries *
 * the shape, an example, and the author's own items as the JSON they *
 * would be, so the correction costs no round trip.                   *
 * ---------------------------------------------------------------- */

test("REGRESSION: a comma list for an enum is refused with the shape and the fix", () => {
  const d = box();
  try {
    const r = cli(["decide", "--kind", "enum", "--subject", "run states",
      "--value", "pending,paid,shipped", "--as", "peer"], d);
    assert.notEqual(r.code, 0, "a comma list is not a JSON array");

    const spec = kindSpec("enum");
    assert.ok(r.all.includes(spec.shape.summary), "the refusal must state the shape an enum takes");
    assert.ok(r.all.includes(JSON.stringify(spec.shape.example)), "the refusal must show a valid example");
    // The author's own members, as the array they would be: a paste, not a guess.
    assert.ok(
      r.all.includes(JSON.stringify(["pending", "paid", "shipped"])),
      "the refusal must show the value that was sent as the JSON array it would be",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a comma list is never silently split into members", () => {
  const d = box();
  try {
    cli(["decide", "--kind", "enum", "--subject", "run states",
      "--value", "pending,paid,shipped", "--as", "peer"], d);
    const after = cli(["check", "--json"], d);
    assert.equal(JSON.parse(after.out).decisionsConsidered, 0, "nothing may be recorded from an ambiguous value");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an enum member may contain a comma, which is why commas are not split", () => {
  // The case that makes splitting unsafe: one member, one comma inside it.
  const d = box();
  try {
    const r = cli(["decide", "--kind", "enum", "--subject", "capture states",
      "--value", '["paid, awaiting capture","settled"]', "--as", "peer", "--json"], d);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.out).value, ["paid, awaiting capture", "settled"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * found while making the published shapes true                      *
 * ---------------------------------------------------------------- */

test("a null status is unspecified, not status 0", () => {
  // Number(null) is 0, so a null status was stored as 0 — not a status, and it
  // contradicts every real one. The schema published it as an integer, so the
  // two could not both be right.
  const d = box();
  try {
    const r = cli(["decide", "--kind", "api-contract", "--subject", "orders",
      "--value", '{"method":"POST","path":"/orders","status":null}', "--as", "peer", "--json"], d);
    assert.equal(r.code, 0, r.all);
    assert.equal(JSON.parse(r.out).value.status, null, "null must mean unspecified");

    // And an unspecified status does not contradict a specified one.
    const second = cli(["decide", "--kind", "api-contract", "--subject", "orders",
      "--value", '{"method":"POST","path":"/orders","status":201}', "--as", "other"], d);
    assert.equal(second.code, 0, `a specified status must not clash with an unspecified one:\n${second.all}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a nullable that is not a boolean is refused rather than coerced", () => {
  // Boolean("false") is true, so this used to be recorded as the opposite of
  // what was written — into a log other workers implement from.
  const d = box();
  try {
    const r = cli(["decide", "--kind", "schema", "--subject", "order id",
      "--value", '{"field":"id","type":"uuid","nullable":"false"}', "--as", "peer"], d);
    assert.notEqual(r.code, 0, '"false" must not be recorded as nullable: true');
    assert.ok(r.all.includes("nullable"), "the message must name the field");
    assert.ok(r.all.includes(kindSpec("schema").shape.summary), "and state the shape");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an omitted nullable stays unspecified", () => {
  const d = box();
  try {
    const r = cli(["decide", "--kind", "schema", "--subject", "order id",
      "--value", '{"field":"id","type":"UUID"}', "--as", "peer", "--json"], d);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.out).value, { field: "id", type: "uuid", nullable: null });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
