import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── The rule (issue #117) ───────────────────────────────────────────────────
//
// Specified by `docs/research/adr-numbering-and-foreign-doc-citations.md`, the
// audit that measured how far the rot had already spread.
//
// A mis-cited ADR keeps asserting authority for a rule that no ADR makes. The
// compiler cannot see a pointer, so nothing went red when
// `packages/subagent/src/row-block.ts` cited ADR 0029 for "width maths goes
// through pi-tui helpers" across three releases: ADR 0029 contains zero
// occurrences of "width", "visibleWidth", "truncate" or "pi-tui". Citation rot
// is silent and unrecoverable — by the time a reader notices, nobody remembers
// which number was meant. A *count* rule would not clear this bar (a wrong
// figure is visible and self-correcting), so this guard checks pointers, not
// numbers, and walks the tree with `node:fs` the way `log-discipline.test.ts`
// and `screen-mode-discipline.test.ts` already do.
//
// Three rules, all measured against the tree:
//
//   R1  No bare citation to another project's `docs/<file>.md`. Every citation
//       to *our* docs uses a subdirectory (`docs/features/…`, `docs/decisions/…`,
//       `docs/roadmap/…`), and our `docs/` basenames and pi's are disjoint (54
//       vs 42 at pi 1.4.0, empty intersection) — so a bare root-level
//       `docs/<name>.md` is never ours.
//   R2  No `docs/decisions/NNNN-*.md` H1 may carry an ADR number. The filename
//       already carries it and the number is reassignable (ADR 0015–0019 were
//       renumbered once); a heading that repeats it is a second copy to rot.
//   R3  Every `ADR NNNN` / `ADRs NNNN` reference names a file that exists in
//       `docs/decisions/`. This is the rule that catches the next collision
//       from any direction, including a renumbered file whose references were
//       never updated.
//
// R1 is about *unowned*, not *absent* — that is the whole difference between
// this guard and a grep. A citation that names its owner is legal and is the
// fix's target state: ``pi's `docs/tui.md` `` and
// ``(`@earendil-works/pi-coding-agent` `docs/tui.md`)`` are what the corrected
// prose looks like, and a guard that flagged them would be edited away. So a
// match is skipped when the line states its own root (`http://`, `https://`,
// `node_modules/`) or when the 40 characters immediately before it name an
// owner (`OWNER`). The `i` flag is load-bearing: the repo writes `pi's` with an
// ASCII apostrophe (737 occurrences, one typographic, and that one sits in this
// plan's own roadmap file), and `docs/features/session-state.md:17` says
// "Pi's own" with a capital — without `/i` the guard flags correct prose.
//
// Deliberate limits: it reads no package, no `$HOME`, no network — `node:fs`,
// `node:path`, `node:url`, and nothing else. It lives in `meta/src` (the
// docs-guard location) and reaches `docs/` with the same `"../../"` depth as
// `readme-agreement.test.ts`, so `packages/diff`'s standalone status is
// untouched and no sibling copy is needed. It does NOT scan `docs/roadmap/`,
// `docs/reviews/`, `docs/research/` or `docs/images/`: those are point-in-time
// documents that legitimately quote historical citations and old figures as
// evidence — the roadmap file that specifies this guard is itself a document
// quoting the violation it exists to prevent.
//
// Self-reference: the scan set includes `meta/src/*.ts`, which includes this
// file, and its `MUST_FLAG` fixtures are synthetic violations by construction
// ("`docs/tui.md` asks for exactly that", "see ADR 9999"). Rather than drop
// `meta/src` from the scan — which would exempt the orchestrator's own comments,
// where two of the five original violations lived — the file carries one
// allow-list entry in `log-discipline.test.ts`'s `{ file, reason }` shape,
// applied to R1 and R3's *tree* assertions only. The fixtures still run through
// the same rule functions in the anti-vacuity tests below, so the exemption
// hides nothing from the guard's own logic; it only stops the guard from
// reporting its own evidence as a defect. R2 needs no entry: it reads only
// `docs/decisions/`.

/** Repo root, resolved from this file (`meta/src` → repo root), never `$HOME`. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Directories no discipline guard should descend into. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** The directory every decision lives in. */
const DECISIONS_DIR = join("docs", "decisions");

// ── R1: a citation to another project's docs must name its owner ────────────

/**
 * A root-level `docs/<name>.md` path. The leading class is what makes the rule
 * precise: it refuses a match that is really the tail of a deeper path
 * (`docs/features/footer.md`, `docs/decisions/0012-….md`) or of a longer
 * filename, so the only thing left in the net is a *root-level* basename — the
 * shape ours never take.
 */
const FOREIGN_DOC_CITE = /(?<![\w\/.\-])docs\/([A-Za-z0-9][\w-]*\.md)/g;

/**
 * An owner named within 40 characters before the citation. ASCII apostrophe
 * only — that is what the tree contains — and case-insensitive, because
 * `docs/features/session-state.md:17` capitalises it ("Pi's own").
 */
const OWNER = /(?:@earendil-works\/[\w-]+|pi\.dev|github\.com\/earendil-works|pi's)/i;

/** How far back an owner may be named and still count as naming it. */
const OWNER_WINDOW = 40;

// ── R2: the filename carries the number, the heading must not repeat it ─────

/**
 * Keyed on `# ADR <digits>`, not on "any digit in an H1": `0003-shared-version.md`,
 * `0021-sudo-bridge-mode.md` ("… amends 0010") and
 * `0024-mcp-deprecated-for-pi-builtin.md` ("pi ≥ 0.99") all carry digits in a
 * title that is not a duplicated number.
 */
const NUMBERED_HEADING = /^#\s*ADR\s*[0-9]/;

/** A decision filename — the only shape a file in `docs/decisions/` may have. */
const DECISION_FILE = /^(\d{4})-.+\.md$/;

// ── R3: an ADR number must have a decision behind it ────────────────────────

/**
 * `ADR 0026`, `ADRs 0015–0019`. The range group is **inside this one match**,
 * and that placement is load-bearing: writing the base as
 * `ADRs?\s+([0-9]{4})\b` terminates the match at the first number, so the range
 * can never participate and `ADRs 0015–9999` reports clean — measured, with the
 * trailing `\b` the guard misses the exact defect it exists to catch. Numbers
 * are therefore taken from the whole span (`match[0]`) on a second pass.
 *
 * Ranges are expanded rather than skipped: `docs/decisions/0024-mcp-deprecated-
 * for-pi-builtin.md:23` cites `ADRs 0015–0019`, and a range is precisely where a
 * renumber dangles, so both endpoints and every number between them are checked.
 */
const ADR_REF = /ADRs?\s+([0-9]{4})(\s*[–-]\s*[0-9]{4})?/g;

/** Every 4-digit run inside a matched span (both endpoints of a range). */
const FOUR_DIGITS = /[0-9]{4}/g;

interface AllowEntry {
  readonly file: string;
  readonly reason: string;
}

/**
 * Files exempt from the *tree* scan, each with the reason it is tolerated — the
 * house rule that an exemption must explain itself. Kept minimal on purpose:
 * one file, and only because a citation guard cannot demonstrate a bad citation
 * without writing one down.
 */
const ALLOW_LIST: readonly AllowEntry[] = [
  {
    file: "meta/src/citation-discipline.test.ts",
    reason:
      "the guard's own anti-vacuity fixtures are synthetic violations — that is what makes them prove the pattern fires; the fixtures are still run through the same rule functions in the anti-vacuity tests",
  },
];

// ── Walking the tree ────────────────────────────────────────────────────────

/**
 * Every durable file a citation can rot inside: all `.ts` under each package's
 * `src` directory (tests included — comments live in tests too) and `meta/src`,
 * the READMEs a reader trusts, `AGENTS.md`/`CONTEXT.md`, and every `.md`
 * directly in `docs/decisions/` and `docs/features/`. Measured: 364 files.
 *
 * Optional entries are guarded with `existsSync` rather than assumed: a package
 * that later drops its README must not make a discipline guard throw.
 */
function durableFiles(): string[] {
  const out: string[] = [];

  const walk = (dir: string, accept: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, accept);
      } else if (accept(entry.name)) {
        out.push(relative(REPO_ROOT, full).split(/[\\/]/).join("/"));
      }
    }
  };
  const isSource = (name: string): boolean => name.endsWith(".ts");

  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(REPO_ROOT, "packages", entry.name, "src");
    if (existsSync(src)) walk(src, isSource);
  }
  const metaSrc = join(REPO_ROOT, "meta", "src");
  if (existsSync(metaSrc)) walk(metaSrc, isSource);

  for (const page of ["README.md", "meta/README.md", "AGENTS.md", "CONTEXT.md"]) {
    if (existsSync(join(REPO_ROOT, page))) out.push(page);
  }
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const readme = join(REPO_ROOT, "packages", entry.name, "README.md");
    if (existsSync(readme)) out.push(relative(REPO_ROOT, readme).split(/[\\/]/).join("/"));
  }
  for (const dir of [DECISIONS_DIR, join("docs", "features")]) {
    const full = join(REPO_ROOT, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(`${dir}/${entry.name}`);
    }
  }
  return [...new Set(out)].sort();
}

