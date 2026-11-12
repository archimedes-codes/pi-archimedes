---
status: committed
done-when: no file in `docs/decisions/` has a heading carrying an ADR number, every citation to a pi-owned doc names the package that owns it, no code comment cites an ADR for a rule that ADR does not make, and a `pnpm test` guard fails if any of the three regress — checked on `main`, not on a branch
task: tsk_a21a415f-4699-48c1-974b-b25edbb17b78
issue: https://github.com/archimedes-codes/pi-archimedes/issues/117
---

# ADR heading and citation hygiene (#117)

## Spec

**Problem:** Five ADR files in `docs/decisions/` carry H1s numbered `ADR 0001`–`ADR 0005`, which are the numbers of *other* decisions — so "ADR 0004" is genuinely ambiguous today (`packages/core/src/events.ts:5` means the retired `Bus` singleton in `0004-bus-globalthis-symbol.md`, while `0018-mcp-persist-connection-status.md`'s heading claims the same number). Separately, five citations point at pi's documentation without saying the path belongs to another project, and three code comments cite an ADR as authority for a rule that ADR does not contain.

**Solution:** Correct the headings and the citations in place, then make all three rules machine-checked by one new guard test in `meta/src`, following the shape of the repo's three existing docs/discipline guards (`readme-agreement`, `log-discipline`, `screen-mode-discipline`). Headings lose their numbers rather than gaining correct ones: 26 of 31 decisions already carry a bare title, `AGENTS.md` puts the number in the *filename*, and `docs/decisions/0024-mcp-deprecated-for-pi-builtin.md:23` already refers to these five as "ADRs 0015–0019" in prose. Citations name the owning package (`@earendil-works/pi-coding-agent`, or `pi's` in prose) and drop line-number pins, which provably rot.

**Out of scope:**
- **The stale suite counts** (`docs/features/*.md`'s nine "N tests / M files" figures) and `AGENTS.md:142`'s "11 components". Same umbrella ("docs hygiene", also deferred by PR #143) but a different motion — a *number* that drifted, not a *pointer* that mispoints — and they re-stale on the next commit unless a count guard lands with them, which this plan deliberately does not add. Left on #117.
- **`docs/decisions/0026-pi-version-contract-runtime-floor.md:15`'s `docs/packages.md:88`.** Already qualified by "pi's documented" within the guard's window, so it is not a violation; the pin was reported accurate at the pinned 1.4.0 (researcher-measured, not re-verified first-hand). Editing an ADR body to remove a pin we cannot verify is a rewrite, not a correction.
- **Marking `0015`–`0019` superseded or deprecated.** They document a deleted package (ADR 0024 removed `packages/mcp`) yet read `**Status:** Accepted`, and `0024:23` says they "remain in git as the record of how the adapter was built" — arguably deliberate, and a status change is a decision, not a correction. Flagged on #117 for the maintainer.
- **`docs/research/angle5-upstream-ecosystem-per-session-state.md`** (~8 bare `docs/extensions.md` cites). Untracked in the working tree, so it is not in the repo and is not this plan's to edit. It is also **not covered by the guard**, because `docs/research/` is outside the scan set — so committing it unfixed will not go red. That is a deliberate limit, not a safety net: research reports are point-in-time evidence that legitimately quote their sources, and the same reasoning that exempts them means no future bare cite in `docs/research/` is caught either. If that file is ever committed, fix its cites by hand.
- **Adding a third "Never-Do Rule" to `AGENTS.md`** (`AGENTS.md:80` is "### Two Never-Do Rules (suite-wide, mechanically guarded)"). The guard is the enforcement; widening a suite-wide rule is a separate call.
- **Renumbering any file.** See Decisions.

**Decisions:**
- **Drop the number from the H1 (option c), do not renumber (a) or retitle (b).** Option (a) is non-viable — `0001`–`0005` are occupied — and a real renumber would shift `0001`–`0014` and touch all 209 `ADR NNNN` references measured repo-wide. (b) and (c) are the same 5-line diff; (c) additionally makes 31/31 files match the house style and mints no new unsearchable strings (there are today **zero** hits for `ADR 0015`…`ADR 0019`). Evidence: `docs/research/adr-numbering-and-foreign-doc-citations.md`.
- **Zero inbound references to the five files by path exist anywhere in the tree** (verified: greps for `0015-`…`0019-` outside `docs/decisions/` return nothing), so the heading edits break no link. The one prose reference by number, `0024:23`'s "ADRs 0015–0019", uses the *filename* numbers and stays correct.
- **Editing an accepted ADR's H1 is a first in either direction.** The dominant precedent is *amend* (`0014` twice — `e06753b`, `32a809f`; `0012`'s `## Exception` — `e80f81b`; `0004`/`0005`'s status blockquotes — `f9ce04d`), but in-place correction of prose that is simply false is established and self-labelled (`0030`: "corrected in place on 2026-10-14, PR #129"). A heading asserting a false number is that case. The "ADR files are append-only" rule exists only at `docs/roadmap/working-indicator-ownership.md:201`, which `AGENTS.md` deletes when that plan ships, so it binds nothing durable — and that plan's own `docs/features/ui.md` edits are already committed on disk, so there is no conflict with it here.
- **`0003-shared-version.md` is amended, not rewritten.** Its H1 drops the false count; an amendment note is appended recording the drift. The 2026 body paragraph stays as written, per the amend precedent.
- **Mis-citations are re-pointed at the authority that actually holds the rule**, matching the honest form already in the repo at `packages/subagent/src/expanded.ts:155-158`, which cites ADR 0020 *and* names its limit in the same breath.
- **One guard file, in `meta/src`, scanning `packages/*/src` from the repo root.** `packages/diff` is standalone by design, but the guard reads files as text via `node:fs` and imports nothing, so it covers `diff` without a sibling copy — unlike `log-discipline.test.ts`, which needed one because it asserts an import-time rule. The strongest case against adding a fourth discipline guard at all is cost: three already exist, each is a file to maintain, and a docs rule is not a runtime invariant. The counter, which decided it: citation rot is silent and unrecoverable — a mis-cited ADR keeps asserting authority for a rule that no ADR makes (`row-block.ts:8` did exactly that for three releases and nothing went red), and `log-discipline`/`screen-mode-discipline` already established that walking the tree with `node:fs` is how this suite handles a rule that the compiler cannot see. A count rule would not clear that bar (a wrong number is visible and self-correcting on the next verification pass), which is why this plan adds guards for the pointer rules and not for the numbers.
- **The guard's scan set excludes `docs/roadmap/`, `docs/reviews/` and `docs/research/`** — point-in-time documents that legitimately quote historical citations as evidence (the research report quotes a `node_modules/.../docs/tui.md` install path as a factual statement, and `docs/reviews/` and `docs/roadmap/` carry dated figures). Scoping the guard to durable docs is what keeps it honest instead of noisy.

**Evidence:** `docs/research/adr-numbering-and-foreign-doc-citations.md` (this card's `research` artifact) — provenance via `git show edfb3f1` / `git show 7a27f59` (the five files were renamed to `0015-…`–`0019-…` at `similarity index 100%`, H1 text untouched), the 26/5 H1 split, the reference census (209 `ADR NNNN` refs: 36 inside `docs/decisions/`, 173 outside), pi's `docs/tui.md:24,26` confirming the width-maths rule the `overlay.ts` comment appeals to really exists in pi's tarball at both 1.4.0 and 1.5.0, and pi 1.4.0 `docs/extensions.md` showing the `:165` pin is wrong (the title-first `confirm` example is at `:287`). Grounding for this plan additionally measured: `ADR NNNN` quoted-string mis-cites are exactly one site repo-wide (`row-block.ts:8`); our own docs are **always** cited with a subdirectory (`docs/features/…`) and pi's are cited bare, with the two `docs/` filename sets provably disjoint (54 ours vs 42 pi's at 1.4.0, empty intersection); the suite at **2534 tests / 149 files** on 2026-11-11.

## Plan

**Goal:** Correct five ADR headings, five foreign-doc citations and three ADR mis-citations, then guard all three rules in CI.
**Architecture:** Text-only edits to Markdown and comments, plus one vitest file in `meta/src` that reads the tree with `node:fs` (repo root from `import.meta.url`, never `$HOME`) and asserts three rules with an anti-vacuity test each. No behaviour changes, no manifest changes, no new dependencies.
**Tech Stack:** TypeScript, vitest (root `vitest.config.ts`, 13 projects), `node:fs`/`node:path`/`node:url`.

---

## Parallelisation

**Verdict:** PARALLEL — 2 waves
- Wave 1: Task 1 (`docs/decisions/*` only) ∥ Task 2 (`packages/*/src` comments only) — file lists verified disjoint pairwise; neither imports anything the other creates; neither touches a manifest, lockfile, or snapshot (the suite uses no snapshots — `grep -rn "toMatchSnapshot\|__snapshots__" packages meta --include='*.ts'` → no output).
- Wave 2: Task 3 (the guard). It cannot join Wave 1: its acceptance criteria assert *zero* violations for rules R1/R2, which is only provable once Tasks 1 and 2 have landed — a sibling's work must be present, which is exactly gate 4.

---

### Task 1: Headings — drop the numbers, amend the drifted count

**Parallel:** wave 1 — disjoint from Task 2 (`packages/core/src/overlay.ts`, `packages/image-paste/src/keybinding-offer.ts`, `packages/image-paste/src/keybinding-offer.test.ts`, `packages/subagent/src/row-block.ts`, `packages/subagent/src/tool-row.width-audit.test.ts`) and Task 3 (`meta/src/citation-discipline.test.ts`)

**Context:**
`docs/decisions/0015`–`0019` were written into `docs/decisions/` as `0001`–`0005` by `edfb3f1` (2026-08-17) while a parallel tree `docs/adr/0001…0014` existed. `7a27f59` merged the two trees and renamed the five files to `0015-…`–`0019-` at `similarity index 100%`, leaving the old numbers in the H1s. The result is that `docs/decisions/` contains two files whose H1 reads "ADR 0001", two reading "ADR 0004", and so on. Nothing links these five files by path, so editing line 1 in each is inert except for the reader. The decision (approved 2026-11-11) is to **remove the number**, matching the 26 other decisions whose H1 is a bare title and `AGENTS.md`'s rule that the number lives in the filename. `0003-shared-version.md`'s H1 additionally asserts "all 9 packages" when there are 12 component packages plus `meta`; that is corrected by amendment, not by rewriting the 2026 paragraph.

**Files:**
- Modify: `docs/decisions/0015-mcp-oauth-refresh-strategy.md` (line 1 only)
- Modify: `docs/decisions/0016-mcp-config-writeback-target.md` (line 1 only)
- Modify: `docs/decisions/0017-mcp-panels-use-shared-overlay-chrome.md` (line 1, and the one-word insertion at line 21 below)
- Modify: `docs/decisions/0018-mcp-persist-connection-status.md` (line 1 only)
- Modify: `docs/decisions/0019-mcp-panel-auth-in-panel-ux.md` (line 1 only)
- Modify: `docs/decisions/0003-shared-version.md` (line 1, plus one appended paragraph)
- Create (already on disk, **untracked** — commit it here): `docs/research/adr-numbering-and-foreign-doc-citations.md`

**What to implement:**

1. Replace line 1 of each of the five MCP files. Current → new, verbatim (drop `# ADR NNNN: ` → `# `, keeping the rest of the title byte-identical):
   - `# ADR 0001: MCP OAuth token refresh strategy` → `# MCP OAuth token refresh strategy`
   - `# ADR 0002: MCP config write-back always targets .pi/mcp.json` → `# MCP config write-back always targets .pi/mcp.json`
   - `# ADR 0003: MCP panels use the shared pi-archimedes overlay chrome` → `# MCP panels use the shared pi-archimedes overlay chrome`
   - `# ADR 0004: MCP connection outcome persists in the metadata cache` → `# MCP connection outcome persists in the metadata cache`
   - `# ADR 0005: MCP panel authentication uses in-panel UX over the shared loader` → `# MCP panel authentication uses in-panel UX over the shared loader`

   Touch **nothing else** in these files. Lines 2–6 are a blank line then `**Status:** Accepted` / `**Date:** 2026-08-17` (0015–0017) or `2026-08-19` (0018–0019) / `**Context:** plan-026 (MCP OAuth port)` or `plan-027 (MCP commands + panels port)` / blank, and none of it references the H1 or the number.

2. In `docs/decisions/0017-mcp-panels-use-shared-overlay-chrome.md:21`, qualify the foreign citation. The line currently reads `1. **Generic pi-tui components** (\`SelectList\`, \`DynamicBorder\`, \`Container\`) — the pattern from \`docs/tui.md\`. Works, but produces …`. Insert `pi's ` immediately before the backtick so it reads ``— the pattern from pi's `docs/tui.md`.`` One word inserted, nothing else on the line changes. (`docs/tui.md` is a real file in pi's tarball — `node_modules/.pnpm/@earendil-works+pi-coding-agent@1.4.0*/node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — so this is a qualification, not a deletion. Do not hedge the claim.)

3. `docs/decisions/0003-shared-version.md`:
   - Line 1 `# Shared version across all 9 packages` → `# Shared version across all packages`
   - Leave line 3 (the 1,042-char paragraph naming nine packages and "every release touches 9 `package.json` files") **exactly as it is** — it is the 2026 record.
   - Append, after line 3, a blank line and then this amendment paragraph (the amend precedent is `0014`'s and `0030`'s appended notes):

     ```markdown
     Amendment (2026-11-11, #117): the count above is the count at the time of writing. The suite is now twelve component packages (`core`, `ui`, `sudo`, `ask`, `footer`, `diff`, `image-paste`, `notify`, `subagent`, `todo`, `session-name`, `web`) plus `meta` — thirteen `package.json` files bumped and published per release, as `AGENTS.md`'s Release Steps record. What the decision decided — one shared version, bumped and published atomically, independent versioning rejected — is unchanged. The heading dropped its count for the same reason the MCP decisions dropped their numbers: a heading is a bad place to store a fact that changes.
     ```

4. Do **not** touch `docs/decisions/0021-sudo-bridge-mode.md` ("amends 0010") or `0024-…` ("pi ≥ 0.99"). Their H1s contain numerals that are not self-identifiers and are correct; the Task 3 guard is written to key on `# ADR <digits>`, not on "any digit", precisely so these stay untouched.

5. `UNVERIFIED:` nothing in this task. Every string above was read from disk during grounding.

**Steps:**
- [ ] Confirm the starting state: `grep -c '^# ADR [0-9]' docs/decisions/*.md | grep -v ':0'` → exactly five files, each `1`. If a sixth file answers, stop and report — the premise changed.
- [ ] Apply edits 1–3.
- [ ] Run `grep -c '^# ADR [0-9]' docs/decisions/*.md | grep -v ':0'`
      → **no output** (exit 1). If any file still answers, the replacement did not apply.
- [ ] Run `grep -rn '^# ' docs/decisions/*.md | grep -c .` → `31`. Every decision still has exactly one H1 and none lost its title.
- [ ] Run `grep -in 'all 9 packages' docs/decisions/0003-shared-version.md AGENTS.md README.md` — the `-i` is **required**, not stylistic: line 3 of `0003` begins with a capital `All 9 packages`, so a case-sensitive grep returns nothing after the H1 edit and the step silently checks nothing.
      → exactly two hits, both in `docs/decisions/0003-shared-version.md`: line 1 gone (the amended H1) and line 3 present (`All 9 packages (\`core\`, …)` — the preserved 2026 paragraph). So expect **one** hit, at line 3. A hit in `AGENTS.md` or `README.md` is out of this task's scope — report it, do not fix it here.
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run meta/src/readme-agreement.test.ts`
      → expect `Test Files 1 passed (1)` / `Tests 6 passed (6)`. `readme-agreement.test.ts` reads `README.md`, `meta/README.md` and `packages/image-paste/README.md`, and `meta/src/plugins.test.ts:432` reads `README.md` — the only tests in the suite that read repo Markdown, and none of them is touched by this task. If either goes red, something in this task changed README prose they compare — stop and investigate.
- [ ] Run `npx tsc --noEmit` in `meta` (no code changed, so this only proves the tree still compiles): `cd meta && npx tsc --noEmit` → clean.
- [ ] Commit on the feature branch: `git add docs/decisions docs/research/adr-numbering-and-foreign-doc-citations.md && git commit -m "docs: five MCP ADR headings drop their numbers, 0003's count amended (#117)"`

**Acceptance criteria:**
- [ ] `grep -c '^# ADR [0-9]' docs/decisions/*.md | grep -v ':0'` produces no output.
- [ ] All 31 files in `docs/decisions/` still have exactly one H1 and each H1 is a bare title.
- [ ] "ADR 0004" now has one referent. Verify with two greps, not one: `grep -rn '^# ADR 0004' docs/decisions/` → **no output** (no heading claims that number any more), and `grep -rn 'ADR 0004' packages/core/src` → still the two cites at `events.ts:5` and `events.test.ts:5`, which now unambiguously mean `0004-bus-globalthis-symbol.md`. Do not write this as a single `grep -rl … | xargs grep -l …` — that only re-proves R2 and would pass even if the prose cites had been deleted.
- [ ] `docs/decisions/0017-…:21` names `pi's` before the `docs/tui.md` path.
- [ ] `docs/decisions/0003-shared-version.md` line 3 is byte-identical to before, and the amendment paragraph is present.
- [ ] `docs/research/adr-numbering-and-foreign-doc-citations.md` is tracked in git.

---

### Task 2: Citations — name the owner, and re-point the mis-cited ADRs

**Parallel:** wave 1 — disjoint from Task 1 (`docs/decisions/*`) and Task 3 (`meta/src/citation-discipline.test.ts`); this task touches only `packages/core`, `packages/image-paste` and `packages/subagent` sources

**Context:**
Two defects, one class: a pointer that does not point where it says. (a) Five citations name `docs/<file>.md` with no owner, and that path resolves inside pi's published package, never in this repo — `AGENTS.md` says verification is against a pinned compile-time target while pi aliases every host specifier to the user's own copy at runtime (ADR 0026), so a bare path plus a line pin describes a file a reader on a different pi train is not looking at. (b) `packages/subagent/src/row-block.ts:8` quotes ADR 0029 as saying *"width maths goes through pi-tui helpers"*; ADR 0029 contains **zero** occurrences of "width", "visibleWidth", "truncate" or "pi-tui" — the quoted string is in no ADR at all. `row-block.ts:19` and `packages/subagent/src/tool-row.width-audit.test.ts:597` cite ADR 0020 for the *expanded TUI view*, but ADR 0020 governs the model-facing tool-result `content` and its rejected options are token caps. All three were found in PR #143's review and deferred to #117. The honest form already exists in this repo at `packages/subagent/src/expanded.ts:155-158`, which cites ADR 0020 *and* names its limit in the same sentence — match that voice.

Keep comment lines within ~76 characters, matching the files as they stand (`keybinding-offer.ts:311` is 76, `keybinding-offer.test.ts:226` is 74). `overlay.ts` is the exception and sets its own width — its docblock already runs to 77 at lines 9 and 13, so the replacement block below (74–77) is in family; do not re-wrap the lines this task does not touch.

**Files:**
- Modify: `packages/core/src/overlay.ts` (module docblock, lines 9–13)
- Modify: `packages/image-paste/src/keybinding-offer.ts` (line 311)
- Modify: `packages/image-paste/src/keybinding-offer.test.ts` (line 226)
- Modify: `packages/subagent/src/row-block.ts` (module docblock, lines 8 and 19)
- Modify: `packages/subagent/src/tool-row.width-audit.test.ts` (comment at lines 596–597)

**What to implement:**

1. **`packages/core/src/overlay.ts`** — replace lines 9–13 with these six lines. The claim itself is correct (pi's `docs/tui.md:24,26` really does say to measure visible columns and to use `visibleWidth`/`truncateToWidth`/`sliceByColumn`/`wrapTextWithAnsi` instead of hand-rolling width handling), so only the ownership is added. Lines 1–8 and the line beginning ` * names below are the shared surface;` (plus everything after) stay byte-identical:

   ```
    * `wrapTextWithAnsi` for word wrapping. pi's own `docs/tui.md` — shipped in
    * `@earendil-works/pi-coding-agent`, not this repo — asks for exactly that,
    * and a local re-implementation cannot be right: measuring `.length` after
    * stripping only `\x1b[…m` counts pi's `CURSOR_MARKER` (an APC sequence) as
    * seven drawn columns, counts an OSC 8 hyperlink's URL as drawn text, and
    * counts a CJK glyph as one column when the terminal draws two. The exported
   ```

2. **`packages/image-paste/src/keybinding-offer.ts:311`** — replace the stale line pin with the signature it is actually asserting. The pin is wrong, not merely old: pi 1.4.0's `docs/extensions.md:165` is a lifecycle-table row, and the title-first `confirm` example is at `:287` (1.5.0: `:2760`/`:2808`). The stable target is the declaration `confirm(title: string, message: string, …)` in `dist/core/extensions/types.d.ts`, so cite the shape, not a doc line:

   ```ts
     // Gate 5: ask (confirm(title, message): TITLE first — pi's types.d.ts)
   ```

3. **`packages/image-paste/src/keybinding-offer.test.ts:226`** — same substitution:

   ```ts
           // confirm is called with the TITLE FIRST (confirm(title, message))
   ```

4. **`packages/subagent/src/row-block.ts:8`** — the width-helper rule is real but its authority is pi's doc and `packages/core/src/overlay.ts:7-10`, not ADR 0029. Replace line 8 (keep line 7 as-is):

   ```
    * sanctioned route: pi's `docs/tui.md` (in `@earendil-works/pi-coding-agent`)
    * asks for pi-tui's own width helpers over hand-rolled measurement.
   ```

   Do not leave an ADR 0029 cite here — the sentence is about how width is measured, which ADR 0029 does not address. Line 72's `see ADR 0027` cite is **correct** (ADR 0027 is the screen-mode stance) and must not be touched.

5. **`packages/subagent/src/row-block.ts:19`** — keep the ADR 0020 cite but name its limit, in the voice of `expanded.ts:155-158`. Replace line 19 (the `*     as it always has (ADR 0020: …)` line) with:

   ```
    *     as it always has. ADR 0020 governs the model-facing tool result, not
    *     this view; its reasoning — never cap what the reader has no other
    *     source for — carries over, and `expanded.ts` reads it the same way.
   ```

6. **`packages/subagent/src/tool-row.width-audit.test.ts`** — lines 596–597 currently read:

   ```
     // The collapsed view is a summary: one row per line, cut at the frame. The
     // expanded view is where the run is meant to be read in full (ADR 0020), so a
   ```

   Replace **line 597 only** with these two lines, so the sentence still runs into line 598 (`// line that carries content and no second copy of it — the stats line: turns,`):

   ```
     // expanded view is where the run is meant to be read in full (ADR 0020 sets
     // the no-other-source rule for the model-facing content; it carries here), so a
   ```

   Do not alter any assertion in this file. `tool-row.width-audit.test.ts` was byte-identical to `main` before this task and must stay behaviourally identical after it — a comment-only change.

7. **What NOT to change:** `docs/decisions/0026-…:15` (already qualified, out of scope); `packages/subagent/src/format.ts:31` (cites `docs/decisions/0020-subagent-parallel-full-output.md` **by path**, which is correct and resolves); `packages/subagent/src/expanded.ts:155-158` (already honest — it is the template, not a defect); the ~30 bare `(ADR 0029)` / `(ADR 0027)` cites across `packages/*/src` (they assert no rule text, so they cannot mis-cite).

**Steps:**
- [ ] Re-read each target line before editing (`sed -n '9,13p' packages/core/src/overlay.ts`, `sed -n '311p' packages/image-paste/src/keybinding-offer.ts`, `sed -n '226p' packages/image-paste/src/keybinding-offer.test.ts`, `sed -n '7,8p;19p' packages/subagent/src/row-block.ts`, `sed -n '596,598p' packages/subagent/src/tool-row.width-audit.test.ts`) and confirm each matches the quoted "current" text above. If any does not match, stop and report — the tree moved.
- [ ] Apply edits 1–6. These are comment/docblock-only edits, so there is no new behaviour to test first; the failing-test step for this task is Task 3's guard, which cannot be written until these land (wave 2).
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run packages/core/src/overlay.test.ts` → expect 20-ish tests passing, `Test Files 1 passed (1)`.
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run packages/image-paste/src/keybinding-offer.test.ts` → all pass (this is the file whose comment changed; its assertions are untouched).
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run packages/subagent/src/row-block.test.ts` → expect `Tests 20 passed (20)` (measured on the pre-change tree).
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run packages/subagent/src/tool-row.width-audit.test.ts` → all pass, and `git diff --numstat -- packages/subagent/src/tool-row.width-audit.test.ts` shows changes only in the 596–598 region.
- [ ] Run `npx tsc --noEmit` in `packages/core`, `packages/image-paste`, `packages/subagent` → clean in all three.
- [ ] Run the owner-aware check — **run it BEFORE the edits first**, so it is a real red→green and not a tautology:
      `grep -rnE '(^|[^[:alnum:]_/.-])docs/(tui|extensions|packages)\.md' packages meta --include='*.ts' | grep -vE "pi's|@earendil-works"`
      → **before** the edits: exactly three lines (`overlay.ts:9`, `keybinding-offer.ts:311`, `keybinding-offer.test.ts:226`). **after** the edits: **no output** (exit 1).
      The `grep -vE` half is not optional. A bare `grep` for the path alone would still match the corrected `` pi's `docs/tui.md` `` and report red on correct work — the rule is *unowned*, not *absent*. Keep the two greps in that order; do not simplify them into one. This pipeline is a **smoke check**, not the authority: it filters at line granularity, so a new bare cite sharing a line with `pi's` would slip past it. Task 3's 40-char window is the real enforcement.
- [ ] Commit: `git add packages/core/src/overlay.ts packages/image-paste/src/keybinding-offer.ts packages/image-paste/src/keybinding-offer.test.ts packages/subagent/src/row-block.ts packages/subagent/src/tool-row.width-audit.test.ts && git commit -m "docs: foreign doc citations name their owner, three ADR mis-citations re-pointed (#117)"`

**Acceptance criteria:**
- [ ] No bare `docs/<name>.md` citation remains anywhere under `packages/` or `meta/` (the grep above is empty).
- [ ] `packages/core/src/overlay.ts` still asserts the width-maths rule and now names `@earendil-works/pi-coding-agent` as the owner of `docs/tui.md`.
- [ ] No line-number pin to a pi doc survives: `grep -rn 'docs/[a-z-]*\.md:[0-9]' packages meta --include='*.ts'` → no output.
- [ ] `row-block.ts` contains no `ADR 0029` cite; both remaining `ADR 0020` cites in `packages/subagent` (this file and `expanded.ts`) each name the ADR's model-facing scope in the same sentence.
- [ ] `tool-row.width-audit.test.ts` assertions are unchanged (`git diff` shows comment lines only).
- [ ] All four touched test files and the three `tsc --noEmit` checks are green.

---

### Task 3: The guard — three citation rules, machine-checked

**Parallel:** none — must run after Tasks 1 and 2 are merged, because rules R1 and R2 assert a *zero-violation* state that only exists once their edits are present (gate 4: a sibling's work must be on the tree)

**Context:**
The repo already enforces three doc/behaviour rules mechanically and all three run in CI's floor job (`.github/workflows/ci.yml` → `pnpm test` → root `package.json` `"test": "vitest run"`; `vitest.config.ts` lists all 13 projects, so any `*.test.ts` under a project's `src` runs). The templates: `meta/src/readme-agreement.test.ts` resolves repo root from the file itself (`const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));`) and carries a stale-pattern list with tests proving the patterns are not dead; `packages/core/src/log-discipline.test.ts` walks `packages/*/src` + `meta/src` and matches every line — **including comment lines**, which is exactly what a citation guard needs — against a `PATTERN` with an `ALLOW_LIST` of `{ file, reason }`; `packages/core/src/screen-mode-discipline.test.ts` is the same skeleton with an empty allow-list. Copy that shape. This guard lives in `meta/src` (the docs-guard location) and reaches `docs/` with the same `"../../"` depth; it imports nothing from any package, so `packages/diff`'s standalone status is untouched and no sibling copy is needed.

Three rules, each measured against the current tree before writing:

| Rule | Statement | Violations measured **before** Tasks 1–2 |
|---|---|---|
| **R1** | No bare citation to another project's `docs/<file>.md` — a `docs/<name>.md` path with no owner named within 40 chars before it | 4 across the whole scan set (`overlay.ts:9`, `keybinding-offer.ts:311`, `keybinding-offer.test.ts:226`, `docs/decisions/0017-…:21`); the `.ts`-only grep in Task 2 finds 3 of them, and `0026-…:15` is **not** counted because its owner sits inside the window |
| **R2** | No `docs/decisions/NNNN-*.md` H1 may carry an ADR number | 5 |
| **R3** | Every `ADR NNNN` / `ADRs NNNN` reference must name a file that exists in `docs/decisions/` | 0 across 358 files |

**Files:**
- Create: `meta/src/citation-discipline.test.ts`

**What to implement:**

Create `meta/src/citation-discipline.test.ts` implementing exactly the following. Header comment must state the rule and cite #117 and `docs/research/adr-numbering-and-foreign-doc-citations.md`, in the voice of `log-discipline.test.ts` (which explains *why* the rule exists before stating it).

- **Repo root**, the established idiom: `const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));` with the same comment style as `readme-agreement.test.ts:38` (`/** Repo root, resolved from this file (\`meta/src\` → repo root), never \`$HOME\`. */`). Imports: `node:fs` (`readdirSync`, `readFileSync`, `existsSync`), `node:path` (`join`, `relative`), `node:url` (`fileURLToPath`). Nothing else — no package imports, no network, no `$HOME`.

- **Scan set** (`durableFiles()`), returning repo-relative POSIX paths: every `.ts` under each `packages/*/src` (tests included — comments live in tests too), every `.ts` under `meta/src`, plus `README.md`, `meta/README.md`, `AGENTS.md`, `CONTEXT.md`, every `packages/*/README.md`, and every `.md` directly in `docs/decisions/` and `docs/features/`. Skip directories named `node_modules`, `.git`, `dist`. **Deliberately excluded:** `docs/roadmap/`, `docs/reviews/`, `docs/research/`, `docs/images/` — point-in-time documents that legitimately quote historical citations and old figures as evidence. Say that in a comment. All of the named root files and all twelve package READMEs exist today (verified 2026-11-11), but guard each optional one with `existsSync` rather than assuming — a package that later drops its README must not throw inside a discipline guard.

- **R1** `FOREIGN_DOC_CITE = /(?<![\w\/.\-])docs\/([A-Za-z0-9][\w-]*\.md)/g` — the leading class is what makes this rule precise and it was tested against twelve real strings: it matches `docs/tui.md` and `` (`docs/packages.md:88`) `` and `— docs/extensions.md:165`, and it does **not** match `docs/features/footer.md`, `docs/decisions/0012-….md`, `docs/roadmap/pi-1-x-alignment.md`, a `https://…/docs/keybindings.md` URL, a `node_modules/…/docs/tui.md` install path, the `docs/decisions/NNNN-slug.md` placeholder, or a relative link (`../decisions/…`, `./0029-….md`). Rationale for the guard: every citation to *our* docs uses a subdirectory, and our `docs/` basenames and pi's are disjoint (54 vs 42 at pi 1.4.0, empty intersection) — so a bare root-level `docs/<name>.md` is never ours.
  - **The rule is *unowned*, not *absent*.** State that in the file header, because it is the whole difference between this guard and a grep: a citation that names its owner is legal *and is the fix's target state*. Skip a match when (i) the line contains `http://`, `https://`, or `node_modules/` — a URL or an install path states its own root — or (ii) the 40 characters immediately preceding the match satisfy `OWNER = /(?:@earendil-works\/[\w-]+|pi\.dev|github\.com\/earendil-works|pi's)/i`. ASCII apostrophe only — the repo uses `pi's` 673 times and `pi’s` zero times. Everything else is a violation, reported as `` `${file}:${lineNumber} ${line.trim()}` ``.
  - **The window is load-bearing and must be tested as such.** `docs/decisions/0026-pi-version-contract-runtime-floor.md:15` reads "…over pi's documented `\"*\"` convention (`docs/packages.md:88`)…" — measured: the 40-char window before the match is `` over pi's documented `"*"` convention (` `` and `OWNER` matches it, so that line is **legitimate and must not be flagged**. It is out of this plan's editing scope precisely because it is already owned. Put that exact string in `MUST_PASS`; without it the guard can be "fixed" into a path-absence grep that fails correct prose, or loosened until it catches nothing.

