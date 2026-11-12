---
status: committed
done-when: "`grep -rn '^let \\|^var ' packages/diff/src --include=*.ts | grep -v .test.ts` no longer lists any config or theme holder (only `_TextComponent` and `_shikiReady`, both honest process state); `packages/core/src/session-state-discipline.test.ts` follows one cross-module import hop and its allow-list names `packages/diff` in no entry; a second `registerDiffTools` call with a different reader can no longer change what the first session's diff renders; `npx vitest run` and `pnpm -r exec -- tsc --noEmit` are green."
task: tsk_7a7b2b7d-da43-4b56-b2c9-fccae1af0816
issue: https://github.com/archimedes-codes/pi-archimedes/issues/163
---

# diff: no module-scope config or theme state (#156 shape-parity)

## Spec

**Problem:** `registerDiffTools` repoints four module-scope bindings on every call — `index.ts:44` `_readConfig`, `shiki.ts:13` `_getConfig`, `render/shared.ts:41` `_getConfig`, `ansi/codes.ts:60` `_lastThemeKey`. Pi caches the extension module per process, so two in-process sessions share one slot: a second registration with a different reader silently changes the first session's Shiki theme and split thresholds, flipping its view between split and unified. Only the first of the four is visible to the suite guard; the other three sit behind the guard's documented cross-module blind spot.

**Solution:** thread config explicitly instead of holding it. `registerDiffTools` passes its `readConfig` reader into the two tool installers; each renderer invocation calls the reader once and hands the resulting value to pure leaf functions (`hlBlock`, `shouldUseSplit`, `renderSplitLines`, `renderUnifiedLines`, `DiffComponent`). The two `setConfigGetter` injection points, both module `let _getConfig` holders, `_readConfig`, and the dead `_lastThemeKey`/`resetDiffColors` pair are deleted. The suite guard gains a Tier-1 cross-module hop (named imports, `as` aliases, barrel re-exports) so this shape cannot return behind a module boundary.

**Out of scope:**
- **Namespace imports and dynamic imports stay unfollowed by the guard.** Making the hop follow `import * as ns` (so `events.onSessionStart(ctx)` is seen) would newly flag five honest one-socket-per-process bindings in `core/src/bridge/`, and the guard has no exemption category for "process-wide by design". Deferred with its own decision, not smuggled in here.
- **`ui/src/startup/index.ts`'s `frameTimer`/`revealTimer` are not fixed here** — they become newly visible to the extended guard and get an allow-list entry pointing at card `tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2`, which exists for that purpose.
- **`_getTheme` (`index.ts:127`) stays an unused parameter.** pi hands every renderer the live theme per call (`edit.ts:84`, `:157`; `write.ts:74`, `:114`), so the registration getter is redundant — but `meta/src/session-isolation.test.ts:260-277` reads `mock.calls[…][1]` positionally as the theme getter, and that is the #156 regression pin for diff. Removing the parameter would delete a working pin for no behavioral gain.
- **`readEffectiveSettings` is not adopted.** `loadDiffConfig` (`meta/src/config.ts:59-61`) reads the file, not `pi.getSettings()`, so project-scoped `<cwd>/.pi/settings.json` is invisible to diff config. Real, independent of this work, and a separate decision.
- **No new memo on `resolveDiffColors`.** `themeCacheKey` (`codes.ts:92-107`) never samples `getFgAnsi`, so a key-gated cache can serve one theme's diff colors to another; the dead state is deleted, not repaired into a cache.
- **`renderSplit`/`renderUnified` (zero call sites) are kept**, not deleted — removing exported compat wrappers is a judgement call this card did not make.

**Decisions:**
- **Thread a reader, not a snapshot.** `createEditRenderers`/`createWriteRenderers` receive `() => DiffConfig` and call it per renderer invocation, so an edit to `archimedes.diff` still applies to the next new diff row. Measured cost: 3 `readFileSync` per new component ≈ 37–42 µs against a ~75 ms Shiki highlight (1:2000) and 0 per repaint. A snapshot would freeze config until `/reload` for no measurable gain.
- **Leaves take values, not readers.** `hlBlock(code, language, theme)` and `shouldUseSplit(diff, tw, cfg, maxRows?)` stay pure — trivially testable, and it keeps `shiki.ts` from importing `index.ts`, which would be a cycle (`index.ts` imports `shiki.js`).
- **One declaration for the config shape.** The canonical interface moves to `render/shared.ts` (extended with `diffTheme`) and `index.ts` re-declares `DiffConfig` as an alias, so the public type name `DiffConfig` (imported by `meta/src/config.ts:46,48`) is unchanged and no leaf imports upward.
- **`registerDiffTools`'s parameter order and arity are frozen** — see the `Out of scope` note on `_getTheme`.
- **One accepted semantic delta.** Today, a second `registerDiffTools` call on the *same* `pi` handle refreshes the module reader, so the already-installed renderers pick up the newer reader. After this change that call early-returns and the installed renderers keep the reader from the first call. Both readers are `() => loadDiffConfig()` in the composed suite and `() => DEFAULT_DIFF_CONFIG` standalone, so the values are identical and nothing observable changes; the WeakSet install guard (`index.ts:122`) is unchanged.
- **`_lastThemeKey` is deleted, not threaded.** It is write-only — the `if` at `codes.ts:136` has no body but the assignment, nothing else reads the variable, and deleting the mechanism leaves 218/218 diff tests and 4/4 guard tests green. `codes.test.ts:253-284` ("clears cache so subsequent call re-derives") already passes with the reset body emptied.

