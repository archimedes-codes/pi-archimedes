import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── The rule (issue #156, docs/features/session-state.md) ───────────────────
//
// Pi caches an extension MODULE per process and re-invokes its factory with a
// fresh `pi` for every session. A `let` at module scope therefore belongs to the
// PROCESS, not to a session — and a subordinate in-process session (a subagent
// child, bound with no uiContext) running its `session_shutdown` clears the LIVE
// session's state through it, silently. That is #156: `image-paste`, `ui` and
// `meta` all shipped the shape, and no test caught it — `packages/subagent`
// forks a separate process, so the suite's own package cannot reproduce it.
//
// The rule is NOT "no `let` at module scope". Plenty of module state is honestly
// process-wide and must not be flagged: the footer's git/jj/token-stat caches,
// `core/src/bridge/channel.ts` (one socket per process), `diff/src/shiki.ts`,
// `diff/src/ansi/codes.ts`, `diff/src/render/shared.ts`, `ui/src/thinking/theme.ts`.
// What makes a module binding a bug is that a SESSION HANDLER can write it —
// `session_start`, `session_shutdown`, `session_before_switch` or `turn_start`
// are the handlers pi fires per session, so anything they assign is per-session
// state wearing process clothing.
//
// So the rule is ASSIGNMENT REACHABILITY over three hops:
//   hop 1  a module-scope `let`/`var` assigned inside such a handler body, or
//   hop 2  assigned inside the body of a function that a handler body calls
//          directly, IN THE SAME FILE, or
//   hop 3  assigned in ANOTHER FILE, inside the body of a function the handler
//          body calls through a NAMED import (see blind spot 1 for what that
//          excludes).
// Hop 2 is mandatory, not thoroughness: #156's actual assignment was
// `_queue = null` inside `shutdownQueue()`/`initImagePasteSession()`, one call
// away from the handler. A one-hop rule reports green over the bug that shipped,
// which is the exact failure this file exists to prevent. The anti-vacuity
// fixture below is that shape and nothing weaker.
//
// The escape hatch is the one Decision 2 chose: key the state by session id in a
// `Map` and mutate it through `.set()`/`.delete()`. The contents change, the
// binding does not, so nothing is assigned and the guard stays green — the
// liveness test pins the `let`-Map form specifically, because a `const` Map
// would pass for the wrong reason (the collector never looks at `const` at all).
//
// ── Blind spots, stated plainly: this is a BLIND SPOT, NOT COVERAGE ─────────
//
// 1. ONE IMPORT HOP, NAMED IMPORTS ONLY. The rule follows a handler body across
//    exactly ONE module boundary: a function the handler calls by name that the
//    file IMPORTS by name (`import { setConfigGetter } from "./shiki.js"`, with
//    `as` aliases honoured and `import type` ignored), resolved through a barrel
//    (`export { x } from "./other.js"`, also with renames, bounded so a cycle
//    cannot hang the test) to the file that declares it. Inside that TARGET file
//    the walk is transitive — the entry function plus anything it calls there.
//    The hit is reported against the TARGET file and the target's declaration
//    line, so an allow-list entry still pins `file + exact trimmed declaration`.
//    Two walls remain, and both are deliberate:
//      - NAMESPACE IMPORTS are not followed. `CALLS` cannot match `events.onSessionStart(ctx)`,
//        and `import * as events` hands the resolver no symbol to look up, so
//        `core/src/bridge/index.ts:160` → `core/src/bridge/events.ts:38`
//        (`sessionCtx`) stays invisible. Following it would newly flag the five
//        honest one-socket-per-process bindings in `core/src/bridge/` with no
//        exemption category to put them in.
//      - DYNAMIC `import()` is not followed: `meta/src/index.ts:162` reaching
//        `@pi-archimedes/diff` from its own `session_start` stays invisible.
//    The `NAMESPACE_IMPORT_NOT_FOLLOWED` fixture pins the first wall so widening
//    it is an intentional edit rather than an accident. What this hop buys is
//    concrete: `ui/src/index.ts:183`'s `session_shutdown` → `stopStartupListing()`
//    at `:215` → `frameTimer`/`revealTimer` at `ui/src/startup/index.ts:171-172`
//    is now a REAL hit that needs a REAL entry (it has two), not a green the
//    guard grants because it cannot see.
// 2. An assignment inside a closure a handler passes ELSEWHERE is not followed
//    either — the callback is not a `pi.on` handler body. image-paste's
//    `registerShortcut` callback assigned `_pasting` pre-fix and would not be
//    reached by this rule on its own. That is precisely why the anti-vacuity
//    fixture reproduces the shape that IS followed (a named function a handler
//    calls) rather than the one that is not. Hop 3 respects this wall too: it
//    collects the handler body's call surface with nested closures blanked, so a
//    call made inside `ctx.ui.setFooter((…) => { render() { … } })` never starts
//    one — which is what keeps the footer's git/jj/token-stat caches, named
//    above as honest process state, out of the report.
// 3. The assignment test is `name = …`. Compound and logical assignment
//    (`count += 1`, `cache ||= …`) is not matched, and neither is a handler
//    registered through anything other than a literal `pi.on("…")` call.
//
// Widening any of these is a change to the rule, not to this file's allow-list.

const SESSION_EVENTS = ["session_start", "session_shutdown", "session_before_switch", "turn_start"];

interface ViolationRule {
  /** What shape of per-session state at module scope this catches. */
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * The collector: module-scope mutable bindings. Anchored at column 0 (with an
 * optional `export`), which is what "module scope" means in a tree that indents
 * every function body — a `let` inside `register()` is per-registration and is
 * exactly what the rule asks for, so it must not be collected. `const` is out of
 * scope by design: a `const` binding cannot be assigned, and a session-keyed
 * `const` Map is the prescribed fix.
 */
const COLLECTOR: ViolationRule = {
  label: "module-scope binding assigned by a session handler",
  pattern: /^(?:export\s+)?(?:let|var)\s+(\w+)/m,
};

const RULES: readonly ViolationRule[] = [COLLECTOR];

/**
 * Known violations, each with the one-line reason that keeps it, and the
 * removal point. Matched on the file plus the EXACT TRIMMED LINE — the guard
 * reports the DECLARATION line of the offending binding, so these are
 * declaration lines, not assignment sites — so a *new* violation in an exempt
 * file still fails the guard.
 */
interface AllowEntry {
  readonly file: string;
  readonly line: string;
  readonly reason: string;
}

const ALLOW_LIST: readonly AllowEntry[] = [
  {
    file: "packages/notify/src/index.ts",
    line: "let notifyTimer: ReturnType<typeof setTimeout> | null = null;",
    reason:
      "The circuit breaker's pending timer. A foreign session's shutdown runs cancelPending() and cancels the LIVE session's delayed notification. Minor (a missed alert, not a dead feature), so deferred rather than widened into the rule. follow-up: tsk_9a0926e5-2d94-43bd-941a-ccf9ffe06bd7",
  },
  {
    file: "packages/notify/src/index.ts",
    line: "let pendingTrigger: TriggerType | null = null;",
    reason:
      "The trigger the pending timer will fire, same mechanism and same deferral as notifyTimer: a foreign shutdown clears it and the live session's notification is lost. follow-up: tsk_9a0926e5-2d94-43bd-941a-ccf9ffe06bd7",
  },
  {
    file: "packages/ui/src/startup/index.ts",
    line: "let frameTimer: ReturnType<typeof setInterval> | undefined;",
    reason:
      "The splash's frame timer, cleared by `stopStartupListing()`; reached from `packages/ui/src/index.ts`'s `session_shutdown` one module away and ownership-gated by `weInstalledTheSplash`, so a foreign session's shutdown cannot reach it — worst case a cut-short splash reveal. Deferred, not fixed. follow-up: tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2",
  },
  {
    file: "packages/ui/src/startup/index.ts",
    line: "let revealTimer: ReturnType<typeof setTimeout> | undefined;",
    reason:
      "The splash's reveal timer, same mechanism as frameTimer: cleared by `stopStartupListing()`, reached from `packages/ui/src/index.ts`'s `session_shutdown` one module away, gated by `weInstalledTheSplash`. Worst case a cut-short splash reveal. Deferred, not fixed. follow-up: tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2",
  },
];

// ── Walking the tree ────────────────────────────────────────────────────────

/** Repo root, resolved from this file (`packages/core/src` → repo root). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Every `packages/<name>/src` directory, plus `meta/src`.
function sourceDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(REPO_ROOT, "packages", entry.name, "src");
    if (existsSync(src)) dirs.push(src);
  }
  const metaSrc = join(REPO_ROOT, "meta", "src");
  if (existsSync(metaSrc)) dirs.push(metaSrc);
  return dirs;
}

/** Source files under those trees, excluding tests (which fake sessions). */
function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(relative(REPO_ROOT, full).split(/[\\/]/).join("/"));
      }
    }
  };
  for (const dir of sourceDirs()) walk(dir);
  return out.sort();
}

