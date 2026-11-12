---
status: current
last-verified: 2026-11-12
verified-by: local code research — mutation testing + rendered-output measurement through pi-tui's own visibleWidth; 3 researcher angles (1 died mid-report, its findings re-verified locally)
task: tsk_9c4f04e6-8913-4746-9619-2d31aeed9725
issue: https://github.com/archimedes-codes/pi-archimedes/issues/99
---

# Onboarding overlay width maths (#99) — and why its named test can't gate the fix

**Settled question:** is #99's `width - 2` / `width - 4` mismatch in the onboarding overlay still
live, what does it actually cost the user, and can `meta/src/overlay-width-audit.test.ts` — the test
the issue names as its gate — actually catch a fix?

Scope decided at the Phase 4 stop: **fix both defects found here, and add the content-level test the
existing audit provably cannot be.**

## Executive Summary

1. **#99 is still live.** Nothing fixed it; the file predates the issue and no PR since #98 touched it.
   The triage verdict *likely stale* was silence, not a fix.
2. **The mismatch covers every row of the overlay**, not just the plugin step — 14 call sites pad to
   `width - 2` where the border hands them `width - 4`.
3. **Scope is one file.** Of the three `wrapWithBorder` consumers, onboarding is the only one with a
   wrong constant.
4. **Measured cost is 1 column**, confirming the author's re-scope: at the default frame 84, two of
   eleven plugin descriptions lose one letter.
5. **🛑 The named gate cannot gate the fix.** Mutating every `width - 2` to `width - 20` — an
   18-column layout regression — left both the audit and all 25 overlay tests green. The audit is
   true by construction. The card's done-when ("the audit covers it") is **not satisfiable as
   written**; a new content-level assertion is required.
6. **A second, more visible defect lives on the same row** and #99 never mentions it: a
   label/description collision. `Footer status bar` renders as `Footer status bStatus bar with
   cost/timer` at every width, because `String.prototype.padEnd` counts `.length` and pi-tui appends
   a reset sequence on truncation.

## Findings

### F1. The defect is live; the staleness verdict was silence

- `meta/src/onboarding/overlay.ts` contains zero references to `borderContentWidth`.
- Last commit to the file: `a5750af` (2026-10-01) — *before* the issue was opened (2026-10-13).
- `gh pr list --state all --search "onboarding"` → empty. The card's open question ("did PRs merged
  after #98 already touch this overlay?") is answered: **no**.

### F2. The mismatch is real and covers every row

`meta/src/onboarding/overlay.ts:168-243` — `render(width)` sizes its rows to `width - 2` at
`:170, 171, 172, 175, 184, 189, 191, 200, 205, 207, 221, 226, 228, 237, 240`, then hands them to
`wrapWithBorder(lines, width, theme)` at `:243`.

The chrome (`packages/core/src/overlay.ts:83-96`) allocates:

```
innerWidth   = max(1, width - 2)          // the border eats two columns
contentWidth = max(1, innerWidth - 2)     // minus 1 space padding each side  →  width - 4
```

So rows are built 2 columns wider than the cell they are poured into. `borderContentWidth()`
(`packages/core/src/overlay.ts:63-65`) computes exactly that value and exists so callers never
hand-roll it. `meta/src/settings-manager.ts:539` uses it; onboarding does not.

ADR 0017 (`docs/decisions/0017-mcp-panels-use-shared-overlay-chrome.md:12-16`) already states the
house rule: *"Content width via `borderContentWidth(width)`"*. Onboarding is the surface that breaks it.

The nested row budgets `width - 14` (`:183`, `:199`) and `width - 26` (`:220`) are derived from the
same wrong base, so they are inconsistent too until the base is fixed.

### F3. One file, not a suite-wide pass

Exactly three non-test consumers of `wrapWithBorder`:

| Surface | Content width | Verdict |
|---|---|---|
| `meta/src/settings-manager.ts:539` | `borderContentWidth(width)` | correct |
| `packages/subagent/src/agent-panel.ts:1427-1428` | hand-rolled `max(1, max(1, w-2) - 2)` | correct — evaluates to the same `w - 4` |
| `meta/src/onboarding/overlay.ts` | hand-rolled `width - 2` | **wrong** |

`agent-panel` duplicates the helper's arithmetic but arrives at the right number, so it is a DRY
smell, not a bug. Checked and out of scope (no `wrapWithBorder`): `packages/ui/src/editor/index.ts`,
`packages/ask/src/{dialog,picker}.ts`, `packages/sudo/src/prompt.ts`, `packages/todo/src/ui/todo-widget.ts`,
`packages/diff/src/render/split.ts`.

### F4. Measured user cost: 1 column (author's re-scope confirmed)

