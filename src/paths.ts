/**
 * Paths: the one glob matcher, and the one path extractor.
 *
 * `units[].files` was documentation until now — a list of globs handed to a
 * worker in its brief and never matched against anything, so nothing in the
 * package needed a matcher and there was none. This file is deliberately the
 * only one: a second matcher with slightly different semantics would mean
 * `files` meant one thing in the brief and another in the gate, which is the
 * class of bug this package exists to refuse.
 *
 * The extractor is a heuristic and says so. It reads an arbitrary shell string
 * statically, which cannot be done exactly, so every rule below is biased the
 * same way: when in doubt, extract nothing. A missed target leaves the hole
 * slightly open; a spurious one accuses a correct contract of being broken,
 * and a gate that cries wolf gets switched off.
 */

/* ---------------------------------------------------------------- *
 * the matcher                                                       *
 * ---------------------------------------------------------------- */

/** Drops a leading "./" and collapses repeated separators. Not a resolver. */
export function normalizeRelPath(p: string): string {
  return p.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

const GLOB_CHARS = /[*?[\]]/;
const REGEX_SPECIALS = /[.+^${}()|\\]/g;

/**
 * Glob semantics for `units[].files`, stated once so they can be relied on:
 *
 *   `**`  any number of path segments, including none
 *   `*`   any run of characters inside one segment
 *   `?`   one character, not a separator
 *
 * A pattern with no glob characters whose last segment carries no extension is
 * read as a directory and covers everything under it — because `files: ["src"]`
 * is how people write "this unit owns src", and reading it as one
 * extensionless file would flag correct contracts.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const p = normalizeRelPath(path);
  const raw = normalizeRelPath(pattern);
  if (!p || !raw) return false;
  if (globToRegExp(raw).test(p)) return true;

  const last = raw.slice(raw.lastIndexOf("/") + 1);
  const dirLike = !GLOB_CHARS.test(raw) && (pattern.endsWith("/") || !last.includes("."));
  return dirLike && globToRegExp(`${raw}/**`).test(p);
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let out = "^";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      // Zero or more whole segments, which is why `src/**/*.ts` covers
      // `src/a.ts` as well as `src/d/a.ts`.
      out += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    out += seg.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) out += "/";
  });
  return new RegExp(`${out}$`);
}

/** True when any one of the unit's globs covers the path. */
export function ownsPath(path: string, files: readonly string[]): boolean {
  return files.some((f) => matchesGlob(path, f));
}

/**
 * True when the globs cover the path, or declare anything beneath it.
 *
 * The second half is what a scope entry needs and a check target does not.
 * `scope.in: ["src/api/"]` against `files: ["src/api/**"]` is one area written
 * two ways: the glob does not match the bare directory, but a unit that owns
 * everything inside plainly covers it. Without this rule the audit fires on
 * most real contracts, which is the failure mode that gets a gate switched
 * off. A check target is a single file and gets no such benefit of the doubt.
 */
export function ownsArea(path: string, files: readonly string[]): boolean {
  if (ownsPath(path, files)) return true;
  const area = `${normalizeRelPath(path)}/`;
  return files.some((f) => normalizeRelPath(f).startsWith(area));
}

/* ---------------------------------------------------------------- *
 * the extractor                                                     *
 * ---------------------------------------------------------------- */

/**
 * Directory names that belong to nobody in particular.
 *
 * Two groups, excluded for one reason — a unit cannot sensibly declare them,
 * so finding one unowned proves nothing. Generated and vendored trees (`dist`,
 * `node_modules`) are built, not authored. Shared test material (`fixtures`,
 * `testdata`, `__snapshots__`) is used by every unit and owned by none, and
 * deciding which unit "really" owns a fixture is exactly the guess this file
 * refuses to make.
 */
const UNOWNABLE_SEGMENTS = new Set([
  // generated, vendored or transient
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  ".git", ".cache", ".next", ".nuxt", ".venv", "venv", "__pycache__",
  "tmp", "temp", ".pytest_cache", ".tox", ".turbo", ".gradle",
  // shared test material
  "fixtures", "fixture", "__fixtures__", "testdata", "test-data",
  "snapshots", "__snapshots__", "golden", "goldens",
  "mocks", "__mocks__", "examples", "samples",
]);

/** Shell punctuation that separates commands rather than naming anything. */
const OPERATORS = new Set(["&&", "||", "|", ";", "&", ">", ">>", "<", "<<", "(", ")", "{", "}", "!"]);

/**
 * Splits on whitespace while keeping a quoted run together, so
 * `--config="a b/c.json"` stays one token instead of two halves that each look
 * like nonsense. This is not a shell parse and does not try to be.
 */
function tokenize(command: string): string[] {
  const runs = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return runs.map((t) => t.replace(/["']/g, ""));
}

/**
 * Whether a token is plausibly a path inside this repo that a unit could own.
 *
 * The load-bearing rule is the last one: a token must contain a separator.
 * Without it, every root-level config a command names — `tsconfig.json`,
 * `package.json`, `Makefile`, `pytest.ini` — reads as an unowned path, and
 * those are legitimately owned by no unit. Requiring a separator costs the
 * bare-filename case (`node verify.mjs`) and buys out that whole class of
 * false accusation. That trade is the point.
 */
function isPathLike(token: string): boolean {
  if (!token || /\s/.test(token)) return false;
  if (token.includes("://")) return false;                          // a URL
  if (token.startsWith("@")) return false;                          // @scope/package
  if (/[$`]/.test(token)) return false;                             // needs a shell to resolve
  if (GLOB_CHARS.test(token) || token.includes("{")) return false;  // a set, not a file
  if (token.startsWith("/") || token.startsWith("~")) return false; // outside the repo
  if (token.split("/").includes("..")) return false;                // climbs out of the tree
  return token.includes("/");
}