// ── The matcher ─────────────────────────────────────────────────────────────

export interface Hit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Index just past the closing quote of the string literal starting at `open`. */
function skipQuoted(src: string, open: number): number {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === quote) return i + 1;
  }
  return src.length;
}

/** Index just past the closing backtick of the template literal at `open`. */
function skipTemplate(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === "`") return i + 1;
    else if (src[i] === "$" && src[i + 1] === "{") {
      const past = matchBracket(src, i + 1);
      i = past === -1 ? src.length : past - 1;
    }
  }
  return src.length;
}

/** Step over a comment, returning the next index to examine. */
function skipComment(src: string, i: number): number {
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  return i + 1;
}

/** Index just past the bracket matching the opener at `open`, or -1 if unclosed. */
function matchBracket(src: string, open: number): number {
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c === "(" ? ")" : c === "[" ? "]" : "}");
      i += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      i += 1;
      if (stack.length === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** Split `src[start, end)` on its top-level commas. */
function splitTopLevel(src: string, start: number, end: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      spans.push([from, i]);
      from = i + 1;
    }
    i += 1;
  }
  spans.push([from, end]);
  return spans;
}

/** First index of `needle` in `src[start, end)`, or -1. */
function indexOfIn(src: string, needle: string, start: number, end: number): number {
  const at = src.indexOf(needle, start);
  return at >= end ? -1 : at;
}

