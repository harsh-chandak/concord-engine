#!/usr/bin/env node
/**
 * Does the MCP server start the way the plugin says it will, speak the
 * protocol, and offer every tool?
 *
 * Written against the raw stdio framing rather than the SDK client, because
 * the SDK is an optional peer: a test that imported it would pass for reasons
 * the installed user does not share. Node builtins only.
 *
 * The launch is read out of .claude-plugin/plugin.json rather than written
 * here, so this proves the mechanism a session actually uses. It used to be
 * `npx -y -p concord-engine@0.3.2 ... concord-engine-mcp`, which put the
 * network and the npm cache in front of every session start; a cache entry
 * with node_modules/ and no package.json made npm exit ENOENT before the
 * server spoke, and the host could only report CONNECTION_CLOSED. Hardcoding
 * `node dist/mcp.js` here would have passed throughout that outage.
 *
 * The handshake runs once per CONCORD_ENGINE_DIR a host can really hand over:
 * a set value, unset, empty, and the literal unexpanded placeholder left
 * behind when the user configured nothing. All four must reach initialize — a
 * server that throws on its own default config is a server nobody can start.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, ".claude-plugin", "plugin.json");

/** Every tool the server promises. v0.1 first, then the v0.2 loop. */
const EXPECTED = [
  "record_decision",
  "binding_decisions",
  "open_conflicts",
  "record_attempt",
  "status",
  "write_contract",
  "bind_contract",
  "brief_unit",
  "fleet_plan",
  "run_acceptance",
  "generate_docs",
  "cost_report",
];

const TIMEOUT_MS = 20_000;

function die(message, detail) {
  process.stderr.write(`\nmcp-smoke: ${message}\n`);
  if (detail) process.stderr.write(`${String(detail).trim()}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

/**
 * The command a host would run, with ${CLAUDE_PLUGIN_ROOT} expanded to the
 * plugin root — here, this checkout. The same substitution Claude Code makes.
 */
function declaredLaunch() {
  if (!existsSync(MANIFEST)) die(`${MANIFEST} is missing`);
  const server = JSON.parse(readFileSync(MANIFEST, "utf8")).mcpServers?.[
    "concord-engine"
  ];
  if (!server) die("plugin.json declares no concord-engine mcpServer");
  const expand = (s) =>
    s.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT.replace(/\/$/, ""));

  // `node` means this interpreter. Anything else is a package manager or a
  // shim, and the point of the current launch is that there is not one.
  if (expand(server.command) !== "node") {
    die(
      `plugin.json launches "${server.command}", not node — the network is back in session start`,
      JSON.stringify(server),
    );
  }
  const args = (server.args ?? []).map(expand);
  const script = args.find((a) => a.endsWith(".js"));
  if (!script) die("the declared launch names no script", JSON.stringify(args));
  if (!existsSync(script))
    die(`${script} is missing. Run \`npm run build\` first.`);
  return { args, script };
}

const { args, script } = declaredLaunch();

/**
 * One full handshake against a freshly spawned server, launched exactly as
 * declared. Resolves with serverInfo and the tool list, or dies with whatever
 * the server put on stderr.
 */