/** Every `docs/decisions/NNNN-*.md`, repo-relative. */
function decisionFiles(): string[] {
  const dir = join(REPO_ROOT, DECISIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => DECISION_FILE.test(name))
    .map((name) => `${DECISIONS_DIR}/${name}`)
    .sort();
}

/** The `NNNN` prefixes that actually exist — R3's set of legal numbers. */
function existingAdrNumbers(): Set<string> {
  const numbers = new Set<string>();
  const dir = join(REPO_ROOT, DECISIONS_DIR);
  if (!existsSync(dir)) return numbers;
  for (const name of readdirSync(dir)) {
    const match = DECISION_FILE.exec(name);
    if (match?.[1]) numbers.add(match[1]);
  }
  return numbers;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function formatHit(hit: Hit): string {
  return `${hit.file}:${hit.line} ${hit.text}`;
}

// ── The three rules, as functions over text (fixtures and tree use the same) ─

/** R1 — root-level `docs/<name>.md` with no owner named in the preceding 40 chars. */
function foreignDocCitations(text: string): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    // A URL or an install path states its own root; there is nothing to name.
    if (line.includes("http://") || line.includes("https://") || line.includes("node_modules/")) {
      return;
    }
    FOREIGN_DOC_CITE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FOREIGN_DOC_CITE.exec(line)) !== null) {
      const start = Math.max(0, match.index - OWNER_WINDOW);
      const window = line.slice(start, match.index);
      if (OWNER.test(window)) continue;
      hits.push({ file: "", line: i + 1, text: line.trim() });
    }
  });
  return hits;
}

