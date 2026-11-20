---
status: current
last-verified: 2026-11-20
verified-by: local reproduction against pi 1.4.0 and pi 1.6.0 (tsc + vitest), gh run logs for all 45 scheduled/dispatch runs, published pi tarballs; 2026-11-20
task: tsk_8dc91a11-06ce-4530-b846-c76aefda7c60
---

# Research Report: why the `pi-latest` CI job keeps failing

**Settled question:** why does the `pi-latest` job in `.github/workflows/ci.yml` fail, and is it a
broken job or a real signal? Answered with the full breakage map, not just the first error CI shows.

## Executive Summary

**The job is not broken. It is working as designed.** `pi-latest` exists because peer ranges never
reach a user (`pi install` omits peers, the loader aliases host packages — ADR 0026) and pi ships
breaking changes without a major version, so a floating type-check is the only drift detector
available. Every production failure is a **true positive**: pi changed its published type surface
under us.

45 scheduled/dispatch runs since the job was added (`2ff6fcc`, 2026-10-13, PR #96): **40 green, 5
red**. Four reds are genuine upstream drift. The fifth (`38391509461`, 2026-10-13) was the job's own
bootstrap bug in the PR that introduced it — fixed 8 minutes later, never recurred across 38
scheduled runs. The `typecheck` floor job went **45/45 green** across the same runs, so the two-job
discrimination AGENTS.md describes is real and load-bearing.

**Current failure** — run `44764034147`, 2026-11-20 15:30 UTC: pi-tui **1.6.0** changed
`Component.render(width: number): string[]` to `: readonly string[]`. pi published the 1.6.0 train at
11:04 UTC that morning — **4.4 h detection latency**.

**One genuine design flaw, and it is why this looked confusing:** `pnpm -r exec` bails on the first
failing package. CI reported `packages/diff` and stopped. Reproduced locally, **three packages fail,
not one** — `meta` and `packages/todo` were never reached.

## Findings

### 1. The failure history — 4 true drifts, 1 infra, 0 flakes

| Run | Date (UTC) | Event | Package | Upstream cause | Verdict |
|---|---|---|---|---|---|
| `38391509461` | 2026-10-13 11:37 | dispatch | — | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | **infra** — pre-fix step shape, same PR replaced it |
| `41477410604` | 2026-11-02 16:01 | schedule | `packages/todo` | pi-ai 1.5.0 dropped `Type`/`Static` re-exports | **true drift** (5 h latency) |
| `41652924329` | 2026-11-03 14:21 | schedule | `packages/todo` | as above | **true drift** (fix not yet on main) |
| `41849542708` | 2026-11-04 14:38 | schedule | `packages/todo` | as above | **true drift** (fix merged 14:45, dispatch `41850981107` green 14:46) |
| `44764034147` | 2026-11-20 15:30 | schedule | `packages/diff` | pi-tui 1.6.0 `readonly string[]` | **true drift** (4.4 h latency) |

No network, cache, registry, or action-deprecation failure has ever occurred in this job. All 45 runs
are `run_attempt=1` — nobody has re-run one. The `Node.js 20 is deprecated` warning appears in every
log; it is cosmetic and belongs to the floor job's problem space too.

Repo-level noise **not** attributable to `pi-latest`: 14 of the repo's historical red runs have zero
jobs (`total_count: 0`, "This run likely failed because of a workflow file issue"), all fork PRs, on
`ci.yml` content byte-identical to green runs. That is GitHub's fork-PR approval path. `pi-latest` is
gated off PRs and never touched by them.

### 2. What pi 1.6.0 changed — and why the errors look arbitrary

The `Component` interface went readonly, and **only 10 of pi-tui's ~20 built-in components followed**:

| flipped to `readonly string[]` in 1.6.0 | still `string[]` in 1.6.0 |
|---|---|
| `Component`, `Container`, `TuiAltScreen`, `Box`, `Text`, `Markdown`, `SettingsList`, `ScrollView`, `MouseRegion`, `Image` | `Editor`, `Input`, `SelectList`, `TruncatedText`, `Spacer`, `HStack`, `VStack`, `Loader`, `alt-screen-search`, `alt-screen-flash` |

Verified by diffing the published declarations:

```diff
-    render(width: number): string[];
+    /** Lines to draw. Components may return a cached array: callers must not modify it. */
+    render(width: number): readonly string[];
```

Our code breaks only where it consumes **those ten** components' output, which is why the failing line
numbers look arbitrary. Upstream documents the migration in `packages/coding-agent/docs/tui.md`:
*"Treat lines returned by `render()` as read-only, including `super.render()` in a subclass… Copy
first, for example `const lines = [...super.render(width)]`."*

### 3. The true breakage map — 3 packages, 7 errors (all reproduced, none predicted)

| file:line | error | cause | shown in CI? |
|---|---|---|---|
| `packages/diff/src/diff-component.ts:114` | TS4104 readonly→mutable | `this._cachedLines = lines` from `Box.render()` | yes |
| `packages/diff/src/diff-component.ts:115` | TS4104 | `return lines` from `render(): string[]` | yes |
| `packages/diff/src/diff-component.ts:121` | TS4104 | `return this.shell.render(width)` | yes |
| `packages/diff/src/diff-component.ts:150` | TS4104 | `return this.shell.render(width)` | yes |
| `meta/src/settings-manager.ts:526` | TS4104 | `return body` where `body = list.render()`, `list: SettingsList` | **no** |
| `meta/src/settings-manager.ts:528` | TS4104 | second `return body` | **no** |
| `packages/todo/src/tool.test.ts:36` | TS2352 bad cast | casts a `Text` to `{ render(width): string[] }` | **no** |

Note the precision of the mechanism in `diff-component.ts`: line 112 (`const lines = …`) infers for
free and does **not** error, and line 106 (`return this._cachedLines`) errors neither — which is
exactly why CI listed 4 errors and not 6.

**Everything else is genuinely clean, and this is worth recording so nobody re-litigates it:**

- **None of our 13 `Component` implementers break.** Return types are covariant: `string[]` remains
  assignable to `readonly string[]`, so `render(width): string[]` still satisfies the widened
  interface and still validly overrides `Text`/`Editor`.
- **No code anywhere mutates a host `render()` result.** Exhaustive check of all 13 host `.render()`
  call sites in non-test source: the only consumers are indexing, `.length`, `.slice()`, and `for…of`,
  all of which `ReadonlyArray` permits. Every `push` in the render paths targets a locally constructed
  `string[]`.
- `packages/ui/src/editor/index.ts:268` (`super.render()`) is doubly safe — `Editor` was **not**
  widened, and `.slice()` on a `ReadonlyArray` returns a mutable `string[]` anyway.
- `packages/ask/src/dialog.ts:375` and `picker.ts:164` consume the widened `Markdown` but only iterate.
- The local duck-types (`agent-panel.ts:65`, `agent-manager.ts:34`, `settings-manager.ts:174`) are fed
  only our own components, so they neither error today nor block the fix.

### 4. A verified fix — and why the type-honest variant cannot land yet

Both variants were applied in throwaway worktrees and run to completion.

| | **A — copy at the host call site** | **B — widen our types to `readonly`** |
|---|---|---|
| Edit | `[...this.shell.render(width)]` ×3 in `diff-component.ts`; `[...list.render(contentWidth)]` at `settings-manager.ts:523`; test cast → `readonly string[]` | `DiffComponent.render(): readonly string[]`, `_cachedLines: readonly string[] \| undefined`, `listBody(): readonly string[]`, test cast |
| tsc vs pi **1.6.0** | ✅ 0 errors | ✅ 0 errors |
| tsc vs pinned **1.4.0** | ✅ 0 errors | ❌ **`TS2416`** at `diff-component.ts:103` + 2× **`TS2345`** at `diff/src/tools/edit.ts:133,146` |
| `pnpm test` | ✅ 157 files / 2595 tests | ✅ 157 files / 2595 tests |

**Variant B is the type-honest end state but is unschedulable while `devDependencies` pin 1.4.0** — a
`readonly` return is not assignable to the 1.4.0 `Component`, so it breaks the floor job and the
`ui.custom`/`edit.ts` consumers. It becomes viable only when the pin moves to ≥1.6.0. **Variant A is
what upstream prescribes and is green on both**, at the cost of one array allocation per width change.

One behavioural note for whoever decides: `DiffComponent` returns the same `_cachedLines` array object
on cache hits (`:106`). pi 1.6.0's new `renderLayoutFrame(…, reusableOutput?: LayoutRenderCache)` and
`renderChildLines` explicitly rely on that array identity to skip ancestor copies. Copying at the
call site preserves identity across cache hits (it allocates once per width change), which is what the
new host optimisation wants.

### 5. Job weaknesses (measured on the repo's pinned pnpm 12.5.1)

1. **Fail-fast under-reports.** With the Nov 20 tree broken in 3 packages:

   | invocation | packages that reported |
   |---|---|
   | `pnpm -r exec` (what CI runs today) | **1** — `diff`, then abort |
   | `pnpm -r --no-bail exec` | **2** — `meta` **skipped** as a dependent of the failure |
   | `pnpm -r --no-bail --no-sort exec` | **3** — all failures surfaced |

   `--no-bail` is documented on [pnpm.io/cli/recursive](https://pnpm.io/cli/recursive) (default `bail`
   is `true`) but is **absent from `pnpm help recursive` on 12.5.1** even though the binary honours it.
   `--report-summary` works on `-r exec` and emits `pnpm-exec-summary.json` shaped
   `{ executionStatus: { "<absolute package path>": { status, duration }, … } }` — an object keyed by
   package path, not an array (verified: 13 entries, 3 `failure`). A complement to `--no-bail` for a
   machine-readable failure matrix. Caveat before adopting: with `--no-bail`, pnpm skips tasks that
   depend on a failed one, which is documented behaviour; `--no-sort` defeated it here, but relying on
   that to override a documented skip is version-fragile. The file also lands in the working tree and
   is not gitignored, so adopting it means either gitignoring it or writing it elsewhere.
2. **A typo'd or renamed specifier exits 0.** `pnpm update -r "@earendil-works/pi-tuiii@latest"` →
   exit 0, `Already up to date`. If pi renames a package, this job tests nothing and stays green
   forever.
3. **No record of what was tested.** No `pnpm ls`/`pnpm why` step. On days when latest equals the pin,
   the update step prints nothing at all (run `41201998918`, 2026-10-31 — no `Downloading` line), so a
   green checkmark does not prove the tree was ever floated.
4. **Cron queue delay eats the window `minimum-release-age 0` buys.** Scheduled `17 6 * * *`; observed
   starts span **10:49–16:27 UTC**, never near 06:17 — GitHub delays the run 4.5–10 h, once per day.
   Consequence: pi 1.5.1 (Nov 9, 23:45 UTC) was never tested at all — the Nov 9 run predates it and
   1.5.2 superseded it 13 h later. A break published after the daily run is invisible for 24 h+.
5. **Types only.** `pnpm test` runs on the floor job only (`ci.yml:46`), so runtime drift — behaviour
   changes, exports degrading to `any`, methods going optional — is invisible. The 1.5.0 break was
   caught only because it was a *type* import.
6. **A structural coverage hole.** `packages/core/src/bridge/self-usage.ts:5-6` keeps a hand-written
   structural mirror of the pi-ai `Usage` type ("core does not depend on @earendil-works/pi-ai — keep
   the dependency surface unchanged"). An upstream type no package imports cannot drift-fail this job.
7. **`-r exec` excludes the workspace root** ([docs](https://pnpm.io/cli/recursive)), so root's
   `typescript: ^7.0.2` is never used — every package type-checks with its own `^6.0.0` (6.0.3). Both
   jobs silently skip root-level source and the two TS majors never meet.
8. **Redundant step, minor.** `pnpm install` before `pnpm update -r` is wasted work (`pnpm update`
   installs), and the non-frozen install resolves nothing today (`Lockfile is up to date`). The
   residual risk — a `package.json` bump committed without its lockfile — is caught a step earlier by
   the floor's `--frozen-lockfile` on the same commit.
9. **No triage affordance.** No `timeout-minutes`, no issue creation, no notification. The only signal
   is a red row in the Actions UI, which is how the 1.5.0 break came to be reported three times over
   47 hours before a human looked.

**One strength worth stating:** `pnpm update -r` on the three specifiers moves the whole train, because
`pi-coding-agent` pins its siblings exactly — the Nov 20 update changed **16 packages from 3
specifiers**, so there is no version-skew hole among the seven `@earendil-works/*` packages. It does
*not* touch `peerDependencies` and does *not* add a package a workspace member doesn't declare, but
per AGENTS.md those ranges are never installed or parsed anyway, so that is cosmetic.

### 6. Upstream offers nothing that reaches `tsc`

- pi **does** ship a shim reconstructing the deleted TypeBox symbols
  (`packages/coding-agent/dist/core/extensions/pi-ai-extension-view.d.ts` re-exports `Type`, `Static`,
  `TSchema`, `StringEnum`), but it is wired **purely through pi's jiti loader alias map** — not in the
  root barrel, not in `package.json` `exports` (only `"."` and `"./rpc-entry"`). It helps extensions at
  runtime and does nothing for a type-check. `@earendil-works/pi-ai/compat` is explicitly
  self-described as temporary and does **not** re-export those symbols either.
- **No `readonly`-tolerant helper alias exists.** The only exported `readonly string[]` type in pi-tui
  1.6.0 is `LayoutRenderCache = Map<Component, Map<number, readonly string[]>>`, a frame cache.
- **The versioning policy is real but unpublished where a dependent reads it.** pi's `AGENTS.md` states
  *"patch = fixes + additions, minor = breaking changes. No major releases"* and *"Do not preserve
  backward compatibility unless the user asks for it."* Neither string appears in any published package
  README, and there is no `docs/versioning.md`.
- **Deprecation convention exists but pi-tui has never used it** (0 `@deprecated` markers across
  1.4.0→1.6.0). `Component.render` shipped with no deprecated bridge.
- pi 1.5.0 → 1.5.2 are otherwise type-clean for us; the only other removals in the range
  (`truncateMiddle`, `detectLineEnding`, `resolveModelScope`, `restoreModelFromSession`,
  `warnDeprecation`, `mapStopReasonString`) have **zero references** in this repo — verified by
  extracting all 75 distinct names we import and checking each against the reachable export set of all
  five versions.

## Evidence

| Source | Credibility | What it establishes |
|---|---|---|
| `gh run view <id> --log-failed` for all 5 red runs; `gh api …/workflows/ci.yml/runs --paginate` (717 runs) | official | the failure history, latency, floor-vs-drift discrimination |
| Published tarballs `@earendil-works/pi-{tui,coding-agent,ai}@{1.4.0,1.5.0,1.5.1,1.5.2,1.6.0}`, `.d.ts` diffed | official | the exact type-surface deltas, the 10/20 split |
| Local reproduction: worktrees at `HEAD` (7db7ede), floated to 1.6.0 and pinned at 1.4.0, `tsc --noEmit` + `vitest run` on all 13 packages | direct, executed | the 7-error breakage map; both fix variants green on 1.6.0; variant B **red** on 1.4.0 |
| `github.com/earendil-works/pi` releases + `packages/coding-agent/docs/tui.md` | official (repo is public) | the prescribed migration, the release notes announcing the break |
| [pnpm.io/cli/recursive](https://pnpm.io/cli/recursive), [pnpm.io/cli/update](https://pnpm.io/cli/update) | official | `--no-bail` semantics + dependent-skip, root exclusion, update specifier handling |
| Local pnpm 12.5.1 experiments (bail matrix, `--report-summary`, isolated update workspace, typo'd specifier) | direct, executed | the under-reporting matrix, exit-0-on-typo |

**Inference, flagged:** the only non-executed claim is the long-run outlook on further `readonly`
propagation (§Gaps) — everything above was read in a source or run in a shell.

## Unresolved Contradictions

None material. One discrepancy worth noting: the repo's own `AGENTS.md` says the workspace pins
`typescript` at root `^7.0.2`, and that is true of `package.json`, but `-r exec` excludes the root, so
in practice **every** type-check in both CI jobs runs TypeScript 6.0.3. The documentation and the
mechanism disagree about which compiler is in play.

## Gaps

1. **Runtime behaviour under pi 1.6.0 is unverified.** tsc is clean and 2595 unit tests pass on both
   versions, but neither is a smoke test of the suite running *inside* pi 1.6.0. The `readonly` change
   is a licence to cache, and `DiffComponent` already returns a cached array identity — the new host
   render cache is designed to exploit exactly that. Type-green ≠ behaviour-verified.
2. **`Editor` / `Input` / `SelectList` are widened-adjacent** — mutable in 1.6.0 by apparent oversight,
   since the `Component` doc comment already forbids mutating cached output. Every affected site was
   checked and none would newly break if a later release finishes the job, but whether pi will extend
   the split is unknowable from available sources.
3. **pi-tui and pi-ai ship no CHANGELOG** in their tarballs (pi-coding-agent does), so their per-package
   deltas are reconstructible only from monorepo-wide release notes plus tarball diffing. For 1.5.1 and
   1.5.2 the tarball diff is the *only* record.
4. **Wildcard `minimumReleaseAgeExclude` is unconfirmed.** The workflow's comment argues a floating
   version cannot be exempted through it because it pins exact versions; that matches the docs, but
   whether it accepts a pattern like `@earendil-works/*` could not be confirmed — the settings pages
   404'd and `pnpm config set` stored the array as a quoted string. The job's current
   `minimum-release-age 0` disables the age policy for **all ~405 dependencies**, not just pi.