/** First whole-word occurrence of `word` in `src[start, end)`, or -1. */
function indexOfWord(src: string, word: string, start: number, end: number): number {
  const re = new RegExp(`\\b${word}\\b`, "g");
  re.lastIndex = start;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m.index >= end) break;
    return m.index;
  }
  return -1;
}

/**
 * The body of the function expression written in `src[start, end)`: an arrow
 * (`(x) => { … }` or `(x) => expr`), a `function` expression, or an `async`
 * variant of either. Arrow bodies without braces are the whole rest of the
 * expression, which is what `pi.on("input", () => cancelPending())` means.
 */
function lambdaBody(src: string, start: number, end: number): string | undefined {
  const fnIdx = indexOfWord(src, "function", start, end);
  const arrowIdx = indexOfIn(src, "=>", start, end);

  if (fnIdx !== -1 && (arrowIdx === -1 || fnIdx < arrowIdx)) {
    const params = src.indexOf("(", fnIdx);
    if (params === -1 || params >= end) return undefined;
    const pastParams = matchBracket(src, params);
    if (pastParams === -1 || pastParams > end) return undefined;
    const brace = src.indexOf("{", pastParams);
    if (brace === -1 || brace >= end) return undefined;
    const pastBody = matchBracket(src, brace);
    if (pastBody === -1) return undefined;
    return src.slice(brace + 1, pastBody - 1);
  }

  if (arrowIdx === -1) return undefined;
  let i = arrowIdx + 2;
  while (i < end && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i += 1;
  if (src.startsWith("async", i)) {
    i += 5;
    while (i < end && /\s/.test(src[i] ?? "")) i += 1;
  }
  if (src[i] === "{") {
    const pastBody = matchBracket(src, i);
    return pastBody === -1 ? undefined : src.slice(i + 1, pastBody - 1);
  }
  return src.slice(i, end);
}

/** The body text of every `pi.on("<session event>", …)` handler in `src`. */
function handlerBodies(src: string): string[] {
  const call = new RegExp(`\\bpi\\.on\\(\\s*["'](?:${SESSION_EVENTS.join("|")})["']`, "g");
  const bodies: string[] = [];
  for (let m = call.exec(src); m !== null; m = call.exec(src)) {
    const open = src.indexOf("(", m.index);
    const end = matchBracket(src, open);
    if (end === -1) continue;
    const args = splitTopLevel(src, open + 1, end - 1);
    const handler = args[1];
    if (!handler) continue;
    const body = lambdaBody(src, handler[0], handler[1]);
    if (body !== undefined) bodies.push(body);
  }
  return bodies;
}

/** Index of the assignment `=` of a declaration whose name starts at `from`. */
function assignmentAt(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (c === ";" && depth === 0) return -1;
    else if (c === "=" && depth === 0) {
      const prev = src.slice(0, i).trimEnd().slice(-1);
      if (src[i + 1] === "=" || src[i - 1] === "=") {
        i += 1;
        continue;
      }
      if (src[i + 1] === ">" || "+-*/%&|^!<>".includes(prev)) {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Named functions this file can resolve a call to: every `function name(…)`,
 * plus every module-scope binding initialised from a function expression. This
 * is hop 2's lookup table — a call a handler body makes is only followed when it
 * names one of these, in this file.
 */
function functionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();

  for (const m of src.matchAll(/^(?:\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (!name) continue;
    const keyword = src.indexOf("function", m.index);
    const body = lambdaBody(src, keyword, src.length);
    if (body !== undefined && !bodies.has(name)) bodies.set(name, body);
  }

  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (!name) continue;
    const equal = assignmentAt(src, m.index + m[0].length);
    if (equal === -1) continue;
    const body = lambdaBody(src, equal + 1, statementEnd(src, equal));
    if (body !== undefined && !bodies.has(name)) bodies.set(name, body);
  }

  return bodies;
}

/** End of the statement containing `at` (the next top-level `;`, else EOF). */
function statementEnd(src: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) return i;
    i += 1;
  }
  return src.length;
}

/** Names a body calls as a plain function (not `obj.method()`, not keywords). */
const CALLS = /(?<![\w.])([A-Za-z_$][\w$]*)\s*\(/g;
const NON_FUNCTIONS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new", "do", "else",
]);

function calledNames(body: string): string[] {
  const names: string[] = [];
  const re = new RegExp(CALLS.source, "g");
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const name = m[1];
    if (name && !NON_FUNCTIONS.has(name)) names.push(name);
  }
  return names;
}