/** R2 — an H1 that repeats the number the filename already carries. */
function numberedHeading(text: string): Hit[] {
  const lines = text.split("\n");
  // The first `# ` line, NOT line 1: 0020–0032 carry YAML front matter, so their
  // H1 sits on line 6/7. Reading line 1 would make this rule silently vacuous
  // for every decision written from now on — the one thing a guard must not be.
  const index = lines.findIndex((line) => /^# /.test(line));
  if (index === -1) return [];
  const heading = lines[index] ?? "";
  return NUMBERED_HEADING.test(heading) ? [{ file: "", line: index + 1, text: heading.trim() }] : [];
}

/** R3 — an `ADR NNNN` (or `ADRs NNNN–NNNN`) number with no decision file behind it. */
function danglingAdrReferences(text: string, existing: ReadonlySet<string>): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    ADR_REF.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ADR_REF.exec(line)) !== null) {
      const span = match[0] ?? "";
      // Every number in the span, not just the captured first one: a range is
      // exactly where a renumber dangles. Deduped, then checked.
      const numbers = [...new Set(span.match(FOUR_DIGITS) ?? [])];
      const missing = numbers.filter((number) => !existing.has(number));
      if (missing.length > 0) {
        hits.push({ file: "", line: i + 1, text: `${line.trim()}  [no decision: ${missing.join(", ")}]` });
      }
    }
  });
  return hits;
}