- **R2** `NUMBERED_HEADING = /^#\s*ADR\s*[0-9]/` tested against the **first line only** of each `docs/decisions/NNNN-*.md`. Key on `# ADR <digits>`, *not* on "any digit", so `0003-shared-version.md` ("all 9 packages" — amended by Task 1 anyway), `0021-…` ("amends 0010") and `0024-…` ("pi ≥ 0.99") are not false positives.

- **R3** `ADR_REF = /ADRs?\s+([0-9]{4})(\s*[–-]\s*[0-9]{4})?/g` over every file in the scan set — note the **optional range group inside the same match**. Every number in the matched span must be the `NNNN` prefix of some file in `docs/decisions/`. Build the valid set once with `readdirSync` + `/^(\d{4})-.+\.md$/`. This is the rule that catches the *next* collision from any direction, including a renumbered file whose references were not updated.
  - **Do not write the base pattern as `ADRs?\s+([0-9]{4})\b`.** That trailing `\b` terminates the match at the first number, so the range group can never participate and `ADRs 0015–0019` silently checks only `0015` — measured: with the `\b` form, `ADRs 0015–9999` reports **clean**, i.e. the guard misses the exact defect it exists to catch. The optional group above is what makes the range form check both endpoints. Extract numbers from the whole match with a second `/[0-9]{4}/g` pass over `match[0]`, and dedupe before testing.
  - **Ranges are expanded — decided, not left open.** The real en-dash cite at `docs/decisions/0024-mcp-deprecated-for-pi-builtin.md:23` reads `ADRs 0015–0019`; a range is exactly where a renumber would dangle, so both endpoints (and every number between them) are validated. Do not implement a "document the limit instead" variant — it leaves the guard blind at the one site already using the range form.
  - Verified against the tree: `` `docs/decisions/0029` `` (a path, no `ADR ` prefix) and `docs/roadmap/pi-1-x-alignment.md` yield nothing; `ADR 0012 in-package` → `0012`; `ADR 0026's rule` → `0026`; `ADRs 0015–0019` → clean; `ADRs 0015–9999` → flags `9999`.

