#!/usr/bin/env node
/**
 * Refuse to publish anything other than what is on main.
 *
 * 0.2.0 reached npm as a build of an older tree: the tarball contained none
 * of the five fixes that had been committed, CI-green and pushed before the
 * publish ran. Whatever the mechanism — a resumed run, a stale pack —
 * nothing in the publish path noticed the artefact did not match the
 * repository, and the MCP registry then pointed at it.
 *
 * This checks the three things that would have caught it: the tree is clean,
 * HEAD is on the branch that publishes, and HEAD is what the remote has. It
 * prints the commit, so the publish log records what was actually shipped.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const run = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const die = (msg) => { console.error(`\nrefusing to publish: ${msg}\n`); process.exit(1); };

if (process.env.ORCHESTRAGUARD_SKIP_PUBLISH_GUARD === "1") {
  console.warn("publish guard skipped by request");
  process.exit(0);
}

let head, branch;
try {
  head = run("rev-parse", "HEAD");
  branch = run("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  // Publishing from an extracted tarball or a checkout without git metadata.
  console.warn("publish guard: not a git checkout, skipping");
  process.exit(0);
}

const dirty = run("status", "--porcelain");
if (dirty) die(`the working tree has uncommitted changes:\n${dirty}`);
if (branch !== "main") die(`HEAD is on "${branch}", not main`);

let remote;
try {
  remote = run("rev-parse", "origin/main");
} catch {
  die("no origin/main to compare against — fetch first");
}
if (remote !== head) {
  die(`HEAD (${head.slice(0, 7)}) is not origin/main (${remote.slice(0, 7)}).\n` +
      `  Push first, so that what is published is what the repository shows.`);
}

const { version } = createRequire(import.meta.url)("../package.json");
console.log(`publishing ${version} from ${head.slice(0, 7)} on main, tree clean`);