// ── The cross-module hop ────────────────────────────────────────────────────
//
// How far a name resolves, and how many boundaries the walk is allowed to cross.
// The hop is ONE boundary deep (the handler's file → the file it imports from),
// plus transitive WITHIN that target file. The depth bound below is not that
// boundary count — it is the barrel chain the resolver may follow to find where
// an imported symbol is actually declared, so a re-export cycle cannot hang the
// test.

const MAX_BARREL_HOPS = 4;

/** Where a local name came from: the symbol it is, and the specifier it came in on. */
interface ImportRef {
  readonly symbol: string;
  readonly spec: string;
}

const IDENT = "([A-Za-z_$][\\w$]*)";

function escapeName(name: string): string {
  return name.replace(/\$/g, "\\$");
}

/**
 * `localName → { symbol, spec }` for every NAMED import in `src`, `as` aliases
 * included. `import type { … }` and `type`-marked specifiers are skipped — they
 * name types, so a call site can never reach them — and so are default and
 * `import * as ns` forms: a namespace import gives the guard no symbol to look
 * up, which is the wall blind spot 1 still has.
 */
function parseImports(src: string): Map<string, ImportRef> {
  const imports = new Map<string, ImportRef>();
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/gm)) {
    const clause = m[1] ?? "";
    const spec = m[2] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    const open = clause.indexOf("{");
    const close = clause.lastIndexOf("}");
    if (open === -1 || close <= open) continue;
    for (const part of clause.slice(open + 1, close).split(",")) {
      const text = part.trim();
      if (text.length === 0 || /^type\s/.test(text)) continue;
      const m = new RegExp(`^${IDENT}(?:\\s+as\\s+${IDENT})?$`).exec(text);
      if (m === null) continue;
      const symbol = m[1];
      const local = m[2] ?? m[1];
      if (symbol && local) imports.set(local, { symbol, spec });
    }
  }
  return imports;
}

/** A path the tree can read: `.js` entry points are `.ts` sources in this repo. */
function tsVariants(path: string): string[] {
  return /\.(?:js|mjs|cjs)$/.test(path) ? [path.replace(/\.(js|mjs|cjs)$/, ".ts"), path] : [path];
}

function firstReadable(paths: readonly string[], tree: SourceTree): string | undefined {
  for (const path of paths) {
    if (tree.read(path) !== undefined) return path;
  }
  return undefined;
}

/** `packages/diff/src/index.ts` + `./render/index.js` → `packages/diff/src/render/index.ts`. */
function resolveRelative(fromFile: string, spec: string, tree: SourceTree): string | undefined {
  const base = normalize(join(dirname(fromFile), spec));
  return firstReadable(tsVariants(base).flatMap((p) => [p, `${p}/index.ts`]), tree);
}

/**
 * `@pi-archimedes/<pkg>[/<sub>]` → the file that package's `exports` map points
 * at, falling back to `packages/<pkg>/src/<sub>.ts`. Anything else — the
 * `@earendil-works/*` host packages, `node:*`, bare npm names — resolves to
 * nothing: the guard does not read outside this repo.
 */
function resolveWorkspacePackage(pkg: string | undefined, sub: string | undefined, tree: SourceTree): string | undefined {
  if (!pkg) return undefined;
  const manifest = tree.read(`packages/${pkg}/package.json`);
  if (manifest !== undefined) {
    try {
      const exportsField: unknown = (JSON.parse(manifest) as { exports?: unknown }).exports;
      if (exportsField !== null && typeof exportsField === "object" && !Array.isArray(exportsField)) {
        const value = (exportsField as Record<string, unknown>)[sub === undefined ? "." : `./${sub}`];
        if (typeof value === "string") {
          const target = firstReadable(tsVariants(normalize(`packages/${pkg}/${value.replace(/^\.\//, "")}`)), tree);
          if (target !== undefined) return target;
        }
      }
    } catch {
      // An unreadable manifest is simply not a hop.
    }
  }
  return firstReadable(tsVariants(sub === undefined ? `packages/${pkg}/src/index.ts` : `packages/${pkg}/src/${sub}.ts`), tree);
}

function resolveSpec(fromFile: string, spec: string, tree: SourceTree): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) return resolveRelative(fromFile, spec, tree);
  const pkg = /^@pi-archimedes\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (pkg) return resolveWorkspacePackage(pkg[1], pkg[2], tree);
  return undefined;
}

/**
 * Where `symbol` is actually declared, following `export { symbol } from "./other.js"`
 * barrels (honouring `as` renames) until a real `export function` / `const` /
 * `let` shows up. Returns the file plus the name it is declared under there, or
 * undefined when the chain runs out or cycles past `MAX_BARREL_HOPS`.
 */
