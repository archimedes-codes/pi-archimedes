---
status: committed
done-when: the onboarding overlay sizes every row through `borderContentWidth`, a plugin row always draws a blank separator column between label and description, and a content-level test in `meta/src/onboarding/overlay-layout.test.ts` fails on the old code and passes on the new (the frame-width audit is NOT the gate — see Decisions); GitHub issue #99 closed with a link to the PR.
task: tsk_9c4f04e6-8913-4746-9619-2d31aeed9725
issue: https://github.com/archimedes-codes/pi-archimedes/issues/99
---

# Onboarding overlay width maths (#99)

## Spec

**Problem:** the first-run onboarding wizard sizes its rows with hand-rolled `width - 2` arithmetic
while the shared border it feeds them (`wrapWithBorder`) only allocates `width - 4`, so every row is
built 2 columns wider than the cell it is poured into and loses columns to the border clip. On the
same plugin row, `String.prototype.padEnd` pads a label that pi-tui has already truncated, which
under-adds the padding and fuses the label onto its description — today `Footer status bar` renders as
`Footer status bStatus bar with cost/timer`.

**Solution:** make the onboarding overlay a well-behaved consumer of the shared overlay chrome, the
way `/archimedes` already is: derive one `contentWidth = borderContentWidth(width)` per render, size
every row and every nested truncation against it, and pad the label column with the visible-width
`padEnd` that `@pi-archimedes/core/overlay` already exports. Then add a **content-level** layout test —
one that measures the fields *inside* a row — because the existing frame-width audit is provably
unable to see either defect.

**Out of scope:**
- **Not** reworking `meta/src/overlay-width-audit.test.ts` into a layout test. It measures bleed and it
  does that job well; it gets a header note pointing at the new test, nothing more.
- **Not** widening the plugin label field from 16 to 18 columns. `Footer status bar` (17 columns) stays
  clipped to 15. Widening costs two description columns at every frame to un-clip one label — it would
  make the truncation #99 reports *worse*. Decided with the maintainer.
- **Not** touching `packages/subagent/src/agent-panel.ts:1427-1428`, which hand-rolls the same
  arithmetic but arrives at the correct `width - 4`. It is a DRY smell, not a bug.
- **Not** changing the thinking/tool/spinner steps' visible output. Verified below: it does not change.

**Decisions:**
- **The audit cannot be the gate — proven, not assumed.** Every `width - 2` in
  `meta/src/onboarding/overlay.ts` was rewritten to `width - 20` (an 18-column regression) and both
  `meta/src/overlay-width-audit.test.ts` and all 25 tests in `meta/src/onboarding/overlay.test.ts`
  stayed green. `wrapWithBorder` calls `padEnd(line, contentWidth)`
  (`packages/core/src/overlay.ts:94`), which truncates over-long rows *and* pads short ones to exactly
  the content cell, so every line measures exactly the frame regardless of what the caller passed. The
  audit's assertion (`tuiVisibleWidth(line) === frameWidth`) is true by construction. This amends the
  card's done-when, which named that audit as the covering test.
- **Two commits, not one.** The collision and the width base are independent defects with independent
  tests; the state matrix below shows each assertion bites on exactly the state it targets. Separating
  them keeps the user-visible bug revertable without reverting the reported one.
- **Keep the `String.padEnd` sites that are currently safe, but convert them anyway.**
  `padEnd(opt.label, 9)` and `padEnd(name, 15)` are safe only by data accident (labels are ≤ 7; longest
  spinner `diagonal-swipe` is 14 against a 15 field). Converting all three sites in the file removes the
  trap class rather than the one instance.

