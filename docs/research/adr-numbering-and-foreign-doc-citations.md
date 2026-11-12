---
status: current
last-verified: 2026-11-11
verified-by: web research + local measurement — 3 researcher subagents (ADR provenance via git, foreign-doc citation census, deferred-backlog verification) plus first-hand re-measurement of every contested claim on this checkout (branch `fix/todo-schema-typebox-parity`, HEAD `cd8e408`); `gh issue view 117` / `gh pr view 143`; full `npx vitest run` → 2534 tests / 149 files; pi 1.4.0 (pinned) and pi 1.5.0 (live global) docs read from disk
task: tsk_a21a415f-4699-48c1-974b-b25edbb17b78
---

# ADR heading collisions and citations into pi's docs — what #117 actually owns

**Settled question:** what is still broken in issue #117's scope, which fix for the five colliding ADR
headings is safe, and whether the docs-hygiene work PR #143 deferred to #117 belongs on this card.

Tracker: GitHub, `https://github.com/archimedes-codes/pi-archimedes` (resolved by
`gh repo view --json url,nameWithOwner`, which follows the rename — the `git remote` still says
`danielcherubini/pi-archimedes`, and per the durable-capture rule the remote is not the signal).
Issue: [#117](https://github.com/archimedes-codes/pi-archimedes/issues/117), open, unlabeled, one
comment (the author's re-scope).

## Executive Summary

1. **The collision is a merge residue, not an authoring error.** `edfb3f1` (2026-08-17) wrote the five
   MCP ADRs into `docs/decisions/` numbered `0001`–`0005` while a *parallel* tree
   `docs/adr/0001…0014` already existed. `7a27f59` (PR #51, 2026-09-12) collapsed `docs/adr/*` into
   `docs/decisions/*` and renamed the five MCP files to `0015-…`–`0019-…` at `similarity index 100%` —
   renames only, H1 text untouched. **The filenames are the settled identity; the headings are the
   leftover.**
2. **26 of 31 ADRs carry no number in the H1**; these five are the only ones that do, and
   `AGENTS.md:109` puts the number in the *filename* (`docs/decisions/NNNN-slug.md`).
   `docs/decisions/0024-mcp-deprecated-for-pi-builtin.md:23` already calls them "ADRs 0015–0019" in
   prose — the correct numbers, contradicting their own headings.
3. **Nothing anywhere in the tree references those five files by path**, so any heading fix is a
   five-line diff that breaks zero links.
4. **The one live ambiguity is the string "ADR 0004"**: `packages/core/src/events.ts:5` and
   `packages/core/src/events.test.ts:5` cite it meaning the retired `Bus` singleton
   (`0004-bus-globalthis-symbol.md`), and `0018-mcp-persist-connection-status.md`'s heading claims the
   same number today.
5. **`docs/tui.md` genuinely exists** — in pi's published tarball, in both the pinned 1.4.0
   (`node_modules/.pnpm/@earendil-works+pi-coding-agent@1.4.0*/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`)
   and the live 1.5.0 install — and lines 24/26 really do say what `overlay.ts` claims they say. The
   defect is **qualification only**. Nothing needs to be hedged or deleted.

## Findings

### Q1 — Renumber the files, or retitle the headings? Neither, as posed.

House style, measured across all 31 files in `docs/decisions/`:

| H1 shape | Count | Files |
|---|---|---|
| Bare title, no number | 26 | all of 0001–0014 and 0020–0031 |
| `# ADR NNNN: <title>` | 5 | `0015`, `0016`, `0017`, `0018`, `0019` only |

Metadata style splits the same way: 0015–0019 use bold `**Status:**` / `**Date:**` / `**Context:**`
lines; 0020 onward use YAML front-matter (`status:` / `date:` / `superseded-by:`); 0001–0014 mostly
carry neither, except 0004/0005/0011 which carry a blockquote `> **Status:** superseded…` note.

Cost of each option, with the reference census below as the input:

| Option | Edits | Consequence |
|---|---|---|
| (a) Renumber the files down to 0001–0005 | non-viable — those numbers are occupied | a real renumber shifts 0001–0014 and rewrites every inbound numeric reference: **209** `ADR NNNN` refs repo-wide (36 inside `docs/decisions/`, 173 outside) |
| (b) Retitle each H1 to its own filename number (`# ADR 0015: MCP OAuth token refresh strategy`) | 5 lines (`0015…:1`, `0016…:1`, `0017…:1`, `0018…:1`, `0019…:1`) | stops the collisions, but puts numbered H1s into a directory whose other 26 files have none, and mints five searchable strings no prose uses — today there are **zero** hits for `ADR 0015`…`ADR 0019` anywhere |
| (c) **Drop the number from the H1** (`# MCP OAuth token refresh strategy`) | the same 5 lines | 31/31 conform to the house style; removes the "ADR 0004" ambiguity for `events.ts`; breaks nothing, because no path links exist |

(c) is the only option that makes the five *conform* rather than merely stop colliding, and it is the
one the repository's own convention (`AGENTS.md:109`, filename carries the number) points at. The one
prose reference to these files by number — `0024:23`, "ADRs 0015–0019" — already uses the filename
numbers, so it is correct under (b) and (c) and wrong under no option.

**Can an accepted ADR's H1 be edited at all?** The dominant precedent is *amend, don't rewrite*:
0014 amended twice (`e06753b`, `32a809f`), 0012 gained a `## Exception` section (`e80f81b`), 0004 and
0005 gained status blockquotes (`f9ce04d`), 0029/0030 gained appended notes. But **in-place correction
of prose that is simply wrong is also established and self-labelled** — `0030` carries "corrected in
place on 2026-10-14, PR #129" and `0029` "corrected here on 2026-10-14". **No ADR has ever had its H1
changed**, so this fix is a first in either direction; the closest applicable precedent is the
"the wording was false, so it was corrected in place" line, which is exactly this situation.

The "ADR files are append-only" rule the card might have expected to bind here exists **only** at
`docs/roadmap/working-indicator-ownership.md:201`, and `AGENTS.md` (Documentation Structure) deletes
finished plan docs from disk — history lives in git. So that rule is not a durable constraint: it
evaporates when that plan ships, and nothing restates it anywhere persistent.

### Q2 — Two claims or five? Five files, and three claims (not two).

Verified by reading all 31 H1s: `0015`→"ADR 0001", `0016`→"ADR 0002", `0017`→"ADR 0003",
`0018`→"ADR 0004", `0019`→"ADR 0005". The issue body's original "two heading collisions" (0018/0019)
was corrected upward by the author's own comment; **five is authoritative**.

The card's framing understates the scope in the other direction, though: **#117 carries three live
claims, not two**, and its title names only two of them.

| Claim | Source | State |
|---|---|---|
| Five colliding ADR headings | title + comment | open |
| `docs/decisions/0003-shared-version.md:1,3` says "all 9 packages" | comment only — **not in the title** | open; true count is 12 components + `meta` = 13 projects |
| `packages/core/src/overlay.ts:9` cites pi's `docs/tui.md` unqualified | title + comment | open |

`0003-shared-version.md:3` enumerates nine packages (`core`, `ask`, `footer`, `diff`, `image-paste`,
`notify`, `subagent`, `todo`, `meta`) and so omits `session-name`, `sudo`, `ui`, `web`.

### Q3 — The unqualified citation is one of five, and one of the five is worse than reported

Complete census of bare `docs/<name>.md` citations that resolve inside pi's package and never inside
this repo (verified by grep over `packages/`, `meta/`, `docs/`, `README.md`, `AGENTS.md`, `CONTEXT.md`):

| Site | Citation | Verified state |
|---|---|---|
| `packages/core/src/overlay.ts:9` | `docs/tui.md` | rule is real — pi 1.4.0 `docs/tui.md:24` ("Measure visible terminal columns rather than string length…") and `:26` ("Use `visibleWidth()`, `truncateToWidth()`, `sliceByColumn()`, and `wrapTextWithAnsi()` instead of implementing terminal-width handling yourself"); needs the owner named |
| `docs/decisions/0017-mcp-panels-use-shared-overlay-chrome.md:21` | `docs/tui.md` | same file, same fix |
| `packages/image-paste/src/keybinding-offer.ts:311` | `docs/extensions.md:165` | **the line pin is wrong**: 1.4.0's `:165` is a lifecycle-table row; the title-first `confirm` example is at `:287` in 1.4.0 and `:2760`/`:2808` in 1.5.0 |
| `packages/image-paste/src/keybinding-offer.test.ts:226` | `docs/extensions.md:165` | same wrong pin |
| `docs/decisions/0026-pi-version-contract-runtime-floor.md:15` | `docs/packages.md:88` | reported accurate at 1.4.0 and drifted by 1.5.0 (researcher-measured, not re-verified first-hand here) |

The stable citation target for the `confirm` signature is not the doc at all — it is the declaration:
`confirm(title: string, message: string, …)` at
`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:75-76` (1.4.0) and `:87` (1.5.0).

**The repo already cites pi well everywhere else**, so a fix copies local style rather than inventing
one. Representative existing forms: `dist/modes/interactive/interactive-mode.js:1831-1837`;
`pi-tui/dist/keybindings.js`; `pi's own built-in footer (dist/modes/interactive/components/footer.js…)`;
`@earendil-works/pi-coding-agent@1.2.0`; `pi's extension docs`. Two qualification targets are
derivable from the installed artifact:

- the npm package name `@earendil-works/pi-coding-agent` (optionally `@1.4.0`), and
- the repository: `package.json` → `repository.url` = `git+https://github.com/earendil-works/pi.git`,
  `repository.directory` = `packages/coding-agent`. There is **no `homepage`, no `bugs`, no `docs`
  field** in pi's manifest, and `docs/docs.json` is a pure navigation tree with no URLs — so no public
  docs URL is derivable from the artifact alone. Our tree already uses both
  `https://pi.dev/docs/latest/…` and
  `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/…`; neither is verifiable
  offline and `blob/main` is the least stable of the two (it drifts under the reader).

**Recommendation supported by the evidence: name the owning package, and do not introduce new line
pins.** `:165` is the proof that pins rot, and `AGENTS.md` (Conventions → "Type-Check Target") plus
ADR 0026 establish that our pin is compile-time only — at runtime pi aliases every host specifier to
the user's own copy, so a `1.4.0` line number describes a file a 1.5.0 user is not reading.

### Q4 — The deferred items are the same defect family; two of them are the same rule as #117's

PR #143's Notes for the reviewer (merged 2026-10-16) defers three defects to #117. All three verified
still present, both files byte-identical to `main` (`git diff --stat main -- <paths>` → empty):

- **`packages/subagent/src/row-block.ts:8`** quotes ADR 0029 as authority for *"width maths goes
  through pi-tui helpers"*. `docs/decisions/0029-presentation-via-renderer-resolution.md` contains
  **zero occurrences of "width", "visibleWidth", "truncate", or "pi-tui"** — the quoted string exists
  in no ADR at all. The rule it gestures at is real and lives in `packages/core/src/overlay.ts:7-10`
  and pi's `docs/tui.md:26`. **`row-block.ts:8` and `overlay.ts:9` are therefore one rule with two
  broken pointers** — splitting them across cards would split a single fact in half.
- **`row-block.ts:19` and `packages/subagent/src/tool-row.width-audit.test.ts:597`** cite ADR 0020 for
  the *expanded TUI view* being unread-in-full-if-truncated. ADR 0020 governs the model-facing tool
  result `content` (line 9: *"in the tool result `content`, untruncated"*; consequences: *"lands in the
  parent's context in one tool result"*) and its rejected options are *token* caps ("16KB / pi's 50KB
  convention"). The words "TUI", "row", "render", "present" never appear in it. Mis-citation,
  defensible only as analogy.
- **Nine `docs/features/*.md` files carry a stale suite count** (#143 said "eight other" — it forgot
  `subagent.md`, the one it refreshed to 2504/148, itself now behind). Measured today: **2534 tests /
  149 files**.

Precedent that this repo treats comment-level ADR mis-citation as a real defect, not a nit:
`docs/reviews/2026-09-14-first-run-keybinding-offer.md` findings 1 and 2 — a comment that "named a
false technical difference as the justification for an architectural decision, which would mislead
future readers" — fixed in `8bd7852` and `9c8b51b`.

**Do the stale counts belong on this card?** By defect class, they are the sibling of the claim
already on #117: `0003-shared-version.md`'s "all 9 packages" *is* a drifted count, and
`AGENTS.md:142`'s "12 package directories (11 components + session-name)" is wrong the same way (there
are 12 component directories plus `meta`). Distinguishing the two motions:

| Defect | Motion |
|---|---|
| 0015–0019 headings; `overlay.ts:9`; `row-block.ts:8,19`; width-audit `:597` | a **pointer** that mispoints — cites authority which does not support it |
| `0003` "all 9 packages"; 9 stale suite counts; `AGENTS.md:142` | a **number** that drifted |

#117's own comment already stretches to the second class ("the 0003 heading still says all 9
packages"), so under the author's own widened framing the stale counts belong here too, and #143's
umbrella phrase "docs hygiene" is what binds them. **No other owner exists**: `docs/roadmap/` holds
only `working-indicator-ownership.md` (#147) and `todo-schema-typebox-parity.md` (#154), neither of
which covers citation hygiene; `docs/reviews/` holds no such plan; and of the 14 open issues, #117 is
the only one in docs territory.

Counts that are **correct** and must not be "fixed" in passing: "all 13 workspace projects" (9 docs),
"depends on all twelve" (`README.md:269`, `AGENTS.md:19`), "Bump all 13 package versions"
(`AGENTS.md:140`), the README monorepo tree (12 packages, no `mcp`), and `AGENTS.md`'s Monorepo
Structure list (no `mcp` — deleted by ADR 0024).

### Q5 — Every fix here can be made to stick with machinery the repo already runs

Three existing docs/behaviour guards, all executed by CI's floor job
(`.github/workflows/ci.yml:46` → `pnpm test` → root `package.json` `"test": "vitest run"`;
`vitest.config.ts` lists all 13 projects, so any `*.test.ts` under a project's `src` runs):

- `meta/src/readme-agreement.test.ts` — the direct template: repo root resolved from the file itself
  (`fileURLToPath(new URL("../../", import.meta.url))`), never `$HOME`; deliberately cheap ("a handful
  of reads of three small Markdown files (measured: ~10ms for five tests, and it passes from an
  unrelated cwd with `env -i` and a nonexistent `$HOME`)"); compares two READMEs line-for-line **and**
  carries a stale-phrasing list, with anti-vacuity tests so the guard cannot silently match nothing.
- `packages/core/src/log-discipline.test.ts` — forbidden-pattern + typed `ALLOW_LIST` of `{file,
  reason}` entries, each exempted file required to carry a reason.
- `packages/core/src/screen-mode-discipline.test.ts` — same skeleton, empty allow-list, plus
  "patterns are not dead" tests.

A heading-vs-filename guard, a bare-foreign-`docs/<x>.md` guard, and a suite-count guard each fit that
skeleton with `node:fs` only, no network. The third is the one that matters most: **without a guard the
counts re-stale immediately** — `bd787d9` (pi 1.4.0 upgrade, #152) bumped `docs/features/image-paste.md`'s
`last-verified` to 2026-10-29 while copying `2430 tests / 145 files` verbatim, which is the exact
failure mode a refresh-only fix reproduces.

Is a bare "N tests / M files" a stale claim or a historical timestamp? **A claim about the present.**
`AGENTS.md:109` is the entire written convention ("present-tense, front-matter `status: live` +
`last-verified`") and nothing anywhere requires refreshing `verified-by` figures. But the suite's own
distinctive phrasing shows what a *deliberately* historical number looks like: `ui.md` writes "those
planning figures are cited as recorded-then, not measured now", and
`first-run-keybinding-offer.md` writes "Re-run whole-suite on 2026-10-15 … 2461 tests / 146 files".
None of the nine stale docs uses either hedge — they assert the bare form inside a `status: live`
document, so they read as current and are not.

## Evidence

| Source | Detail | Credibility |
|---|---|---|
| `git show 7a27f59 --stat` | `docs/{adr => decisions}/0001-…0014` renames; the five MCP files renamed to `0015-…0019`, `similarity index 100%` | primary — first-hand |
| `git show edfb3f1 --stat` | created `docs/decisions/0001-mcp-oauth-refresh-strategy.md` … `0003-…` on 2026-08-17, "ADRs 0001-0003" | primary |
| `git ls-tree 7a27f59^` | `docs/adr/0001…0014` and `docs/decisions/0001…0005` coexisting — two parallel sequences before the merge | primary |
| `docs/decisions/*.md:1` (31 files) | 26 bare H1s, 5 numbered | primary |
| `AGENTS.md:109` | "`docs/decisions/NNNN-slug.md`" — the number lives in the filename | primary |
| `docs/decisions/0024-…:23` | "ADRs 0015–0019 (MCP design decisions) … remain in git as the record" | primary |
| reference census | 209 `ADR NNNN` refs repo-wide (36 in `docs/decisions/`, 173 outside); **0** hits for `ADR 0015`–`0019`; 0 path links to the five files | primary |
| `packages/core/src/events.ts:5`, `events.test.ts:5` | both cite "ADR 0004" for the retired `Bus` — the live collision | primary |
| pi 1.4.0 + 1.5.0 `docs/tui.md:24,26` | the width-maths rule exists, unchanged in the cited region | primary (installed artifact) |
| pi 1.4.0 `docs/extensions.md` | `:165` is a lifecycle table row; title-first `confirm` at `:287`; 1.5.0 at `:2760`/`:2808` | primary |
| `pi-coding-agent/package.json` | `repository` = `earendil-works/pi` + `packages/coding-agent`; no homepage/bugs/docs | primary |
| `meta/src/readme-agreement.test.ts`, `log-discipline.test.ts`, `screen-mode-discipline.test.ts`, `ci.yml:46`, `vitest.config.ts` | guard precedent and its CI wiring | primary |
| `npx vitest run` (fresh TMPDIR) | 2534 tests / 149 files (one phantom "failed" suite from a deleted `zz-probe-label.tmp.test.ts` cache artifact, absent on disk and in git) | measured |
| `docs/reviews/2026-09-14-first-run-keybinding-offer.md` | precedent that ADR mis-citation in comments is a treated defect | primary |
| #143 body, #117 body + comment | `gh pr view 143` / `gh issue view 117` | primary |

## Unresolved Contradictions

- **A researcher reported `docs/tui.md` absent from the installed pi tarball.** Measured false: present
  in both the pinned 1.4.0 and the live 1.5.0 install. Its *recommendation* (qualify, don't delete)
  stands; its premise does not. This is load-bearing — the fix is to name the owner, not to hedge the
  claim.
- **A researcher's H1 table came back corrupted** (interleaved cells, truncated sections). Every
  load-bearing claim attributed to it above — the 26/5 split, the zero path-links, the "ADR 0004"
  ambiguity, the edit precedent — was re-derived first-hand and is cited from this session's own
  commands.
- **`docs/packages.md:88` accuracy** rests on researcher measurement only, not re-verified here.

## Gaps

- **Should 0015–0019 be marked superseded or deprecated?** They document a **deleted** package (ADR
  0024 removed `packages/mcp`) yet still read `**Status:** Accepted`. `0024:23` says they "remain in git
  as the record of how the adapter was built", so leaving them Accepted is arguably deliberate — but a
  reader landing on one cannot tell, and the front-matter `superseded-by:` field that 0020+ use is not
  available to the bold-`**Status:**` files. Adjacent to this card, not inside its done-when.
- **`docs/research/angle5-upstream-ecosystem-per-session-state.md`** uses bare `docs/extensions.md`
  roughly eight times and **is untracked in this working tree** — it is not in the repo, so this card
  cannot fix it, and it would land bare whenever it is committed.
- No public URL for pi's `docs/tui.md` is derivable from the installed artifact; both URL forms already
  in our tree are unverified as live links.
- Cross-machine reproducibility of the 2534/149 figure was not tested (the phantom suite is a stale
  vitest cache entry, not a file in the tree).