**Evidence:** `docs/research/diff-module-scope-config-holders.md` (card `tsk_7a7b2b7d-da43-4b56-b2c9-fccae1af0816`, mirrored to issue #163). Load-bearing findings: the four-binding census (§1); the reproduced cross-session flip — `{"diffTheme":"github-light","diffSplitMinWidth":100,"split":true}` becomes `{"diffTheme":"dracula","diffSplitMinWidth":400,"split":false}` for the same session after a second registration (§2); `_lastThemeKey`'s write-only status and the mutation run proving it (§3); the read-cost measurements and the fact that live-apply today reaches only new rows (§4); the guard blast radius — 5 new hits at Tier 1, 10 at Tier 2, and the dynamic-import wall at `meta/src/index.ts:162` (§5); the ~92-line/13-signature change surface and the two constraints on it (§6). Rule text: `docs/features/session-state.md`. Host contract: `@earendil-works/pi-coding-agent@1.4.0` `dist/core/extensions/types.d.ts:347-377,516-526` — no renderer parameter can carry a per-session config reader, which is why the reader is captured in the registration closure.

## Plan

**Goal:** remove every module-scope config/theme holder from `packages/diff`, thread config explicitly with live-apply preserved, and teach the suite guard to follow one module boundary.
**Architecture:** config flows one way — `meta`/standalone hands a reader to `registerDiffTools`, which hands it to the two tool installers; each renderer call resolves it to a value and passes that value down to pure leaf renderers and to `DiffComponent`. No module in the package holds a session's config between calls. The guard gains an import-resolution step so a handler reaching an assignment through `import { setConfigGetter } from "./shiki.js"` is caught.
**Tech Stack:** TypeScript (`.ts` entry points, no build step, pi's jiti loader), vitest, `tsc --noEmit` as the per-package verification bar, pnpm workspace.

---

## Parallelisation

**Verdict:** SERIAL — every task touches a file another task touches. Task 1 and Task 2 both modify `packages/diff/src/index.ts`; Task 2 and Task 3 both modify `packages/core/src/session-state-discipline.test.ts`; Task 4 rewrites the census and blind-spot text that Task 3 changes. A wave was considered for Task 3 (guard extension) against Task 1 (dead-state removal) — disjoint file sets — but rejected on gate 4: the extended guard's acceptance criterion is "green against the tree once diff is clean", which is not provable in a checkout holding only the guard's work, and both branches would edit the same allow-list array at fan-in.

---

### Task 1: Delete the dead `_lastThemeKey` / `resetDiffColors` pair

**Parallel:** none — shares `packages/diff/src/index.ts` with Task 2.

**Context:** `registerDiffTools` calls `resetDiffColors()` at `packages/diff/src/index.ts:141` to "reset theme-derived colors so they are re-derived from the current theme". That reset clears `let _lastThemeKey` (`packages/diff/src/ansi/codes.ts:60`), and nothing anywhere reads that variable for a decision: the only references are the declaration (`:60`), the clear (`:89`), and the comparison at `:136` whose body is the assignment at `:137` — no `else`, no return. `resolveDiffColors(theme)` derives its colors from the `theme` **argument** on every call, so colors are already re-derived unconditionally. This is a module-scope binding that a lifecycle path reaches (`meta/src/index.ts:191` → `registerDiffTools` → `resetDiffColors`), which is exactly the shape the rule bans, and it is also dead. Removing it first shrinks Task 2 and leaves the tree green on its own. History: at `0861819` this branch mutated nine module-scope `export let BG_*` globals; `160c6d4` deleted the aliases and orphaned the key.

**Files:**
- Modify: `packages/diff/src/ansi/codes.ts`
- Modify: `packages/diff/src/ansi/index.ts`
- Modify: `packages/diff/src/ansi/codes.test.ts`
- Modify: `packages/diff/src/index.ts`

**What to implement:**
- In `packages/diff/src/ansi/codes.ts`: delete `let _lastThemeKey: string | undefined;` and its two comment lines above it (`:59-60`), delete the whole `export function resetDiffColors(): void { _lastThemeKey = undefined; }` (`:87-90`, including its `/** Reset auto-derived colors — call when theme changes. */` doc comment), and inside `resolveDiffColors` delete `const themeKey = themeCacheKey(theme);`, the comment `// Re-derive theme key cache (bg colors are now passed explicitly via DiffBg)`, and the `if (themeKey !== _lastThemeKey) { _lastThemeKey = themeKey; }` block (`:133-138`). `resolveDiffColors`'s signature stays `resolveDiffColors(theme?: any): DiffColors` and its remaining body is unchanged: the `if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;` guard, then the per-token `themeFgAnsi(...) ?? FG_*` object.
- **Do not** touch `themeCacheKey` (`codes.ts:92-107`) — it is used by `diff-component.ts:81`, `tools/edit.ts:113`, `tools/write.ts:88`, `tools/write.ts:137` and has its own tests.
- In `packages/diff/src/ansi/index.ts`: drop `resetDiffColors` from the re-export list at `:10` (the line becomes `themeCacheKey, resolveDiffColors,`).
- In `packages/diff/src/index.ts`: delete the `resetDiffColors();` call at `:141` and its two-line comment above it (`:140` "Reset theme-derived colors…" / the comment continues to `:140`), and remove `resetDiffColors` from the import at `:14` (`import { resetDiffColors } from "./ansi/index.js";` — delete the whole line; nothing else is imported there).
- In `packages/diff/src/ansi/codes.test.ts`: delete the `describe("resetDiffColors", …)` block (`:253-285`) and its `it`, drop `resetDiffColors` from the test's import list (`:22`), and delete the six now-dangling `resetDiffColors();` preamble calls at `:188`, `:194`, `:200`, `:221`, `:229`, `:245`. Leave every assertion in those `it` blocks exactly as it is — they must still pass, because `resolveDiffColors` derives from its argument.

**Steps:**
- [ ] First prove the state is dead: run `grep -rn "_lastThemeKey" packages --include=*.ts` and confirm the only hits are `codes.ts:60`, `:89`, `:136`, `:137`. If any other file reads it, STOP and report — the deletion premise is false.
- [ ] Delete the test block and the six preamble calls in `packages/diff/src/ansi/codes.test.ts`, then run `npx vitest run packages/diff/src/ansi/codes.test.ts` from the repo root.
  - Expected: still green (fewer tests). If any assertion now fails, STOP and investigate — it means the reset was load-bearing, contradicting the research.
- [ ] Apply the deletions in `codes.ts`, `ansi/index.ts`, `index.ts`.
- [ ] Run `npx vitest run packages/diff` from the repo root.
  - Expected: all pass, 0 failures. (Baseline before this task: 15 files, 218 tests.)
- [ ] Run `npx vitest run packages/core/src/session-state-discipline.test.ts`.
  - Expected: 4 passed — diff's allow-list entry is still needed for `_readConfig`, so nothing changes here yet.
- [ ] Run `npx tsc --noEmit` in `/home/daniel/Coding/Archimedes/pi-archimedes/packages/diff`.
  - Expected: no errors. An error mentioning `resetDiffColors` means an import or barrel entry was missed.
- [ ] Commit with message: `fix(diff): drop the write-only _lastThemeKey memo and resetDiffColors`

**Acceptance criteria:**
- [ ] `grep -rn "_lastThemeKey\|resetDiffColors" packages meta --include=*.ts` returns nothing.
- [ ] `npx vitest run packages/diff` is green.
- [ ] `npx tsc --noEmit` in `packages/diff` is clean.
- [ ] `resolveDiffColors` and `themeCacheKey` keep their exact current signatures.

---

### Task 2: Thread config through the render layer and delete all three config holders

**Parallel:** none — shares `packages/diff/src/index.ts` with Task 1 and `packages/core/src/session-state-discipline.test.ts` with Task 3.

**Context:** this is the actual fix. `shiki.ts:13` and `render/shared.ts:41` each hold one process-wide `let _getConfig`, repointed by `setConfigGetter` from `registerDiffTools` (`index.ts:144-145`). Two in-process sessions therefore share one config slot: reproducing it takes two `registerDiffTools` calls with different readers, after which the first session renders with the second session's `diffTheme` and split thresholds — measured flipping a 200-column render from split to unified. `index.ts:44` `_readConfig` is the same shape and is the binding the guard's allow-list currently excuses. The fix threads the value: `registerDiffTools` hands its `readConfig` reader to `installEditTool`/`installWriteTool`; each `renderCall`/`renderResult` resolves it once and passes the value into `DiffComponent` and `hlBlock`; `renderSplitLines`/`renderUnifiedLines` take it and pass it to `shouldUseSplit`. Live-apply is preserved because the reader is called per renderer invocation, matching today's behavior exactly (3 reads per new component, 0 per repaint). The signature sweep cannot be split across commits without leaving the package uncompilable, so it lands as one change.

**Files:**
- Modify: `packages/diff/src/render/shared.ts`
- Modify: `packages/diff/src/render/index.ts`
- Modify: `packages/diff/src/render/split.ts`
- Modify: `packages/diff/src/render/unified.ts`
- Modify: `packages/diff/src/shiki.ts`
- Modify: `packages/diff/src/diff-component.ts`
- Modify: `packages/diff/src/tools/edit.ts`
- Modify: `packages/diff/src/tools/write.ts`
- Modify: `packages/diff/src/index.ts`
- Test: `packages/diff/src/shiki.test.ts`
- Test: `packages/diff/src/render/shared.test.ts`
- Test: `packages/diff/src/tools/edit.test.ts`
- Test: `packages/diff/src/tools/write.test.ts`
- Test: `packages/diff/src/tools/register.test.ts`
- Test: `packages/diff/src/leak.test.ts` (new)
- Modify: `packages/core/src/session-state-discipline.test.ts`

**What to implement:**

1. **`packages/diff/src/render/shared.ts` — the config type moves here, the holder goes.**
   - Extend the existing `DiffRenderConfig` interface (`:26-30`) with a `diffTheme: string;` field as its **first** member, so it carries everything the render layer needs:
     ```ts
     export interface DiffRenderConfig {
     	diffTheme: string;
     	diffSplitMinWidth: number;
     	diffSplitMinCodeWidth: number;
     	diffSplitWrapCheck?: boolean;
     }
     ```
   - Delete `export function getConfig()` (`:32-34`), `const DEFAULT_CONFIG` (`:36-40`), `let _getConfig: (() => DiffRenderConfig) | undefined;` (`:41`) and `export function setConfigGetter(...)` (`:42-44`).
   - Change `shouldUseSplit` to take the config as a required 3rd parameter, before the optional `maxRows`:
     ```ts
     export function shouldUseSplit(diff: ParsedDiff, tw: number, cfg: DiffRenderConfig, maxRows = MAX_PREVIEW_LINES): boolean {
     	if (!diff.lines.length) return false;
     	if (tw < cfg.diffSplitMinWidth) return false;
     	…   // rest of the body unchanged, still reading cfg.diffSplitMinCodeWidth / cfg.diffSplitWrapCheck
     ```
     Delete the `const cfg = getConfig();` line. Everything after is byte-identical.
   - `wrapAnsi`, `adaptiveWrapRows`, and every exported constant are untouched.

2. **`packages/diff/src/render/index.ts`** — drop `getConfig` and `setConfigGetter` from the `./shared.js` re-export list (`:10-11`) and add `type DiffRenderConfig` to the same list so `index.ts` can alias it.

3. **`packages/diff/src/shiki.ts` — no upward import, no holder.**
   - Delete `let _getConfig: () => { diffTheme: string } = () => ({ diffTheme: "github-dark" });` (`:13`) and `export function setConfigGetter(...)` (`:14-16`).
   - `ensureShiki` takes the theme name: `async function ensureShiki(theme: string): Promise<void>`, and its `codeToANSI("", "typescript", …)` call uses that parameter instead of `_getConfig().diffTheme`. Keep `let _shikiReady = false` and the guard — it is an honest process-wide warm-up flag, not session state.
   - `hlBlock` takes the theme name as a required 3rd parameter:
     ```ts
     export async function hlBlock(code: string, language: BundledLanguage | undefined, theme: string): Promise<string[]> {
     	if (!code) return [""];
     	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
     	await ensureShiki(theme);
     	const k = `${theme}\0${language}\0${code}`;
     	…   // unchanged: LRU lookup, then codeToANSI(code, language, theme as BundledTheme)
     ```
     Delete the `const theme = _getConfig().diffTheme;` line. `lang(fp)` is unchanged. The LRU key format is unchanged (`shiki.ts:73`) — do not alter `_cache`/`_touch`.
   - Do **not** import `DiffRenderConfig` here; `shiki.ts` must stay free of any import from `index.js` or `render/` (that would be a cycle — `index.ts` imports `shiki.js`).

4. **`packages/diff/src/render/split.ts` and `unified.ts` — pass it through.**
   - `renderSplitLines(diff, language, width, cfg, max = MAX_PREVIEW_LINES, dc = DEFAULT_DIFF_COLORS, dbg = DEFAULT_DIFF_BG)` — `cfg: DiffRenderConfig` inserted after `width` (required parameters must precede the defaulted ones). Its `shouldUseSplit(diff, width, max)` call at `:52` becomes `shouldUseSplit(diff, width, cfg, max)`; its `renderUnifiedLines(diff, language, width, max, dc, dbg)` fallback gains `cfg` in the same position; the two `hlBlock(...)` calls at `:83` gain `cfg.diffTheme` as the 3rd argument.
   - `renderUnifiedLines(diff, language, width, cfg, max = MAX_RENDER_LINES, dc = DEFAULT_DIFF_COLORS, dbg = DEFAULT_DIFF_BG)`; its `hlBlock` pair at `:64` gains `cfg.diffTheme`.
   - The two zero-call-site compat wrappers keep existing but thread the value: `renderSplit(diff, language, cfg, max = MAX_PREVIEW_LINES, dc = DEFAULT_DIFF_COLORS)` and `renderUnified(diff, language, cfg, max = MAX_RENDER_LINES, dc = DEFAULT_DIFF_COLORS)` — `cfg` after `language`, and they forward it. Do not delete them.

5. **`packages/diff/src/diff-component.ts`** — add a required `config` parameter after `theme` and store it:
   ```ts
   constructor(
   	diff: ParsedDiff,
   	language: BundledLanguage | undefined,
   	theme: Theme,
   	config: DiffRenderConfig,
   	maxLines: number = MAX_RENDER_LINES,
   )
   ```
   with `private config: DiffRenderConfig;` beside the existing private fields, assigned in the constructor. Its `renderSplitLines(this.diff, this.language, width, this.maxLines, dc, dbg)` call at `:121` becomes `(this.diff, this.language, width, this.config, this.maxLines, dc, dbg)`. Import the type from `./render/index.js` (it already imports `renderSplitLines, MAX_RENDER_LINES` from there). `_deriveColors`, `_cachedDc`, `_cachedDbg`, `invalidate()` and the `Box` shell are untouched.

6. **`packages/diff/src/tools/edit.ts` and `tools/write.ts` — the reader arrives here.**
   - `export function createEditRenderers(cwd: string, home: string, readConfig: () => DiffRenderConfig): ToolRenderers` and `export function installEditTool(pi: ExtensionAPI, cwd: string, home: string, readConfig: () => DiffRenderConfig): void`.
   - `export function createWriteRenderers(cwd: string, home: string, TextComponent: new (text?: string, paddingX?: number, paddingY?: number) => Component, readConfig: () => DiffRenderConfig): ToolRenderers` and `export function installWriteTool(pi: ExtensionAPI, cwd: string, home: string, TextComponent: …same ctor type…, readConfig: () => DiffRenderConfig): void`.
   - Inside each `renderCall`/`renderResult` body, resolve once at the top: `const cfg = readConfig();` and pass `cfg` to every `new DiffComponent(...)` (`edit.ts:129`, `:142`; `write.ts:128`) and to every `hlBlock(...)` as the 3rd argument (`write.ts:93`, `:143`). Do not call `readConfig()` inside a loop or inside the memo-hit path more than once per invocation.
   - Import the type as `import type { DiffRenderConfig } from "../render/index.js";`.
   - **Do not change** `editResultDetails`, `writeResultDetails`, `readDisplacedContent`, the `themeCacheKey`-based preview keys (`write.ts:88`, `:137`), the `displaced` Map, or the `tool_call`/`tool_result` handlers — those are pi's renderer/event contract, not config plumbing.

7. **`packages/diff/src/index.ts` — the holders go.**
   - Delete `let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;` (`:44`) and `function getConfig(): DiffConfig { return _readConfig(); }` (`:45`).
   - Replace the locally declared `export interface DiffConfig { … }` (`:30-35`) with an alias so the shape has one declaration and the public name survives:
     ```ts
     export type DiffConfig = DiffRenderConfig;
     ```
     (import `type { DiffRenderConfig }` from `./render/index.js`). `DEFAULT_DIFF_CONFIG` (`:37-42`) stays exactly as it is.
   - `getDiffSettingsItems` becomes required-argument: `export function getDiffSettingsItems(config: DiffConfig): SettingItem[]` — delete the `const config = overrideConfig ?? getConfig();` line and the `overrideConfig?` parameter. The four items are unchanged.
   - In `registerDiffTools`, delete the `_readConfig = readConfig;` assignment (`:138`) and the two `setConfigGetter` wiring lines (`:144-145`) plus their comment (`:143` "Wire config getters into submodules"), and remove the `setConfigGetter` imports at `:10-11`. Keep `reportPiSupport("diff", "1.2.0")`, the `_installedExtensions` WeakSet check, the `_TextComponent` check, the `registerToolRenderer`/`pi.on` capability check, and the doc comment above the WeakSet.
   - The two installs become `installEditTool(pi, cwd, home, readConfig);` and `installWriteTool(pi, cwd, home, _TextComponent, readConfig);`.
   - **Keep the signature `registerDiffTools(pi: ExtensionAPI, _getTheme: () => Theme, readConfig: () => DiffConfig): void` byte-identical** — parameter names, order, and the leading underscore on the unused theme getter. `meta/src/index.ts:191` calls it positionally and `meta/src/session-isolation.test.ts:261,276` asserts on `call[1]`.
   - The standalone default export (`:182-185`) is unchanged: `registerDiffTools(pi, () => ctx.ui.theme, () => DEFAULT_DIFF_CONFIG)`.
   - Update the `registerDiffTools` doc comment: the sentence "The theme and config readers are per-session, so those are refreshed on every call" is no longer true of module state — reword to say the readers are handed to the installers and captured by the rows they register, so a second call on an already-installed handle is a no-op.

8. **Tests.**
   - `packages/diff/src/shiki.test.ts`: delete the `describe("setConfigGetter", …)` block (`:234-263`) wholesale — its contract no longer exists — and remove `setConfigGetter` from the import at `:18`. If any test in that block asserted real highlighting behavior (`hlBlock("const x = 1;", "javascript")` at `:246`, `hlBlock("print('hello')", "python")` at `:254`), keep those two as new cases calling `hlBlock(code, lang, "github-dark")`.
   - `packages/diff/src/render/shared.test.ts`: remove `setConfigGetter` and `getConfig` from the import (`:5-6`), delete the `beforeEach` at `:51-57`, and give every `shouldUseSplit(diff, N)` call the config it was previously installing: `:61`, `:88`, `:108` use `{ diffTheme: "github-dark", diffSplitMinWidth: 150, diffSplitMinCodeWidth: 60, diffSplitWrapCheck: true }`; `:68` the same object with `140` unchanged semantics (width 140 < 150 → false); `:81` uses `diffSplitMinWidth: 100, diffSplitMinCodeWidth: 60`; `:96` uses `diffSplitWrapCheck: true` with the long lines; `:100-104`'s block uses `diffSplitWrapCheck: false`. Keep every `toBe(...)` expectation identical.
   - `packages/diff/src/tools/edit.test.ts:33` and `write.test.ts:34`: add the reader as the next positional argument to `installEditTool` / `installWriteTool`; `edit.test.ts:188` becomes `createEditRenderers("/project", "/home", () => DIFF_TEST_CONFIG)`.
   - `packages/diff/src/tools/register.test.ts`: add the reader argument to the 5 `installEditTool(pi, …)` calls (`:72`, `:82`, `:95`, `:120`, `:149`) and the 4 `installWriteTool(pi, …)` calls (`:171`, `:182`, `:213`, `:242`). Define one `const cfg = () => ({ diffTheme: "github-dark", diffSplitMinWidth: 150, diffSplitMinCodeWidth: 60, diffSplitWrapCheck: true });` at the top of the file and pass it.
   - **New** `packages/diff/src/leak.test.ts` — the regression pin this card exists for. Two `registerDiffTools` calls on two fake `pi` handles (copy the `fakePi()` helper shape from `src/register-diff-tools.test.ts:17-34`), first with a reader returning `{ diffTheme: "github-light", diffSplitMinWidth: 100, diffSplitMinCodeWidth: 30, diffSplitWrapCheck: false }`, second with `{ diffTheme: "dracula", diffSplitMinWidth: 400, diffSplitMinCodeWidth: 300, diffSplitWrapCheck: true }`. Assert, using `shouldUseSplit(parseDiff("a\nb\n", "a\nc\n"), 200, firstReader())`, that the first reader's config still yields `true` after the second registration, and that the first reader's call count advances when the first session's config is read again (i.e. the first reader is still reachable and is not shadowed). This test must fail on the pre-change tree and pass after.
   - `packages/core/src/session-state-discipline.test.ts`: delete the whole `AllowEntry` object for `packages/diff/src/index.ts` (`:120-126`) **and** the string `"packages/diff/src/index.ts:44 [module-scope binding assigned by a session handler] let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;"` from the `EXCUSED` expectation in the last `it` (`:663`). Leaving either one makes the hygiene test fail ("allow-list entry no longer matches").

**Steps:**
- [ ] Write `packages/diff/src/leak.test.ts` first, against the current tree, and run `npx vitest run packages/diff/src/leak.test.ts`.
  - Expected: it FAILS (the second registration shadows the first reader). If it passes before any code change, the test is not pinning the bug — fix the test before continuing.
- [ ] Apply changes 1–7 (source), then run `npx tsc --noEmit` in `/home/daniel/Coding/Archimedes/pi-archimedes/packages/diff`.
  - Expected: errors naming the call sites in step 6–7 that still pass the old arity. Fix them; do not add default-valued parameters to hide an arity error.
- [ ] Update the five test files listed in step 8, then run `npx vitest run packages/diff`.
  - Expected: all green, including `leak.test.ts`. If a `shouldUseSplit` expectation flips, the config object was copied wrong — the assertions must be identical to before.
- [ ] Run `npx vitest run packages/core/src/session-state-discipline.test.ts`.
  - Expected: 4 passed with the diff entry deleted. If it reports `packages/diff/src/index.ts:44` as a violation, `_readConfig` is still declared.
- [ ] Run `npx vitest run packages/diff packages/core meta` from the repo root.
  - Expected: green. `meta/src/session-isolation.test.ts` must still pass unchanged — if it fails, `registerDiffTools`'s parameter order moved.
- [ ] Run `npx tsc --noEmit` in `packages/diff`, `packages/core`, and `meta`.
  - Expected: clean in all three. A `meta` error at `settings.ts:61` would mean `getDiffSettingsItems` was made required but `meta` was found not to pass the argument — it does (`allConfig.diff`), so an error there means the alias broke `DiffConfig`'s shape.
- [ ] Run `grep -rn "^\(export \)\?\(let\|var\) " packages/diff/src --include=*.ts | grep -v ".test.ts"`.
  - Expected: exactly two hits — `_TextComponent` (`index.ts`) and `_shikiReady` (`shiki.ts`). Anything else is a holder that survived.
- [ ] Commit with message: `fix(diff): thread config per registration instead of holding it per module (#163)`

**Acceptance criteria:**
- [ ] `packages/diff` declares no `setConfigGetter`, no `getConfig`, and no module-scope `let`/`var` holding config, theme, or theme-key state.
- [ ] Two `registerDiffTools` calls with different readers cannot change what the first session renders (`leak.test.ts` green).
- [ ] `registerDiffTools`'s signature and `DEFAULT_DIFF_CONFIG`'s shape are unchanged; `meta/src/session-isolation.test.ts` passes without edits.
- [ ] `getDiffSettingsItems` requires its config argument and `meta/src/settings.ts:61` still compiles.
- [ ] The guard's allow-list contains no `packages/diff` entry and the guard is green.
- [ ] `npx vitest run` and `pnpm -r exec -- tsc --noEmit` are green.

---

### Task 3: Teach the guard to follow one cross-module import hop

**Parallel:** none — shares `packages/core/src/session-state-discipline.test.ts` with Task 2.

**Context:** the guard's rule is "module-scope `let`/`var` assigned from a session lifecycle path", resolved intra-file. That is how `packages/diff` shipped three lifecycle-reachable bindings the guard read as clean: `setShikiConfig`/`setRenderConfig`/`resetDiffColors` are called from the handler-reachable path but assign in another file. The file's own header calls this "blind spot 1" and names two cross-boundary writes it cannot see. This task closes the boundary for **named imports only** (Tier 1), which is the form `packages/diff` used and the form that costs two allow-list entries. Namespace imports (`import * as events`) stay unfollowed on purpose: the guard's `CALLS` regex `(?<![\w.])([A-Za-z_$][\w$]*)\s*\(` cannot match `events.onSessionStart(ctx)`, and following them would newly flag five honest one-socket-per-process bindings in `core/src/bridge/` with no exemption category to put them in. The header must be corrected to say which hop is now covered and which is not, so the next reader does not assume blind spot 1 is fully closed.

**Files:**
- Modify: `packages/core/src/session-state-discipline.test.ts`
- Test: `packages/core/src/session-state-discipline.test.ts` (fixtures live in the same file, per this repo's convention for the three discipline guards)

**What to implement:**
- Add an import-resolution step to the matcher, used only for the new hop:
  - Parse `import { a, b as c } from "<spec>"` (and the `import type { … }` form, which must be ignored for call matching) into `localName → { symbol, spec }`.
  - Resolve `spec` to a file: `./x.js` → `x.ts`; `./d/index.js` or `./d.js` where `d` is a directory → `d/index.ts`; `@pi-archimedes/<pkg>/<sub>` → `packages/<pkg>/<subpath from that package's package.json "exports">`, falling back to `packages/<pkg>/src/<sub>.ts`; anything else (`@earendil-works/…`, `node:*`, bare npm names) resolves to nothing and is skipped.
  - Follow a barrel: if the resolved file does not declare `export function <symbol>` / `export const <symbol>` / `export let <symbol>`, look for `export { symbol } from "./other.js"` (honoring `as` renames) and recurse, bounded (depth ≤ 4) so a cycle cannot hang the test.
- Extend the reachability walk: after collecting the handler bodies and the intra-file functions they call (the existing two hops, unchanged), for each called name that resolves to an imported function in another file, read that file, walk its own function bodies transitively, and flag any module-scope `let`/`var` in **that** file whose binding is assigned there. Report the hit against the **target** file and the target's declaration line, so the allow-list keeps matching `file + exact trimmed declaration line`.
- Reuse the existing `readFileSync`-based walk and cache file contents in a `Map` — the guard runs over 150 files and this adds one read per distinct import target.
- **Allow-list:** the `packages/diff` entry was deleted by Task 2. Add two entries, one per line, matching the exact trimmed declarations:
  - `{ file: "packages/ui/src/startup/index.ts", line: "let frameTimer: ReturnType<typeof setInterval> | undefined;", reason: "…follow-up: tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2" }`
  - `{ file: "packages/ui/src/startup/index.ts", line: "let revealTimer: ReturnType<typeof setTimeout> | undefined;", reason: "…follow-up: tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2" }`
  Each reason must state, in one or two sentences: cleared by `stopStartupListing()`, reached from `packages/ui/src/index.ts`'s `session_shutdown` one module away, ownership-gated by `weInstalledTheSplash`, worst case a cut-short splash reveal — deferred, not fixed. Both must contain `follow-up: tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2` (the hygiene test matches `/follow-up: tsk_/`).
- Update the `EXCUSED` expectation in the last `it` to exactly those two strings:
  `"packages/ui/src/startup/index.ts:171 [module-scope binding assigned by a session handler] let frameTimer: ReturnType<typeof setInterval> | undefined;"` and the `:172` `revealTimer` twin.
- Update the closing loop's "escaped by the rule's shape" assertion: `packages/ui/src/startup/index.ts` now **has** entries, so it must move out of that list; `packages/core/src/bridge/events.ts` stays in it, and the assertion for it gains the reason it is still invisible (namespace-import call).
- Add two fixtures next to `SHIPPED_SHAPE`/`DIRECT_ASSIGNMENT`/`SESSION_KEYED_MAP`/`WRITTEN_OUTSIDE_HANDLERS` and assert on them. Both must be self-contained multi-file sources fed to a new exported test seam (export the matcher as a function taking `Map<file, source>` for fixtures, or add a small `findViolationsInSources(map)` helper — do not make the fixtures read the repo):
  - `CROSS_MODULE_HOP` — `index.ts` with a `pi.on("session_start", …)` calling `setCfg(() => …)` imported as `import { setConfigGetter as setCfg } from "./shiki.js"`, and `shiki.ts` declaring `let _cfg: (() => Cfg) | undefined;` assigned inside `export function setConfigGetter(fn) { _cfg = fn; }`. Expected: exactly one hit, reported at `shiki.ts:1` naming `_cfg`. This proves the alias form and the cross-file hop are both live.
  - `NAMESPACE_IMPORT_NOT_FOLLOWED` — same shape but `import * as shiki from "./shiki.js"` + `shiki.setConfigGetter(…)`. Expected: **no** hit. This pins the remaining blind spot so a future widening is a deliberate edit, not an accident.
- Rewrite the header comment block: blind spot 1 now reads "the hop is followed for named imports, including `as` aliases and barrel re-exports; it is NOT followed for namespace imports (`import * as ns`, so `core/src/bridge/index.ts:160` → `core/src/bridge/events.ts:38` `sessionCtx` stays invisible) or for dynamic `import()` (`meta/src/index.ts:162` reaching `@pi-archimedes/diff` from its own `session_start` stays invisible)". Keep blind spots 2 and 3 (closures passed elsewhere; `name = …` only, no compound assignment, only literal `pi.on("…")` registrations) and state that the cross-module hop is one boundary deep plus transitive within the target file.
- Do **not** change the collector regex, the session-event list, or hop 1 / hop 2 semantics — this task adds a hop, it does not re-define what a violation is.

**Steps:**
- [ ] Add the two fixtures and the exported seam, and assert both expectations before implementing the resolver.
  - Run `npx vitest run packages/core/src/session-state-discipline.test.ts` → the `CROSS_MODULE_HOP` case must FAIL (0 hits found, 1 expected). If it already passes, the matcher is matching something it should not — investigate first.
- [ ] Implement the resolver + the new hop, re-run the same command.
  - Expected: fixtures green; the real-tree run now reports the two `packages/ui/src/startup/index.ts` hits.
- [ ] Add the two `ui` allow-list entries and update the `EXCUSED` expectation and the escaped-files loop.
  - Re-run: 4 passed, `VIOLATIONS` empty. If it reports a `core/src/bridge/…` violation, the hop is following namespace imports — tighten it back to named imports only.
- [ ] Run `npx vitest run packages/core` then `npx vitest run` from the repo root.
  - Expected: green. Any new violation in another package means the hop found something the research did not predict — read it, do not silence it with an entry whose reason you cannot justify.
- [ ] Run `npx tsc --noEmit` in `packages/core`.
  - Expected: clean.
- [ ] Prove the guard is not decorative: in a scratch copy under `/tmp` (never in the repo), re-add `let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;` plus a `_readConfig = readConfig;` assignment inside `registerDiffTools` in `packages/diff/src/index.ts`, and confirm the extended guard flags it. Report the reported line.
- [ ] Commit with message: `test(core): session-state guard follows one cross-module import hop`

**Acceptance criteria:**
- [ ] `CROSS_MODULE_HOP` fixture is flagged; `NAMESPACE_IMPORT_NOT_FOLLOWED` fixture is not.
- [ ] The allow-list names exactly: notify's `notifyTimer` + `pendingTrigger`, and `ui`'s `frameTimer` + `revealTimer` — four entries, four reasons matching `/follow-up: tsk_/`, and no entry for `packages/diff`.
- [ ] The header states the covered hop and the two remaining walls (namespace imports, dynamic imports) with a concrete file:line for each.
- [ ] `npx vitest run packages/core` is green and `npx vitest run` is green.

---

### Task 4: Bring `docs/features/session-state.md` back to present tense

**Parallel:** none — it rewrites the census and blind-spot text Task 3 changed.

**Context:** the feature doc is the persistent record of this rule (`status: live`), and Task 2 + Task 3 invalidate four statements in it: the three-binding allow-list census, the sentence justifying `diff/src/shiki.ts` / `diff/src/render/shared.ts` / `diff/src/ansi/codes.ts` as out of scope because "no session handler assigns them" (a session handler does assign them, one module away — that was the blind spot, not a clean bill of health), the blind-spot list, and the Follow-ups section. Leaving it stale is worse than leaving it unwritten: the next session reads it as verified.

**Files:**
- Modify: `docs/features/session-state.md`

**What to implement:**
- Front-matter: bump `last-verified` to the date this task runs and extend `verified-by` to name the new checks (`packages/diff/src/leak.test.ts` green and failing on the pre-change tree; the cross-module hop fixtures; the `/tmp` re-add probe from Task 3 step "prove the guard is not decorative"), and link `docs/research/diff-module-scope-config-holders.md` + issue #163 as the provenance.
- "What the guard checks, and where it is blind": state the rule as two intra-file hops **plus one module boundary for named imports** (aliases and barrel re-exports followed); keep `core/src/bridge/index.ts:160` → `bridge/events.ts:38` in the blind-spot list but re-label it as unreachable because the call is a namespace-member call (`events.onSessionStart(ctx)`), and add `meta/src/index.ts:162`'s dynamic `import()` of `@pi-archimedes/diff` as a second named wall.
- Replace the "Three bindings are allow-listed today" sentence with the actual census after this change: four bindings on two cards — `notify`'s `notifyTimer`/`pendingTrigger` (`tsk_9a0926e5-2d94-43bd-941a-ccf9ffe06bd7`) and `ui`'s `frameTimer`/`revealTimer` (`tsk_00a5ad67-8bc1-42e4-b999-d75196ec37c2`).
- Remove `diff/src/shiki.ts`, `diff/src/render/shared.ts`, `diff/src/ansi/codes.ts` from the "deliberately ignores … no session handler assigns them" list; those files no longer hold lifecycle-reachable bindings at all. `bridge/channel.ts`, footer's caches and `ui/src/thinking/theme.ts` stay in that list.
- Add one short paragraph recording the leak this card removed, in past tense and with its reproduction (two `registerDiffTools` calls with different readers; the split→unified flip), so the reason the threading shape is mandatory is readable without archaeology. Note plainly that it was unreachable in the single-reader composed install and real in a mixed install — that is the whole reason shape-parity was worth doing.
- Follow-ups: drop diff (done here), keep notify's pair and `ui`'s timers, keep the upstream items (pi Discussion #1546; `@tintinweb/pi-subagents`).
- Check `packages/diff/README.md` needs no change: it documents the four settings and the standalone-defaults behavior, never `setConfigGetter`/`getConfig`/`resetDiffColors`. Confirm with `grep -n "setConfigGetter\|getConfig\|resetDiffColors" packages/diff/README.md` (expect no output) and leave the file alone unless it says otherwise.

**Steps:**
- [ ] Read `docs/features/session-state.md` in full and diff its claims against the post-Task-3 tree before editing.
- [ ] Apply the edits above.
- [ ] Run `grep -n "diff/src/shiki.ts\|diff/src/render/shared.ts\|diff/src/ansi/codes.ts\|_readConfig" docs/features/session-state.md`.
  - Expected: no output (every stale reference removed) except a past-tense mention in the new leak paragraph — if the only hits are inside that paragraph, that satisfies the criterion.
- [ ] Run `grep -n "setConfigGetter\|getConfig\|resetDiffColors" packages/diff/README.md`.
  - Expected: no output. If there is output, the README documented an internal API and must be updated in this commit.
- [ ] Run `npx vitest run` from the repo root one final time.
  - Expected: green.
- [ ] Commit with message: `docs: session-state feature doc — cross-module hop, new census, diff's leak closed`

**Acceptance criteria:**
- [ ] The doc's allow-list census matches `session-state-discipline.test.ts` exactly (four bindings, two cards).
- [ ] The blind-spot list names namespace imports and dynamic imports with a `file:line` each, and no longer claims diff's cross-file holders are clean-by-merit.
- [ ] `last-verified` / `verified-by` describe checks that were actually run in this change.