**Evidence:** `docs/research/onboarding-overlay-width-maths.md` (and card artifact `research`), which
carries the mutation experiment, the per-frame measurement table, and the pi-tui source citation
(`@earendil-works/pi-tui@1.4.0` `dist/utils.js:130-141`, `finalizeTruncatedResult` appends `\x1b[0m`
unconditionally on a cut, so a truncated string's `.length` exceeds its visible width). Every number in
this spec was re-verified against the tree on 2026-11-12.

## Plan

**Goal:** the onboarding overlay sizes through the shared chrome helper, its plugin rows always
separate label from description, and a test exists that can actually see both properties.
**Architecture:** one component file (`meta/src/onboarding/overlay.ts`) plus one new test file that
asserts on the *content cell* of rendered rows rather than on the frame. No new modules, no API changes,
no settings changes.
**Tech Stack:** TypeScript ESM, vitest, pi-tui's `visibleWidth`/`truncateToWidth`,
`@pi-archimedes/core/overlay`.

---

## Parallelisation

**Verdict:** PARALLEL — 2 waves
- Wave 1: Task 1 (`meta/src/onboarding/overlay.ts`, `meta/src/onboarding/overlay-layout.test.ts`) and
  Task 3 (`docs/features/onboarding.md`) — file sets are disjoint, verified pairwise; Task 3 imports
  nothing from Task 1 and is provable from the base alone.
- Wave 2: Task 2 — modifies the same source file and appends to the same test file that Task 1 creates,
  so it shares two paths with Task 1 and cannot join Wave 1.

Gate 3 was checked against the commands, not just the file lists: every verification step is
`npx vitest run` / `npx tsc --noEmit` inside `meta/`. Neither rewrites a lockfile, and the repo holds no
snapshot directories (`find meta packages -name __snapshots__` → empty), so no task touches a shared
artifact implicitly.

**Base:** branch from `origin/main` (`70cd8fe`, v2.13.0) — not from the current working branch
(`fix/todo-schema-typebox-parity`, unrelated work) and not from local `main`, which is 17 commits behind
origin. Verified before planning: `meta/src/onboarding/overlay.ts`, `overlay.test.ts`,
`overlay-width-audit.test.ts`, `packages/core/src/overlay.ts`, `meta/src/plugins.ts`,
`packages/ui/src/config.ts` and `docs/features/onboarding.md` are byte-identical between the two, so
every line number and measured number in this plan holds on the base.

---

### Task 1: Fix the label/description collision on the plugin step

**Parallel:** wave 1 — disjoint from Task 3 (`docs/features/onboarding.md`); Task 2 runs after this one
because it modifies the same two files.

**Context:** GitHub issue #99 reports the onboarding plugin step truncating descriptions one column
short. While verifying that, a second defect surfaced on the same row and is more visible: the label
column is padded with `String.prototype.padEnd`, which counts `.length`. pi-tui's `truncateToWidth`
appends `\x1b[0m` whenever it cuts, so a label that had to be truncated has a `.length` larger than its
visible width, `padEnd(16)` adds zero spaces, and the description is drawn flush against the label with
no separator. With the real plugin list (`meta/src/plugins.ts:22-32`), `Footer status bar` is 17
visible columns against a 15-column cap, so it renders as `Footer status bStatus bar with cost/timer`
at every frame width. `@pi-archimedes/core/overlay` already exports a `padEnd` that pads by visible
width (`packages/core/src/overlay.ts:48`); it is imported into this file already but used only for whole
rows. This task routes the three field-level pads through it. Deliberately **not** in this task: the
`width - 2` → `borderContentWidth` change (Task 2). Keeping them apart is what makes each test bite on
exactly one defect.

**Files:**
- Modify: `meta/src/onboarding/overlay.ts`
- Test: `meta/src/onboarding/overlay-layout.test.ts` (create)

**What to implement:**

1. Create `meta/src/onboarding/overlay-layout.test.ts` with exactly this content:

```ts
/**
 * Content-level layout audit for the onboarding wizard's plugin step.
 *
 * `meta/src/overlay-width-audit.test.ts` measures whether every produced line
 * lands on the frame. It cannot see a row that is under-sized: `wrapWithBorder`
 * calls `padEnd(line, contentWidth)` (`packages/core/src/overlay.ts:94`), which
 * pads short rows up and truncates long ones, so a row built to any width at all
 * still measures exactly the frame. That audit therefore passes on an 18-column
 * layout regression (verified by mutation) — it detects bleed, not layout.
 *
 * This file measures the fields INSIDE a row instead: the label column and the
 * description column of the plugin step, in drawn columns, against the content
 * cell `wrapWithBorder` actually allocates.
 */

import { describe, it, expect, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { borderContentWidth } from "@pi-archimedes/core/overlay";
import { createOnboardingOverlay } from "./overlay.js";

// Parity with overlay.test.ts / overlay-width-audit.test.ts: the live spinner
// previews are not what this file measures, and the mock keeps renders
// deterministic. (Step 3 is never rendered here.)
vi.mock("@pi-archimedes/ui/editor", () => ({
  spinFrame: vi.fn((style: string, tick: number) => {
    const c = 0x2800 + ((tick % 8) + (style.length % 4));
    return String.fromCharCode(c) + "⣷⣾⣽";
  }),
}));

// No ANSI from the theme: the assertions below index the drawn row by column, so
// a styled row would need stripping first (it is stripped anyway — see `cell`).
const theme = { fg: (_token: string, text: string) => text };

// The plugin row is `"<cursor> <marker> <label:16><description>"` inside the
// content cell: 5 columns of chrome, a 16-column label field at [5..20], and the
// description from column 21.
const PLUGIN_ROW = /^(?:[> ] ) [✓·] /;
const LABEL_FIELD_END = 20;
const DESC_START = 21;

/**
 * A fixture, not the real plugin list, for the same reason the frame audit uses
 * one: the capture has to be the shape the assertion is about. `over` is the one
 * real label wider than the 15-column cap (`Footer status bar`, 17 columns) and
 * is the row that collides; `exact` sits exactly on the cap, where the padding
 * call is most likely to under-add; `short` exercises the padded side. The
 * descriptions are long enough to fill the budget at every frame audited, so the
 * budget assertion below can never pass vacuously.
 */
const LONG_DESCRIPTION = "d".repeat(200);
const PLUGINS = [
  { id: "over", label: "Footer status bar", description: LONG_DESCRIPTION, selected: true },
  { id: "exact", label: "UI Enhancements", description: LONG_DESCRIPTION, selected: true },
  { id: "short", label: "Web", description: "Web search", selected: false },
];

/** The content cell of a bordered row: border glyphs and the 1-space padding removed. */
function cell(line: string): string {
  return stripTerminalSequences(line).replace(/^│/, "").replace(/│$/, "").slice(1, -1);
}

/** The plugin step's content cells, in order, at `frame`. */
function pluginRows(frame: number): string[] {
  const comp = createOnboardingOverlay({
    theme,
    thinkingDefault: "Full",
    toolDefault: "Minimal",
    plugins: PLUGINS,
    spinners: ["typing"],
    spinnerDefault: "typing",
    onDone: () => {},
  });
  comp.handleInput("\r"); // step 0 → 1
  comp.handleInput("\r"); // step 1 → 2 (plugins)
  return comp.render(frame).map(cell).filter((line) => PLUGIN_ROW.test(line));
}

const FRAMES = [40, 60, 84, 100];

describe("onboarding plugin row layout", () => {
  for (const frame of FRAMES) {
    it(`draws one row per plugin at frame ${frame}`, () => {
      expect(pluginRows(frame)).toHaveLength(PLUGINS.length);
    });

    it(`keeps a blank separator column between label and description at frame ${frame}`, () => {
      const collided = pluginRows(frame).filter((line) => line[LABEL_FIELD_END] !== " ");
      expect(
        collided,
        `frame ${frame}: the label field does not end on a blank column, so the description is drawn flush against the label: ${JSON.stringify(collided)}`,
      ).toEqual([]);
    });
  }
});
```

2. Run it. **Expect the separator test to fail** on all four frames, with the `Footer status bar` row in
   the reported list (its description column starts one character early, at index 20). If it passes,
   stop and investigate — the fixture is no longer reproducing the defect.

3. In `meta/src/onboarding/overlay.ts`, replace the three field-level `String.prototype.padEnd` calls
   with the visible-width `padEnd` already imported from `@pi-archimedes/core/overlay`:
   - `:183` and `:199` — `${opt.label.padEnd(9)}` → `${padEnd(opt.label, 9)}`
   - `:220` — `${label.padEnd(16)}` → `${padEnd(label, 16)}`
   - `:237` — `${name.padEnd(15)}` → `${padEnd(name, 15)}`

   Do **not** change any `width - 2`, `width - 14` or `width - 26` constant in this task, and do not
   touch `meta/src/overlay-width-audit.test.ts`.

4. Re-run. Do not change the assertions to make them pass.

**Verification of the split (do not skip):** with only this task applied, the separator assertion passes
and the budget assertion that Task 2 adds still fails. Confirmed on the base tree before planning, so
Task 1's commit cannot accidentally claim to cover #99's reported defect.

**Steps:**
- [ ] Create `meta/src/onboarding/overlay-layout.test.ts` with the content above
- [ ] Run `cd meta && npx vitest run src/onboarding/overlay-layout.test.ts`
  - Did the separator test fail on frames 40/60/84/100, naming the over-long label row? If it passed,
    stop — the fixture is not reproducing the collision.
- [ ] Apply the three `padEnd` replacements in `meta/src/onboarding/overlay.ts`
- [ ] Run `cd meta && npx vitest run src/onboarding/overlay-layout.test.ts`
  - All green? If not, fix and re-run before continuing.
- [ ] Run `cd meta && npx vitest run` — 184 existing tests plus the new ones, all passing
  (verified against a throwaway copy of this exact edit before planning: 184/184).
- [ ] Run `cd meta && npx tsc --noEmit` — clean (exit 0)
- [ ] Commit: `fix(meta): keep the plugin row's label and description separated (#99)`

**Acceptance criteria:**
- [ ] `meta/src/onboarding/overlay-layout.test.ts` exists and fails on the pre-fix tree
- [ ] No plugin row can draw its description without a blank column at index 20 of the content cell
- [ ] No `String.prototype.padEnd` remains in `meta/src/onboarding/overlay.ts` (check:
      `grep -n "\.padEnd(" meta/src/onboarding/overlay.ts` returns nothing)
- [ ] The full `meta` suite and `tsc --noEmit` are green
- [ ] No `width - 2` / `width - 14` / `width - 26` constant was altered in this task

---

### Task 2: Size the onboarding overlay through `borderContentWidth`

**Parallel:** none — modifies `meta/src/onboarding/overlay.ts` and appends to
`meta/src/onboarding/overlay-layout.test.ts`, both owned by Task 1.

**Context:** this is what issue #99 actually reports. `render(width)` builds every row to `width - 2`
(15 sites) and then hands them to `wrapWithBorder(lines, width, theme)`, which allocates only
`width - 4` (`packages/core/src/overlay.ts:83-96`). The border's `padEnd(line, contentWidth)` absorbs
the error — over-long rows are clipped, so nothing bleeds and the frame audit stays green — but the row
loses columns it was laid out to use. `ADR 0017` (`docs/decisions/0017-mcp-panels-use-shared-overlay-chrome.md:12-16`)
already states the house rule: content width comes from `borderContentWidth(width)`.
`meta/src/settings-manager.ts:539` follows it; onboarding is the only `wrapWithBorder` consumer that
does not.

Measured effect, so the executor knows what to expect and does not "fix" more than asked: only the
plugin step changes visibly. The thinking/tool steps' budget `width - 14` is one column *wider* than
fits and the clip removes exactly that column, so the two errors cancel and their output is identical
before and after; the spinner step and every header/footer are likewise unchanged. The plugin step gains
one description column at every frame — at the default frame 84 that is visible as the `web` plugin's
description going from clipped to complete.

**Files:**
- Modify: `meta/src/onboarding/overlay.ts`
- Test: `meta/src/onboarding/overlay-layout.test.ts` (append a describe block)
- Modify: `meta/src/overlay-width-audit.test.ts` — **header comment only**, no assertion changes

**What to implement:**

1. Append this as the **third `it()` inside the existing `for (const frame of FRAMES)` loop** (after the
   separator test), so it inherits `frame`, `FRAMES`, `pluginRows`, `DESC_START` and the
   `borderContentWidth` import — all already present from Task 1:

```ts
    it(`gives the description every column the border allocates for it at frame ${frame}`, () => {
      // The content cell the border allocates, minus this row's 5 chrome columns
      // and the 16-column label field.
      const budget = borderContentWidth(frame) - DESC_START;
      const drawn = pluginRows(frame).map((line) =>
        visibleWidth(line.slice(DESC_START).trimEnd()),
      );

      // Upper bound: nothing is drawn wider than the cell (the clip would hide it).
      const over = drawn.filter((columns) => columns > budget);
      expect(
        over,
        `frame ${frame}: descriptions drawn wider than the ${budget}-column budget: ${over.join(",")}`,
      ).toEqual([]);

      // Lower bound — the half `wrapWithBorder` makes invisible. Padding short rows
      // up is what lets a caller that under-sized its rows pass a frame-width audit,
      // so an upper bound alone is a toothless guard: without this, sizing every row
      // to `width - 20` measures frame-perfect and passes.
      const filled = drawn.filter((columns) => columns === budget).length;
      expect(
        filled,
        `frame ${frame}: no row fills the ${budget}-column budget (drawn ${drawn.join(",")}) — the capture is not crowded, so this assertion proves nothing`,
      ).toBeGreaterThan(0);
    });
```

2. Run it. **Expect it to fail** on all four frames: the rows are truncated to `width - 26`, one column
   below the `borderContentWidth(frame) - 21` budget, so nothing fills the budget and the lower bound
   trips. (Verified on the base tree: the upper bound alone passes on the unfixed code — the lower bound
   is the half that bites.)

3. In `meta/src/onboarding/overlay.ts`, introduce one content width per render and use it everywhere:

   - Add `borderContentWidth` to the existing `@pi-archimedes/core/overlay` import (alphabetically before
     `padEnd`, at `:2-8`).
   - At the top of `render(width)` (line 168-169) add:
     ```ts
     const contentWidth = borderContentWidth(width);
     ```
   - Replace all 15 `width - 2` row-width arguments with `contentWidth` — lines 170, 171, 172, 175, 184,
     189, 191, 200, 205, 207, 221, 226, 228, 237, 240.
   - Rebase the two nested description budgets on the same value, keeping each row's existing chrome:
     `width - 14` → `contentWidth - 11` (thinking/tool rows: 2 cursor + 9 label = 11), lines 183 and 199;
     `width - 26` → `contentWidth - 21` (plugin rows: 5 chrome + 16 label = 21), line 220.
   - After the change, `grep -n "width - " meta/src/onboarding/overlay.ts` must return **nothing**.

   Do not change the 15-column label cap, the 16-column label field, or any copy text. Do not change any
   assertion in `meta/src/overlay-width-audit.test.ts`.

4. Add a pointer to `meta/src/overlay-width-audit.test.ts`'s **header comment only** (the block at
   `:1-10`), so the next reader does not repeat the mistake this plan had to discover by mutation
   testing. Suggested wording, appended to the existing comment:

   > This audit measures bleed: `wrapWithBorder` pads short rows up and truncates long ones
   > (`packages/core/src/overlay.ts:94`), so every produced line lands on the frame whatever width the
   > caller sized its rows to — an under-sized row is invisible here by construction. Row *layout* (does
   > a field get the columns it asked for) is asserted in `onboarding/overlay-layout.test.ts`.