// ── The tree, scanned ───────────────────────────────────────────────────────

const FILES = durableFiles();
const DECISIONS = decisionFiles();
const EXISTING_NUMBERS = existingAdrNumbers();
const ALLOWED = new Set(ALLOW_LIST.map((entry) => entry.file));

function scan(
  files: readonly string[],
  rule: (text: string) => Hit[],
  skip: ReadonlySet<string> = ALLOWED,
): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (skip.has(file)) continue;
    for (const hit of rule(read(file))) hits.push({ ...hit, file });
  }
  return hits;
}

const R1_VIOLATIONS = scan(FILES, foreignDocCitations);
// R2 reads only `docs/decisions/`; the guard file can never appear here, so no
// allow-list applies.
const R2_VIOLATIONS = scan(DECISIONS, numberedHeading, new Set());
const R3_VIOLATIONS = scan(FILES, (text) => danglingAdrReferences(text, EXISTING_NUMBERS));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("citation discipline: pointers must resolve (issue #117)", () => {
  it("scans the durable set, not an empty list", () => {
    // Without this every assertion below can pass on an empty file list — the
    // failure mode of every walk-the-tree guard.
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(FILES.length).toBeGreaterThan(300);
    for (const expected of [
      "packages/core/src/overlay.ts",
      "packages/subagent/src/row-block.ts",
      "docs/decisions/0015-mcp-oauth-refresh-strategy.md",
      "docs/features/ui.md",
      "AGENTS.md",
    ]) {
      expect(FILES, `not in the scan set: ${expected}`).toContain(expected);
    }
    // The two trees whose comments the guard exists to catch, and the decisions
    // directory R2 and R3 both key off.
    expect(FILES.some((f) => f.startsWith("meta/src/"))).toBe(true);
    expect(DECISIONS.length).toBeGreaterThanOrEqual(32);
    expect(EXISTING_NUMBERS.size).toBe(DECISIONS.length);
  });

  it("R1 catches a bare pi-doc path and leaves owned and ours-only paths alone", () => {
    const MUST_FLAG = [
      "`docs/tui.md` asks for exactly that",
      "// see docs/extensions.md:165",
      "(`docs/packages.md:88`)",
    ];
    for (const text of MUST_FLAG) {
      expect(foreignDocCitations(text).length, `must be caught: ${text}`).toBeGreaterThanOrEqual(1);
    }

    const MUST_PASS = [
      // Ours: every real citation to our own docs carries a subdirectory.
      "(docs/features/footer.md)",
      "docs/decisions/0012-plugin-gate-in-package-namespace.md",
      "docs/roadmap/pi-1-x-alignment.md",
      // A template path, not a file.
      "`docs/decisions/NNNN-slug.md`",
      // A URL states its own root.
      "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md",
      "[ADR 0031](../decisions/0031-assert-only-ui-state-our-settings-ask-for.md)",
      // Owned citations — the fix's target state, legal by definition.
      "pi's `docs/tui.md` asks for that",
      "(`@earendil-works/pi-coding-agent` `docs/tui.md`)",
      // The case the 40-character window exists to pass, verbatim from
      // `docs/decisions/0026-pi-version-contract-runtime-floor.md:15`: the owner
      // sits 20-odd characters back, past the backtick and the parenthesis. A
      // plain path grep flags this line; a guard that flags it gets switched off.
      'Given that, we picked asymmetric floors over pi\'s documented `"*"` convention (`docs/packages.md:88`) because this suite already has a peer policy in ADR 0013',
      // And the capitalised form, which is why OWNER carries `/i`
      // (`docs/features/session-state.md:17`).
      "Pi's own `docs/extensions.md` §State Management prescribes the closure",
    ];
    for (const text of MUST_PASS) {
      expect(foreignDocCitations(text), `false positive: ${text}`).toEqual([]);
    }
  });

  it("R2 catches a numbered heading and leaves bare titles alone", () => {
    expect(numberedHeading("# ADR 0001: pnpm workspaces over npm workspaces").length).toBe(1);

    for (const heading of [
      "# MCP OAuth token refresh strategy",
      "# Sudo in bridge mode: Client-supplied confirm + password (amends 0010)",
      "# Deprecate the mcp package in favor of pi's built-in MCP (pi ≥ 0.99)",
    ]) {
      expect(numberedHeading(heading), `false positive: ${heading}`).toEqual([]);
    }

    // Front matter must not hide the heading: 0020–0032 carry a YAML block, so
    // the H1 is line 6/7. A line-1 reading passes today and is dead tomorrow.
    const frontMattered =
      "---\nstatus: accepted\ndate: 2026-01-01\n---\n\n# ADR 0033: a numbered heading under front matter";
    expect(numberedHeading(frontMattered).map((h) => h.line)).toEqual([6]);
  });

  it("R3 catches a number with no decision behind it", () => {
    const flag = (text: string): boolean => danglingAdrReferences(text, EXISTING_NUMBERS).length > 0;

    expect(flag("see ADR 9999")).toBe(true);
    expect(flag("see ADR 0004")).toBe(false);
    // The verified tree forms: a path is not a reference, an apostrophe and a
    // trailing word do not break the number.
    expect(flag("`docs/decisions/0029`")).toBe(false);
    expect(flag("ADR 0012 in-package")).toBe(false);
    expect(flag("ADR 0026's rule")).toBe(false);
    // Range expansion, both directions: the second endpoint is checked, and
    // expanding a legal range invents no violation. `ADRs 0015–0019` is the real
    // cite at `docs/decisions/0024-mcp-deprecated-for-pi-builtin.md:23`.
    expect(flag("ADRs 0015–0019")).toBe(false);
    expect(flag("ADRs 0015–9999")).toBe(true);
  });

  it("keeps the allow-list as small as the reason that grants it", () => {
    // One entry, this file, and only for the tree scan — an exemption that
    // outlives its reason is how a guard quietly widens.
    expect(ALLOW_LIST.map((entry) => entry.file)).toEqual(["meta/src/citation-discipline.test.ts"]);
    for (const entry of ALLOW_LIST) {
      expect(FILES, `allow-listed file is no longer scanned: ${entry.file}`).toContain(entry.file);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    // The fixtures the exemption excuses are real violations by the guard's own
    // lights — if that ever stops being true, the exemption is unnecessary and
    // must go rather than linger.
    expect(foreignDocCitations("`docs/tui.md` asks for exactly that").length).toBeGreaterThan(0);
    expect(danglingAdrReferences("see ADR 9999", EXISTING_NUMBERS).length).toBeGreaterThan(0);
  });

  // ── The three real assertions ─────────────────────────────────────────────
  // Each is proven capable of failing by an insertion check recorded in the
  // commit body — a guard nobody has seen go red is a guard nobody can trust.

  it("no citation points at another project's docs without naming them", () => {
    expect(R1_VIOLATIONS.map(formatHit)).toEqual([]);
  });

  it("no decision heading carries an ADR number", () => {
    expect(R2_VIOLATIONS.map(formatHit)).toEqual([]);
  });

  it("every ADR reference names a decision that exists", () => {
    expect(R3_VIOLATIONS.map(formatHit)).toEqual([]);
  });
});