/**
 * Relative paths a free string plausibly refers to.
 *
 * Used on two kinds of string, which is why it is named for neither: an
 * acceptance criterion's shell command, and a `scope.in` entry — which the
 * schema calls an array of strings and which real contracts fill with
 * sentences as often as with paths.
 *
 * Known limits, stated rather than discovered later:
 *   - a bare filename (`node verify.mjs`) is not extracted; see isPathLike
 *   - a globbed target (`test/*.test.js`) is not extracted, so the files
 *     behind the glob are never checked for an owner
 *   - anything a shell has to expand (`$DIR/x`, `$(...)/x`) is not extracted
 *   - a path inside a generated or shared-fixture directory is not extracted
 *   - a token that reads like a path but means something else to the program
 *     being run may still be extracted, and would then be reported as
 *     unowned. That is the residual false-positive risk.
 */
export function pathTokens(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of argumentTokens(text)) {
    if (!isPathLike(candidate)) continue;
    const path = normalizeRelPath(candidate);
    if (path.split("/").some((s) => UNOWNABLE_SEGMENTS.has(s))) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    found.push(path);
  }
  return found;
}

/** A filename with an extension and no directory part. */
const BARE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,6}$/;

/**
 * Bare filenames a string names — `SKILL.md` in
 * `grep -q 'brief' SKILL.md`, with no directory to place it.
 *
 * Kept apart from pathTokens because it may not be used the same way. A bare
 * name at the repo root is as likely to be `package.json`, `manage.py` or
 * `server.js` — which no unit should own and which a command reads rather than
 * produces — as it is to be a deliverable. So a caller must never conclude
 * "nobody owns this" from one; see auditAcceptanceOwnership, which only uses
 * these to notice that a DIFFERENT unit has explicitly declared the name.
 */
export function bareFileTokens(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of argumentTokens(text)) {
    if (candidate.includes("/") || !BARE_FILE.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/**
 * The tokens of a string that could be naming something, with the shell
 * punctuation, flags and environment assignments dropped. Shared by both
 * extractors so they cannot drift apart on what counts as an argument.
 */
function argumentTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (OPERATORS.has(token)) continue;

    let candidate = token;
    if (candidate.startsWith("-")) {
      // A bare flag names nothing; `--flag=value` may name a real target.
      const eq = candidate.indexOf("=");
      if (eq === -1) continue;
      candidate = candidate.slice(eq + 1);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate)) {
      // NAME=value — an environment assignment. Its value is not the
      // command's target, so the token is skipped whole rather than half-read.
      continue;
    }

    // `pytest path/to/test.py::test_name` — the selector is not part of the path.
    out.push(candidate.split("::")[0].replace(/[,;:]+$/, ""));
  }
  return out;
}