**Steps:**
- [ ] Append the budget assertion to `meta/src/onboarding/overlay-layout.test.ts`
- [ ] Run `cd meta && npx vitest run src/onboarding/overlay-layout.test.ts`
  - Does the new assertion fail on the "no row fills the budget" message at all four frames? If it fails
    on the *upper* bound instead, stop — something is drawing past the cell and the diagnosis differs.
- [ ] Apply the `borderContentWidth` change to `meta/src/onboarding/overlay.ts`
- [ ] Run `grep -n "width - " meta/src/onboarding/overlay.ts` — must print nothing
- [ ] Run `cd meta && npx vitest run src/onboarding/overlay-layout.test.ts` — green
- [ ] Run `cd meta && npx vitest run` — all green (184 + the new tests; verified against a throwaway copy
      of this exact edit: 184/184, so no existing assertion moves)
- [ ] Run `cd meta && npx tsc --noEmit` — clean
- [ ] Run `pnpm test` from the repo root — the integrated suite CI runs (all 13 packages, slower than `meta` alone); all green
- [ ] Add the header note to `meta/src/overlay-width-audit.test.ts`
- [ ] Commit: `fix(meta): size the onboarding overlay through borderContentWidth (#99)`

**Acceptance criteria:**
- [ ] `meta/src/onboarding/overlay.ts` contains no hand-rolled width arithmetic and imports
      `borderContentWidth`
