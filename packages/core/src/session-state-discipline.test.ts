import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
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
// So the rule is TWO-HOP ASSIGNMENT REACHABILITY, intra-file:
//   hop 1  a module-scope `let`/`var` assigned inside such a handler body, or
//   hop 2  assigned inside the body of a function that a handler body calls
//          directly.
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
// 1. The rule is INTRA-FILE. It follows a handler body and the functions that
//    body calls *in the same file*, so an assignment path that crosses a module
//    boundary is invisible to it. Two such paths exist today and need no
//    allow-list entry:
//      - `core/src/bridge/index.ts:160`'s `session_start` handler calls
//        `events.onSessionStart(ctx)`, and `events.ts:66` is where `sessionCtx`
//        (`bridge/events.ts:38`) is written.
//      - `ui/src/index.ts:183`'s `session_shutdown` handler calls
//        `stopStartupListing()` at `:215`, which clears `frameTimer`/`revealTimer`
//        declared at `ui/src/startup/index.ts:171-172`.
//    Both are legitimate on their own merits — `events.stop()` is idempotent and
//    generation-guarded by design, and the startup module's own comment explains
//    why a module pair of timers cannot leak a second animation. But the guard
//    is green there because it cannot see them, not because it checked. The
//    moment any package moves an assignment one module boundary away from its
//    handler, this file reports green over the bug.
// 2. An assignment inside a closure a handler passes ELSEWHERE is not followed
//    either — the callback is not a `pi.on` handler body. image-paste's
//    `registerShortcut` callback assigned `_pasting` pre-fix and would not be
//    reached by this rule on its own. That is precisely why the anti-vacuity
//    fixture reproduces the shape that IS followed (a named function a handler
//    calls) rather than the one that is not.
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
    file: "packages/diff/src/index.ts",
    line: "let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;",
    reason:
      "Assigned at `:138` inside `registerDiffTools`, which the composed path re-runs on every `session_start` with an equivalent value, so a foreign session cannot leave this one reading another session's config — it re-points it to the same thing. Deferred. follow-up: tsk_7a7b2b7d-da43-4b56-b2c9-fccae1af0816",
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

interface Hit {
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

/** Apply the rule to one source file's text. Reports the DECLARATION line. */
function findViolationsInSource(src: string, file: string): Hit[] {
  const declarations: Array<{ name: string; line: number; text: string }> = [];
  src.split("\n").forEach((text, i) => {
    for (const rule of RULES) {
      const m = rule.pattern.exec(text);
      const name = m?.[1];
      if (name) declarations.push({ name, line: i + 1, text: text.trim() });
    }
  });
  if (declarations.length === 0) return [];

  const bodies = handlerBodies(src);
  if (bodies.length === 0) return [];

  const scopes = functionBodies(src);
  const reached = new Set<string>();
  for (const body of bodies) {
    for (const name of calledNames(body)) {
      if (scopes.has(name)) reached.add(name);
    }
  }

  const hits: Hit[] = [];
  for (const decl of declarations) {
    const assigned = new RegExp(`(?<![\\w.])${decl.name.replace(/\$/g, "\\$")}\\s*=[^=]`);
    // Hop 1: the handler body writes it itself.
    if (bodies.some((body) => assigned.test(body))) {
      hits.push({ file, line: decl.line, rule: COLLECTOR.label, text: decl.text });
      continue;
    }
    // Hop 2: a function the handler body calls directly writes it.
    for (const name of reached) {
      if (assigned.test(scopes.get(name) ?? "")) {
        hits.push({ file, line: decl.line, rule: COLLECTOR.label, text: decl.text });
        break;
      }
    }
  }
  return hits;
}

function findViolations(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    hits.push(...findViolationsInSource(readFileSync(join(REPO_ROOT, file), "utf8"), file));
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
    // assignment paths it cannot see (header: blind spot 1) — they must still be
    // scanned, or a future same-file violation escapes silently.
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

  it("keeps the allow-list as small as the work that removes it", () => {
    expect(EXCUSED.map(format).sort()).toEqual(
      [
        "packages/diff/src/index.ts:44 [module-scope binding assigned by a session handler] let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;",
        "packages/notify/src/index.ts:197 [module-scope binding assigned by a session handler] let notifyTimer: ReturnType<typeof setTimeout> | null = null;",
        "packages/notify/src/index.ts:198 [module-scope binding assigned by a session handler] let pendingTrigger: TriggerType | null = null;",
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

    // The two files whose assignment paths cross a module boundary are excused
    // by the rule's shape, not by an entry — pin that, so a future edit that
    // makes them visible is noticed rather than absorbed.
    for (const escaped of ["packages/core/src/bridge/events.ts", "packages/ui/src/startup/index.ts"]) {
      expect(ALLOW_LIST.some((e) => e.file === escaped), `${escaped} must not need an entry`).toBe(false);
      expect(VIOLATIONS.some((v) => v.file === escaped) || EXCUSED.some((v) => v.file === escaped)).toBe(false);
    }
  });
});