function resolveDeclaration(
  file: string,
  symbol: string,
  tree: SourceTree,
  depth = 0,
): { file: string; symbol: string } | undefined {
  const src = tree.read(file);
  if (src === undefined) return undefined;
  const declares = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${escapeName(symbol)}\\b`, "m");
  if (declares.test(src)) return { file, symbol };
  if (depth >= MAX_BARREL_HOPS) return undefined;

  for (const m of src.matchAll(/^export\s+(?!type\s)\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)) {
    const spec = m[2] ?? "";
    for (const part of (m[1] ?? "").split(",")) {
      const m2 = new RegExp(`^${IDENT}(?:\\s+as\\s+${IDENT})?$`).exec(part.trim());
      if (m2 === null) continue;
      const declared = m2[1];
      const exported = m2[2] ?? m2[1];
      if (!declared || exported !== symbol) continue;
      const next = resolveSpec(file, spec, tree);
      if (next === undefined || next === file) continue;
      const found = resolveDeclaration(next, declared, tree, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Module-scope bindings `src` declares, with their declaration line and text. */
function moduleDeclarations(src: string): Array<{ name: string; line: number; text: string }> {
  const declarations: Array<{ name: string; line: number; text: string }> = [];
  src.split("\n").forEach((text, i) => {
    for (const rule of RULES) {
      const m = rule.pattern.exec(text);
      const name = m?.[1];
      if (name) declarations.push({ name, line: i + 1, text: text.trim() });
    }
  });
  return declarations;
}

/** Matches an assignment (never a comparison, never a compound form) to `name`. */
function assignmentPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w.])${escapeName(name)}\\s*=[^=]`);
}

/**
 * Every body in `src` the entry function can reach by calling other functions of
 * the SAME file, transitively — the target half of the cross-module hop. Bounded
 * by the `seen` set, so a call cycle terminates.
 */
function bodiesReachedFrom(entry: string, scopes: Map<string, string>): Set<string> {
  const bodies = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const body = scopes.get(name);
    if (body === undefined) continue;
    bodies.add(body);
    queue.push(...calledNames(body));
  }
  return bodies;
}

/**
 * Hop 3's target side: the bindings THIS file declares that the entry function
 * (or anything it calls, in this file) assigns. Reported against this file and
 * this file's declaration line, so the allow-list keeps matching
 * `file + exact trimmed declaration line`.
 */
function violationsAtTarget(file: string, entry: string, tree: SourceTree): Hit[] {
  const src = tree.read(file);
  if (src === undefined) return [];
  const declarations = moduleDeclarations(src);
  if (declarations.length === 0) return [];
  const bodies = bodiesReachedFrom(entry, functionBodies(src));
  if (bodies.size === 0) return [];
  return declarations
    .filter((decl) => {
      const assigned = assignmentPattern(decl.name);
      return [...bodies].some((body) => assigned.test(body));
    })
    .map((decl) => ({ file, line: decl.line, rule: COLLECTOR.label, text: decl.text }));
}

/** End of an arrow's expression body: the next top-level `,` `)` `]` `;` or `}`. */
function expressionEnd(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}" || c === ";" || c === ",") {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  return src.length;
}

/**
 * `src` with the bodies of every nested function/arrow BLANKED (each non-newline
 * character replaced by a space, so line offsets survive). A closure written
 * inside a handler body is not the handler speaking — it runs when whatever
 * received it decides to, which is blind spot 2.
 */