- [ ] The new budget assertion fails on the pre-fix tree and passes after
- [ ] `meta/src/overlay-width-audit.test.ts` assertions are unchanged (only its header comment grew)
- [ ] All 184 pre-existing tests still pass, `tsc --noEmit` clean, root `pnpm test` green
- [ ] The `web` plugin description renders complete at frame 84 (it was clipped by one character before)

---

### Task 3: Correct the drift in the onboarding feature doc

**Parallel:** wave 1 — touches only `docs/features/onboarding.md`; no overlap with Task 1
(`meta/src/onboarding/overlay.ts`, `meta/src/onboarding/overlay-layout.test.ts`) and no import of
anything Task 1 creates.

**Context:** `docs/features/onboarding.md` is the present-tense description of this surface and its
front-matter still reads `last-verified: 2026-09-30`. Three statements in it contradict the shipped code,
each verified against the tree on 2026-11-12. The doc is also the natural home for the width contract
this change establishes, so a future overlay edit finds the rule where it will look. No test reads
`docs/` for this file (`meta/src/readme-agreement.test.ts` compares the two READMEs only), so this task
is doc-accuracy work with no test dependency.

**Files:**
- Modify: `docs/features/onboarding.md`

**What to implement — exactly these five edits:**

1. **Tool style option names** (`:17-18`, `:27`). The doc says the tool style question is
   "each `Full` / `Compact`" and describes the write as "from the **tool style** choice (Full or
   Compact)". The code's `ToolStyle` is `"Native" | "Minimal"` (`packages/ui/src/config.ts:28`, and
   `TOOL_OPTIONS` in `meta/src/onboarding/overlay.ts:54-57`). Thinking style really is `Full` / `Compact`
   — leave that one alone.