Rendered the real overlay with the real `PLUGINS` data (`meta/src/plugins.ts:22-32`) and measured
with pi-tui's `visibleWidth`. "Fits" = columns available for the description after the row's chrome
(`cursor 2 + space + marker + space + label field 16` = 21 columns).

The description budget is **exactly 1 column short of what fits at every width** — the code truncates
at `width - 26` where `borderContentWidth(width) - 21` = `width - 25` fits. Measured against the real
plugin data (`meta/src/plugins.ts:22-32`), rendering the component and asking whether each row draws
its description in full:

| frame | code truncates desc at | actually fits | rows clipped today | **rows the fix restores to complete** |
|---|---|---|---|---|
| 40 | 14 | 15 | 11 of 11 | 0 (every description is far longer than 15; each just gains its 15th char) |
| 60 | 34 | 35 | 4 (`ui`, `ask`, `subagent`, `web`) | 0 (`ask` is 36 — still 1 over; each gains 1 char) |
| **84** (`OVERLAY_CHROME` default) | **58** | **59** | **2** (`ui` 65, `web` 59) | **1 — `web` renders whole; `ui` gains 1 char** |
| 100 | 74 | 75 | 0 (longest description is 65) | 0 |

**Only the plugin step changes when the base is fixed.** Measured against rendered output, not
arithmetic:

| step | drawn output, today vs after sizing to `borderContentWidth` |
|---|---|
| thinking / tool | **identical at every width (40/60/84/100).** Their budget `width - 14` is 1 column *wider* than fits, and the border clip removes exactly that column — so the two errors cancel. The over-wide constant is still wrong, but it costs nothing visible. |
| plugins | **+1 column per clipped description** (2 rows at 84, 4 at 60, 11 at 40, 0 at 100) |
| spinner | identical — previews are a fixed 4 cells and the longest name (`diagonal-swipe`, 14) fits its 15-col field |
| header / section titles / footers | identical — all shorter than both budgets; only the padding target changes |

No bleed at any width: `wrapWithBorder` clips, so every row lands exactly on the frame. **The
author's 2026-10-15 re-scope is accurate.**

### F5. The audit cannot gate the fix — verified by mutation

`meta/src/overlay-width-audit.test.ts` is cited in #99 as the test a fix "can be checked against".
It cannot be.

**Experiment.** Every `width - 2` in `meta/src/onboarding/overlay.ts` was rewritten to `width - 20`
(an 18-column regression that would visibly gut the layout), then:

```
npx vitest run src/overlay-width-audit.test.ts src/onboarding/overlay.test.ts
 ✓ src/overlay-width-audit.test.ts (1 test)
 ✓ src/onboarding/overlay.test.ts (25 tests)
   Tests  26 passed (26)
```

Both suites stayed green. File restored to `HEAD` afterwards; `git diff` on it is empty.

**Why.** The audit's only assertion is `tuiVisibleWidth(line) === frameWidth`
(`meta/src/overlay-width-audit.test.ts:110-116`). That is true by construction, because
`wrapWithBorder` normalizes every row in **both** directions at
`packages/core/src/overlay.ts:94`:

```ts
const padded = padEnd(line, contentWidth);   // truncates over-long AND pads short
```

`padEnd` (`packages/core/src/overlay.ts:48-50`) delegates to `truncateToWidth(text, width, "", true)`,
which cuts long input and space-pads short input to exactly `width`. So a caller that under-sizes by
18 columns produces a frame-perfect row. **The audit is a bleed detector, not a layout detector.** It
can never distinguish "description drawn 58 columns" from "59 that fit" — the exact defect #99 reports.

**Consequence for the card.** The done-when clause *"…and `meta/src/overlay-width-audit.test.ts`
covers it"* is unsatisfiable as written: shipping the fix leaves that test passing for the same reason
it passes today. Closing #99 on the strength of a green audit would be closing on false confidence.
The fix needs a **content-level** regression test — one that measures the description *field* inside
the row against `borderContentWidth(width) - 21`, and fails before the change.

Precedent for content-level assertions exists in this repo: `packages/core/src/overlay.test.ts:209-216`
pins `borderContentWidth(84) === 80` against an explicit `W - 4` model, and
`meta/src/settings-panel-height.test.ts:31,91` imports `borderContentWidth` to build its expectations.
Nothing today pins *caller-side* width against *chrome-side* width — that is the missing class.

### F6. Unreported defect on the same row: label/description collision

`meta/src/onboarding/overlay.ts:217-220`:

```ts
const label = truncateToWidth(p.label, 15, "");
`${cursor} ${marker} ${label.padEnd(16)}${truncateToWidth(p.description, width - 26, "")}`
```

`label.padEnd(16)` is **`String.prototype.padEnd`**, which counts `.length`, not visible columns.
pi-tui's `truncateToWidth` appends a reset sequence unconditionally when it cuts —
`dist/utils.js:130-141` (`finalizeTruncatedResult`, `@earendil-works/pi-tui@1.4.0`):