function maskNestedLambdas(src: string): string {
  const chars = src.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const isSpace = (at: number): boolean => at >= src.length || /\s/.test(src[at] ?? "");

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (src.startsWith("function", i) && !/[\w$.]/.test(src[i - 1] ?? "") && !/[\w$]/.test(src[i + 8] ?? "")) {
      const params = src.indexOf("(", i + 8);
      const pastParams = params === -1 ? -1 : matchBracket(src, params);
      const brace = pastParams === -1 ? -1 : src.indexOf("{", pastParams);
      const pastBody = brace === -1 ? -1 : matchBracket(src, brace);
      if (pastBody === -1) {
        i += 8;
        continue;
      }
      blank(i, pastBody);
      i = pastBody;
      continue;
    }
    if (c === "=" && src[i + 1] === ">") {
      let j = i + 2;
      while (j < src.length && /\s/.test(src[j] ?? "")) j += 1;
      if (src.startsWith("async", j)) {
        j += 5;
        while (j < src.length && /\s/.test(src[j] ?? "")) j += 1;
      }
      if (src[j] === "{") {
        const pastBody = matchBracket(src, j);
        if (pastBody === -1) {
          i = j + 1;
          continue;
        }
        blank(j, pastBody);
        i = pastBody;
        continue;
      }
      const end = isSpace(j) ? j : expressionEnd(src, j);
      blank(j, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

/**
 * The names a handler body calls ITSELF. Hop 3 uses this narrower surface rather
 * than the flat `calledNames`: a call made inside a closure the handler hands to
 * `ctx.ui.setFooter()`/`setHeader()` is not a call the handler makes, and the
 * header's blind spot 2 says so. Following it would flag the footer's git/jj/
 * token-stat caches — state the header names as honest process-wide caching, and
 * which the rule must NOT flag — on the strength of a `render()` callback.
 */
function calledNamesAtHandlerLevel(bodies: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const body of bodies) {
    for (const name of calledNames(maskNestedLambdas(body))) names.add(name);
  }
  return names;
}

/** Apply the rule to one source file's text. Reports the DECLARATION line. */
function findViolationsInSource(src: string, file: string, tree: SourceTree = REPO_TREE): Hit[] {
  // A file with no session handler cannot start an assignment path at all — but
  // a file with no binding of its own CAN still be the origin of a cross-module
  // hit, so the declaration check stays inside the intra-file hops.
  const bodies = handlerBodies(src);
  if (bodies.length === 0) return [];

  const declarations = moduleDeclarations(src);
  const scopes = functionBodies(src);
  const reached = new Set<string>();
  for (const body of bodies) {
    for (const name of calledNames(body)) {
      if (scopes.has(name)) reached.add(name);
    }
  }
  // Hop 3's narrower surface: calls the handler body makes directly (see
  // `calledNamesAtHandlerLevel`). Hops 1 and 2 are unchanged.
  const handlerLevelCalls = calledNamesAtHandlerLevel(bodies);

  const hits: Hit[] = [];
  const seen = new Set<string>();
  const record = (hit: Hit): void => {
    const key = format(hit);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const decl of declarations) {
    const assigned = assignmentPattern(decl.name);
    // Hop 1: the handler body writes it itself.
    if (bodies.some((body) => assigned.test(body))) {
      record({ file, line: decl.line, rule: COLLECTOR.label, text: decl.text });
      continue;
    }
    // Hop 2: a function the handler body calls directly writes it.
    for (const name of reached) {
      if (assigned.test(scopes.get(name) ?? "")) {
        record({ file, line: decl.line, rule: COLLECTOR.label, text: decl.text });
        break;
      }
    }
  }

  // Hop 3: the handler calls a function it IMPORTED from another file, and the
  // write happens over there. Named imports only — a namespace import never
  // enters `parseImports`, and `CALLS` cannot match `ns.fn(` anyway, so
  // `core/src/bridge/index.ts` → `events.ts` stays invisible by design.
  const imports = parseImports(src);
  for (const name of handlerLevelCalls) {
    if (scopes.has(name)) continue;
    const imported = imports.get(name);
    if (imported === undefined) continue;
    const entryFile = resolveSpec(file, imported.spec, tree);
    if (entryFile === undefined) continue;
    const target = resolveDeclaration(entryFile, imported.symbol, tree);
    if (target === undefined || target.file === file) continue;
    for (const hit of violationsAtTarget(target.file, target.symbol, tree)) record(hit);
  }
  return hits;
}

/**
 * A file tree the matcher can read without touching disk: fixture sources keyed
 * by path, plus the repo tree behind them. `read` is what the cross-module hop
 * uses to fetch an import target, and every read is cached — the guard walks over
 * 150 files and the hop adds one read per distinct import target.
 */
interface SourceTree {
  readonly read: (file: string) => string | undefined;
}

/** The repo tree, with contents cached on first read. */
function repoTree(): SourceTree {
  const cache = new Map<string, string>();
  return {
    read(file) {
      const cached = cache.get(file);
      if (cached !== undefined) return cached;
      try {
        const src = readFileSync(join(REPO_ROOT, file), "utf8");
        cache.set(file, src);
        return src;
      } catch {
        return undefined;
      }
    },
  };
}

/** A fixture tree: the map's own files, nothing on disk. */
function memoryTree(sources: ReadonlyMap<string, string>): SourceTree {
  const cache = new Map(sources);
  return { read: (file) => cache.get(file) };
}

const REPO_TREE = repoTree();

function findViolations(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    hits.push(...findViolationsInSource(readFileSync(join(REPO_ROOT, file), "utf8"), file, REPO_TREE));
  }
  return hits;
}

/**
 * Test seam for multi-file fixtures: the same matcher, fed an in-memory tree
 * instead of the repo, so a fixture never touches the working copy.
 */
export function findViolationsInSources(sources: ReadonlyMap<string, string>): Hit[] {
  const tree = memoryTree(sources);
  const hits: Hit[] = [];
  for (const [file, src] of sources) {
    hits.push(...findViolationsInSource(src, file, tree));
  }
  return hits;
}

function isAllowed(hit: Hit): boolean {
  return ALLOW_LIST.some((e) => e.file === hit.file && e.line === hit.text);
}

function format(hit: Hit): string {
  return `${hit.file}:${hit.line} [${hit.rule}] ${hit.text}`;
}

const FILES = collectSourceFiles();
const HITS = findViolations(FILES);
const VIOLATIONS = HITS.filter((h) => !isAllowed(h));
const EXCUSED = HITS.filter((h) => isAllowed(h));

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The shape #156 shipped with: the queue lives at module scope, the handler
 * calls a named function, and that function assigns it. Two hops — a one-hop
 * rule reads this as clean.
 */
const SHIPPED_SHAPE = `
let _queue: ImageQueue | null = null;

export default function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    initQueue(ctx);
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    shutdownQueue();
  });
}

function initQueue(ctx: ExtensionContext): void {
  _queue = createQueue();
}

function shutdownQueue(): void {
  _queue = null;
}
`;

/** Hop 1 on its own: the handler body assigns the binding itself. */
const DIRECT_ASSIGNMENT = `
let pasting = false;

export function register(pi: ExtensionAPI): void {
  pi.on("turn_start", async () => {
    pasting = false;
  });
}
`;

/**
 * Decision 2's escape, in the shape meta actually shipped: the binding is a
 * `let` (so the collector DOES see it — this is what proves the guard tests
 * assignment and not declaration) and every session reaches it through
 * `.set()`/`.delete()`. Contents change, the binding does not.
 */
const SESSION_KEYED_MAP = `
let sessions = new Map<string, ImageQueue>();

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    sessions.set(sessionKey(ctx), createQueue());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.get(sessionKey(ctx))?.clear();
    sessions.delete(sessionKey(ctx));
  });
}
`;

/**
 * The target half of the cross-module fixtures: the binding lives here, and the
 * only function that writes it is reached from ANOTHER file's handler. This is
 * the shape `packages/diff` shipped (`setShikiConfig`/`setRenderConfig`), and the
 * shape `ui` still ships (`stopStartupListing` writes `frameTimer`/`revealTimer`).
 */
const CONFIG_TARGET = `let _cfg: (() => Cfg) | undefined;

export function setConfigGetter(fn: () => Cfg): void {
  _cfg = fn;
}
`;

/**
 * The cross-module hop: a handler calls a function it IMPORTED under an `as`
 * alias, and the assignment happens one module away. A one-file rule reads this
 * as clean — which is exactly how three lifecycle-reachable bindings shipped in
 * `packages/diff`.
 */
const CROSS_MODULE_HOP = new Map([
  [
    "index.ts",
    `
import { setConfigGetter as setCfg } from "./shiki.js";

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    setCfg(() => buildConfig(ctx));
  });
}
`,
  ],
  ["shiki.ts", CONFIG_TARGET],
]);

/**
 * The same shape behind a NAMESPACE import, which the hop deliberately does not
 * follow: `CALLS` cannot match `ns.fn(`, and following it would flag the five
 * honest one-socket-per-process bindings in `core/src/bridge/` with nowhere to
 * put them. Pinning it here makes widening the hop a deliberate edit.
 */
const NAMESPACE_IMPORT_NOT_FOLLOWED = new Map([
  [
    "index.ts",
    `
import * as shiki from "./shiki.js";

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    shiki.setConfigGetter(() => buildConfig(ctx));
  });
}
`,
  ],
  ["shiki.ts", CONFIG_TARGET],
]);

/** Honest process state: a module `let`, written only outside any handler. */
const WRITTEN_OUTSIDE_HANDLERS = `
let cache: Map<string, string> | undefined;

export function primeCache(reader: () => Map<string, string>): void {
  cache = reader();
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    report(ctx);
  });
}

function report(ctx: ExtensionContext): void {
  ctx.ui.notify(String(cache?.size ?? 0));
}
`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("session-state discipline: no per-session state at module scope", () => {
  it("walks the whole suite, not an empty file set", () => {
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(FILES.length).toBeGreaterThan(50);
    // The three trees the guard is supposed to cover, including the two whose
    // assignment paths cross a boundary the hop does not follow (header: blind
    // spot 1) — they must still be scanned, or a future same-file violation
    // escapes silently.
    for (const expected of [
      "packages/image-paste/src/index.ts",
      "packages/ui/src/index.ts",
      "packages/ui/src/startup/index.ts",
      "packages/core/src/bridge/events.ts",
      "meta/src/index.ts",
    ]) {
      expect(FILES).toContain(expected);
    }
    expect(FILES.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("reports no module-scope session state outside the allow-list", () => {
    expect(VIOLATIONS.map(format)).toEqual([]);
  });

  it("follows an assignment one call away from a handler, and leaves a keyed Map alone", () => {
    // The bug that shipped: module `let`, handler → named function → assignment.
    expect(findViolationsInSource(SHIPPED_SHAPE, "fixture.ts").map(format)).toEqual([
      "fixture.ts:2 [module-scope binding assigned by a session handler] let _queue: ImageQueue | null = null;",
    ]);

    // Hop 1 on its own is alive too (a rule that only ever fired on hop 2 would
    // pass these fixtures by accident).
    expect(findViolationsInSource(DIRECT_ASSIGNMENT, "fixture.ts").map((h) => h.line)).toEqual([2]);

    // Decision 2's escape, and the honest cache, are both clean. The Map is a
    // `let` deliberately: a `const` Map would also be clean, but only because
    // `const` is outside the collector's class, which says nothing about the
    // assignment test. A `let` Map mutated through `.set()` is the version that
    // proves "contents change, binding doesn't" is a real escape.
    expect(findViolationsInSource(SESSION_KEYED_MAP, "fixture.ts").map(format)).toEqual([]);
    expect(findViolationsInSource(WRITTEN_OUTSIDE_HANDLERS, "fixture.ts").map(format)).toEqual([]);

    // And the collector itself: module scope only, `let`/`var` only. A
    // registration-closure `let` is the prescribed shape and must not be
    // collected, and neither may a `const` — the fix is a `const` Map.
    const collected = (src: string): string[] =>
      src
        .split("\n")
        .map((text) => COLLECTOR.pattern.exec(text)?.[1])
        .filter((name): name is string => name !== undefined);
    expect(
      collected(
        [
          "let moduleLevel = 1;",
          "export var alsoModule = 2;",
          "const keyed = new Map();",
          "  let insideAFunction = 3;",
          "\tlet tabIndented = 4;",
        ].join("\n"),
      ),
    ).toEqual(["moduleLevel", "alsoModule"]);
  });

  it("follows one cross-module import hop for named imports only", () => {
    // The hop: `index.ts`'s handler calls an imported function under an `as`
    // alias, `shiki.ts` is where the binding is written. The hit is reported
    // against the TARGET file and the target's declaration line, because that is
    // the pair the allow-list matches on.
    expect(findViolationsInSources(CROSS_MODULE_HOP).map(format)).toEqual([
      "shiki.ts:1 [module-scope binding assigned by a session handler] let _cfg: (() => Cfg) | undefined;",
    ]);

    // The wall, pinned on purpose: a namespace import is not followed (see the
    // header's blind spot 1), so the same shape behind `import * as ns` stays
    // invisible. Widening this must be a deliberate edit to this assertion.
    expect(findViolationsInSources(NAMESPACE_IMPORT_NOT_FOLLOWED).map(format)).toEqual([]);
  });

  it("keeps the allow-list as small as the work that removes it", () => {
    expect(EXCUSED.map(format).sort()).toEqual(
      [
        "packages/notify/src/index.ts:197 [module-scope binding assigned by a session handler] let notifyTimer: ReturnType<typeof setTimeout> | null = null;",
        "packages/notify/src/index.ts:198 [module-scope binding assigned by a session handler] let pendingTrigger: TriggerType | null = null;",
        "packages/ui/src/startup/index.ts:171 [module-scope binding assigned by a session handler] let frameTimer: ReturnType<typeof setInterval> | undefined;",
        "packages/ui/src/startup/index.ts:172 [module-scope binding assigned by a session handler] let revealTimer: ReturnType<typeof setTimeout> | undefined;",
      ].sort(),
    );

    for (const entry of ALLOW_LIST) {
      expect(FILES, `allow-listed file is no longer scanned: ${entry.file}`).toContain(entry.file);
      expect(entry.reason.length).toBeGreaterThan(0);
      // An exemption without a removal point is how a guard quietly becomes
      // permanent, so the reason has to name the card that retires it.
      expect(entry.reason, `allow-list entry needs a follow-up: ${entry.file}`).toMatch(/follow-up: tsk_/);
      // Entries pin a DECLARATION line (that is what the guard reports), matched
      // exactly, so a second violation in an exempt file still fails the guard.
      const actual = readFileSync(join(REPO_ROOT, entry.file), "utf8").split("\n");
      expect(
        actual.some((l) => l.trim() === entry.line),
        `allow-list entry no longer matches ${entry.file}: ${entry.line}`,
      ).toBe(true);
      expect(/^(?:export\s+)?(?:let|var)\s/.test(entry.line), `allow-list entry is not a declaration: ${entry.line}`).toBe(true);
    }

    // The one assignment path that crosses a module boundary the hop does NOT
    // follow is excused by the rule's shape, not by an entry — pin that, so a
    // future edit that makes it visible is noticed rather than absorbed. It
    // stays invisible because `bridge/index.ts` reaches it through a NAMESPACE
    // import (`import * as events` → `events.onSessionStart(ctx)`), which gives
    // the resolver no symbol to look up and which `CALLS` cannot even match.
    for (const escaped of ["packages/core/src/bridge/events.ts"]) {
      expect(ALLOW_LIST.some((e) => e.file === escaped), `${escaped} must not need an entry`).toBe(false);
      expect(VIOLATIONS.some((v) => v.file === escaped) || EXCUSED.some((v) => v.file === escaped)).toBe(false);
    }

    // `packages/ui/src/startup/index.ts` used to sit in that list. The hop sees it
    // now, so it is excused by an entry like anything else — pin the flip so a
    // quiet narrowing of the hop cannot put it back behind the wall.
    expect(EXCUSED.filter((h) => h.file === "packages/ui/src/startup/index.ts")).toHaveLength(2);
  });
});