2. **Default tool style** (`:57`, the settings table). The doc says the `archimedes.ui.toolStyle` default
   is `Compact`; `DEFAULT_UI_CONFIG` sets `toolStyle: "Minimal"` (`packages/ui/src/config.ts:111`).
3. **Spinner spacing** (`:19`). The doc claims "The spinner options are separated by a blank line for
   slight vertical spacing." The code renders them consecutively — the per-option spacing was dropped so
   the 10 options fit an 80%-max-height overlay on a 24-row terminal (`meta/src/onboarding/overlay.ts:234-236`),
   and `overlay.test.ts:286-309` ("spinner step renders options consecutively") plus
   `overlay.test.ts:311-323` ("renders exactly 19 lines") pin that. Rewrite the sentence to say the
   options render consecutively to keep the tallest step at 19 lines.
4. **Add the width contract**, as a short paragraph in the "What it is" section: every row is sized from
   `borderContentWidth(width)` (`@pi-archimedes/core/overlay`), never hand-rolled arithmetic, because
   `wrapWithBorder` allocates `width - 4` and silently clips anything wider — so a wrong constant shows
   up as lost columns, never as a broken frame. Name the label column's 15-column cap and note that
   padding it uses the chrome's visible-width `padEnd`, since `String.prototype.padEnd` counts
   `.length` and pi-tui appends a reset sequence when it truncates.