function handshake(label, dirValue) {
  return new Promise((resolve) => {
    // A throwaway cwd, so a smoke test can never touch the project's own log —
    // including in the cases where the server falls back to a relative default.
    const sandbox = mkdtempSync(join(tmpdir(), "og-smoke-"));
    const env = { ...process.env };
    if (dirValue === undefined) delete env.CONCORD_ENGINE_DIR;
    else env.CONCORD_ENGINE_DIR = dirValue;

    const child = spawn(process.execPath, args, {
      cwd: sandbox,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
    });

    /** Resolved by id as responses arrive; the server may interleave them. */
    const pending = new Map();
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      // Stdio framing is newline-delimited JSON, one message per line.
      for (
        let nl = buffer.indexOf("\n");
        nl !== -1;
        nl = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          die(`[${label}] server wrote a line that is not JSON`, line);
        }
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter(msg);
        }
      }
    });

    child.on("exit", (code, signal) => {
      if (pending.size)
        die(
          `[${label}] server exited (code ${code}, signal ${signal}) before answering`,
          stderr,
        );
    });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    let nextId = 1;
    const request = (method, params) =>
      new Promise((done) => {
        const id = nextId++;
        pending.set(id, done);
        send({ jsonrpc: "2.0", id, method, params });
      });

    // A hung server is a failure, not a reason for CI to sit there.
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      die(`[${label}] no answer within ${TIMEOUT_MS / 1000}s`, stderr);
    }, TIMEOUT_MS);
    watchdog.unref?.();

    const stop = () => {
      clearTimeout(watchdog);
      child.stdin.end();
      child.kill("SIGKILL");
    };

    (async () => {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-smoke", version: "0" },
      });
      if (init.error) {
        stop();
        die(
          `[${label}] initialize failed: ${JSON.stringify(init.error)}`,
          stderr,
        );
      }
      if (!init.result?.serverInfo?.name) {
        stop();
        die(
          `[${label}] initialize returned no serverInfo`,
          JSON.stringify(init),
        );
      }

      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

      const listed = await request("tools/list", {});
      if (listed.error) {
        stop();
        die(
          `[${label}] tools/list failed: ${JSON.stringify(listed.error)}`,
          stderr,
        );
      }
      const tools = listed.result?.tools;
      if (!Array.isArray(tools)) {
        stop();
        die(
          `[${label}] tools/list returned no tools array`,
          JSON.stringify(listed),
        );
      }

      stop();
      resolve({ serverInfo: init.result.serverInfo, tools });
    })().catch((err) => {
      // Every expected failure above calls die(), which exits. Reaching here
      // means something threw that the probe did not anticipate. Without this
      // the rejection is unhandled and the enclosing promise never settles, so
      // the run hangs to the watchdog and reports a timeout — hiding the real
      // error behind the one symptom that looks like a slow server.
      stop();
      die(`[${label}] probe threw: ${err?.message ?? err}`, err?.stack);
    });
  });
}

// The four values a host can really hand over. A user who configured no
// directory is the common case, and the one that used to be least tested.
const CASES = [
  ["configured", mkdtempSync(join(tmpdir(), "og-smoke-dir-"))],
  ["unset", undefined],
  ["empty", ""],
  ["unexpanded placeholder", "${user_config.decisions_dir}"],
];

let first;
for (const [label, value] of CASES) {
  const { serverInfo, tools } = await handshake(label, value);
  const names = tools.map((t) => t.name);
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) {
    die(
      `[${label}] the server does not expose: ${missing.join(", ")}`,
      `it exposes: ${names.join(", ") || "(none)"}`,
    );
  }
  // Every tool has to be callable, which means a usable input schema.
  const unusable = tools.filter(
    (t) => !t.description?.trim() || t.inputSchema?.type !== "object",
  );
  if (unusable.length) {
    die(
      `[${label}] these tools lack a description or an object inputSchema: ${unusable.map((t) => t.name).join(", ")}`,
    );
  }
  process.stdout.write(
    `  ok  CONCORD_ENGINE_DIR ${label}: initialized, ${names.length} tools\n`,
  );
  first ??= { serverInfo, names };
}

const extra = first.names.filter((n) => !EXPECTED.includes(n));
process.stdout.write(
  `mcp-smoke: ${first.serverInfo.name} v${first.serverInfo.version} launched as plugin.json declares ` +
    `(node ${script.replace(ROOT, "<plugin root>/")}), all ${CASES.length} env cases initialized, ` +
    `lists all ${EXPECTED.length} tools${extra.length ? ` (plus ${extra.join(", ")})` : ""}\n`,
);
process.exit(0);