- **Anti-vacuity (required — a guard that matches nothing is worse than no guard).** Following `readme-agreement.test.ts`'s "the stale-claim patterns catch rewordings, and leave the honest wording alone" and `log-discipline.test.ts`'s "walks the whole suite, not an empty file set":
  - `it("scans the durable set, not an empty list")` — assert `files.length > 300` (measured 358) and that `packages/core/src/overlay.ts`, `packages/subagent/src/row-block.ts`, `docs/decisions/0015-mcp-oauth-refresh-strategy.md`, `docs/features/ui.md` and `AGENTS.md` are all present.
  - `it("R1 catches a bare pi-doc path and leaves owned and ours-only paths alone")` — a `MUST_FLAG` array of synthetic strings (`` `docs/tui.md` asks for exactly that ``, `// see docs/extensions.md:165`, `` (`docs/packages.md:88`) ``) each producing ≥1 violation, and an `MUST_PASS` array (`(docs/features/footer.md)`, `docs/decisions/0012-plugin-gate-in-package-namespace.md`, `docs/roadmap/pi-1-x-alignment.md`, `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md`, `` `docs/decisions/NNNN-slug.md` ``, `[ADR 0031](../decisions/0031-assert-only-ui-state-our-settings-ask-for.md)`, ``pi's `docs/tui.md` asks for that``, `` (`@earendil-works/pi-coding-agent` `docs/tui.md`) ``) each producing zero — the eighth being the real `0026:15` string, `over pi's documented \`"*"\` convention (\`docs/packages.md:88\`)`, which is the case the 40-char window exists to pass. Assert every entry in both arrays behaves as classified.
  - `it("R2 catches a numbered heading and leaves bare titles alone")` — `# ADR 0001: X` flagged; `# MCP OAuth token refresh strategy`, `# Sudo in bridge mode: Client-supplied confirm + password (amends 0010)` and `# Deprecate the mcp package in favor of pi's built-in MCP (pi ≥ 0.99)` not flagged.
  - `it("R3 catches a number with no decision behind it")` — `see ADR 9999` flagged; `see ADR 0004` and the real `ADRs 0015–0019` not. Plus the range-expansion case the rule exists for: `ADRs 0015–9999` **is** flagged (proving the second endpoint is checked, not skipped) and `ADRs 0015–0019` is not (proving expansion does not invent violations).
  - Then the three real assertions: `it("no citation points at another project's docs without naming them")`, `it("no decision heading carries an ADR number")`, `it("every ADR reference names a decision that exists")` — each asserting the violation list equals `[]`, with the list interpolated into the failure message so the next reader sees where.

- **Allow-list:** none. Every R1 site is fixed by Task 2 and every R2 site by Task 1, so the guard lands with an empty allow-list, matching `screen-mode-discipline.test.ts`. If a future exemption is unavoidable, use `log-discipline.test.ts`'s `{ file, reason }` shape with a `reason` that names the task removing it.

**Steps:**
- [ ] Confirm the tree is post-Task-1 and post-Task-2, with the **owner-aware** form (a plain path grep would still match the corrected `` pi's `docs/tui.md` `` and mislead you into thinking Task 2 did not land):
      `grep -c '^# ADR [0-9]' docs/decisions/*.md | grep -v ':0'` → no output, and
      `grep -rnE '(^|[^[:alnum:]_/.-])docs/(tui|extensions|packages)\.md' packages meta --include='*.ts' | grep -vE "pi's|@earendil-works"` → no output.
      If either answers, Tasks 1/2 have not landed — stop, this guard would fail for the right reason and be mistaken for a broken guard.
- [ ] Write `meta/src/citation-discipline.test.ts` with the anti-vacuity tests **first** and the three real assertions commented out. Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run meta/src/citation-discipline.test.ts` → the anti-vacuity tests pass, proving each pattern fires on a synthetic violation and stays quiet on all eight `MUST_PASS` forms.
- [ ] Prove R1 is not dead by temporarily inserting `` // x docs/tui.md `` into a scanned file, re-running the real R1 assertion, and confirming it fails naming that file:line; then remove the line and re-run to green. Record the observed failure text in the commit body — `readme-agreement.test.ts` and `log-discipline.test.ts` both carry this non-vacuity evidence.
- [ ] Uncomment the three real assertions. Run `TMPDIR=/home/daniel/.tmp/vitest npx vitest run meta/src/citation-discipline.test.ts` → all tests pass, `Test Files 1 passed (1)`.
- [ ] Run `cd meta && npx tsc --noEmit` → clean.
- [ ] Run `TMPDIR=/home/daniel/.tmp/vitest pnpm test` from the repo root → expect the previous **149 files / 2534 tests** (measured 2026-11-11) plus this new file, i.e. 150 files, all passing. Report the actual figures rather than assuming them. **Prove the new file actually ran** — `grep citation-discipline` in the output must show it with a non-zero test count. `vitest.config.ts` sets `passWithNoTests: true`, so a guard that fails to be collected exits 0 and the run looks green while guarding nothing.
- [ ] Commit: `git add meta/src/citation-discipline.test.ts && git commit -m "test: guard ADR heading numbers, foreign doc citations, and dangling ADR references (#117)"`

**Acceptance criteria:**
- [ ] `meta/src/citation-discipline.test.ts` runs under `pnpm test` from the repo root with no CI change and no new dependency.
- [ ] All three real assertions pass on an empty violation list, and each rule is separately proven capable of failing (the `MUST_FLAG`/`MUST_PASS` fixtures, plus the R1 insertion check).
- [ ] The guard does not read `$HOME`. Test it the way `readme-agreement.test.ts` is proven: **from the repo root**, with an emptied environment and a `$HOME` that does not exist —
      `cd <repo root> && env -i PATH="$PATH" HOME=/nonexistent TMPDIR=/home/daniel/.tmp/vitest ./node_modules/.bin/vitest run meta/src/citation-discipline.test.ts` → passes (verified against `readme-agreement.test.ts` this way on 2026-11-11: `Tests 6 passed (6)`).
      **Trap — do not "improve" this by changing directory or passing `--root`.** Both `cd /tmp && vitest run --root <repo> …` and `cd / && … --root <repo>` print `No test files found, exiting with code 0`: vitest resolves the `test.projects` globs against the *invocation* cwd, so a relocated run reports a vacuous green and exit 0. Any portability check that moves the cwd proves nothing.
- [ ] No file outside `meta/src/` is modified by this task.

---

## After the tasks

- Fan the three branches in plan order (1, 2, 3) and run the full suite on the integrated tree — the per-child results prove each task alone and say nothing about the combination.
- Close #117 with a note naming what was deferred *out* of this pass (the nine stale suite counts, `AGENTS.md:142`'s "11 components", the `0015`–`0019` status question) so the issue does not silently re-open.
- On ship, delete this roadmap doc — the durable content lives in `docs/research/adr-numbering-and-foreign-doc-citations.md`, the guard itself, and git history.