5. **Bump front-matter**: `last-verified: 2026-11-12` and
   `verified-by: npx vitest run meta/src/onboarding/overlay-layout.test.ts meta/src/onboarding/overlay.test.ts meta/src/onboarding/index.test.ts`
   (use the command you actually ran).

**Steps:**
- [ ] Read `docs/features/onboarding.md` in full, then confirm each of the three drifts against the code
      before editing — if a claim has already been corrected, leave it and say so in the commit body
- [ ] Apply edits 1-4
- [ ] Run `cd meta && npx vitest run src/onboarding/` — green (this task changes no code; it proves the
      doc still describes a passing surface)
- [ ] Apply edit 5 with the command you ran
- [ ] Commit: `docs(onboarding): correct tool style values, spinner spacing, and record the width contract (#99)`

**Acceptance criteria:**
- [ ] The doc names `Native` / `Minimal` for the tool style and `Minimal` as its default
- [ ] The doc no longer claims blank-line spacing between spinner options
- [ ] The doc states the `borderContentWidth` rule and the visible-width-padding rule
- [ ] `last-verified` reflects a date on or after the change, with the command that backs it

---

## Notes for the executor

- **Never use `git add -A` in this run.** The working tree holds untracked files from unrelated sessions
  (`err.txt`, `.review-*.mjs`, other `docs/research/*` and `docs/roadmap/*` docs). Stage only the paths
  each task names.
- Each task is independently revertable; Task 1 alone fixes the user-visible collision, Task 2 alone
  fixes the reported truncation.
- Close #99 after fan-in with a note that the fix condition was amended: the frame-width audit could not
  gate it (mutation-tested), so `onboarding/overlay-layout.test.ts` is the covering test.