```js
const reset = "\x1b[0m";
result = `${prefix}${hyperlinkClose}${reset}`;   // no ellipsis branch
```

So a truncated label's `.length` (19) exceeds its visible width (15), `padEnd(16)` adds **zero**
spaces, and the description is fused onto the label. Rendered today with real plugin data at frame 84:

```
✓ UI Enhancements Bash styling, editor spinner, thinking collapse, splash an   ← 15-col label: 1 space, ok
✓ Footer status bStatus bar with cost/timer                                    ← 17-col label: NO GAP
✓ Todo list       manage_todo_list tool + widget                               ← short label, ok
```

`Footer status bar` (17 visible columns, `meta/src/plugins.ts:23`) is the one label over the 15-column
cap. **1 of 11 rows collides, at every frame width** — this is more user-visible than the reported
1-column truncation, and it is on the very step the issue is titled after.

**The fix already exists in the suite.** `packages/core/src/overlay.ts:48` exports a visible-width
`padEnd`; verified against all 11 labels, it returns `"Footer status b\x1b[0m "` at exactly 16 columns
where `String.padEnd` returns 15. That module's own docstring (`:7-13`) warns about exactly this
`.length` trap.

**Latent siblings, safe by data accident.** The other three `String.padEnd` sites in the entire suite
are in this same file:
- `:183`, `:199` — `opt.label.padEnd(9)`; actual labels are `Full`(4) / `Compact`(7). Safe.
- `:237` — `name.padEnd(15)`; longest spinner is `diagonal-swipe` (14, `packages/ui/src/config.ts:34-43`).
  Safe by one column.

All four are one rename away from the same collision, and all four live in one file.

**Fixing the collision exposes a latent trade-off, decided with the maintainer.** The padding exists
because the longest plugin label, `Footer status bar` (17 columns), exceeds the 15-column label field.
Measured both ways:

| label field | labels clipped | descriptions clipped at 84 | at 60 | at 40 |
|---|---|---|---|---|
| 16 (current) | `footer` only | 1 of 11 (`ui`) | 4 of 11 | 11 of 11 |
| 18 (never clips) | none | 2 of 11 (`ui`, `web`) | 4 of 11 | 11 of 11 |

**Decision: keep the 16-column field and fix only the padding.** Widening to 18 buys one un-clipped
label and costs two description columns at every width — it would make the truncation #99 reports
*worse*. The label clip is pre-existing behaviour; the collision (zero gap) is the defect.

## Evidence

| Source | What it establishes | Credibility |
|---|---|---|
| `meta/src/onboarding/overlay.ts:168-243` | the 14 `width - 2` sites, the `padEnd(16)` collision | primary — read directly |
| `packages/core/src/overlay.ts:48,53,57,63,83,94` | the `w-4` contract, `padEnd`'s two-way normalization (the absorber) | primary |
| `@earendil-works/pi-tui@1.4.0 dist/utils.js:1017-…`, `:130-141` | `truncateToWidth` appends `\x1b[0m` on cut | primary (dependency source) |
| Mutation run (`width - 2` → `width - 20`, 26/26 tests green) | the audit cannot fail on caller-side width | direct experiment |
| Rendered output at frames 40/60/84/100 with real `PLUGINS` | 1-column loss; the collision string | direct experiment |
| `git log -- meta/src/onboarding/overlay.ts`; `gh pr list --search onboarding` | not fixed since the issue | primary |
| `docs/decisions/0017…:12-16` | the house rule onboarding breaks | project decision record |
| Issue #99 body + 2026-10-15 comment via `gh issue view 99` | the claim and its downgraded impact | primary |
| `packages/subagent/src/agent-panel.ts:1427-1428` | the only other hand-roller, correct | primary |

Experiment hygiene: all probe files (`meta/src/zz-*.tmp.test.ts`) were deleted; `overlay.ts` was
restored from a pre-mutation copy and verified byte-identical to `HEAD`.

## Unresolved Contradictions

None between sources. One between the card and the code: the triage verdict *likely stale (silence,
not a fix)* is right about the mechanism but invites the wrong conclusion — nothing was fixed, the
file is merely untouched. Read as *unowned*, not *resolved*.

## Gaps

- No real-terminal capture. All measurement runs through the component's own `render()` and pi-tui's
  `visibleWidth` — what the terminal draws — but it is not a screenshot.
- Whether the collision should ship in the same change as the width fix is a scope call (taken at the
  Phase 4 stop: same change).
- The mutation finding raises a wider question this report did not chase: how many of the suite's
  frame-width audits are similarly true-by-construction? `packages/subagent/src/agent-panel.width-audit.test.ts`
  follows the same shape and was not mutation-tested. Out of scope here; worth its own card.
