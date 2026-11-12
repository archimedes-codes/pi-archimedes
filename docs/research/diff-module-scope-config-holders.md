---
status: current
last-verified: 2026-11-12
verified-by: code research + executed harnesses — 2 angles returned (change surface, behavior/perf measurements), 2 angles failed and were completed in-session (guard cross-file prototype, pi 1.4.0 `.d.ts` read), 1 reproduced leak, host pinned @earendil-works/pi-coding-agent 1.4.0
task: tsk_7a7b2b7d-da43-4b56-b2c9-fccae1af0816
issue: https://github.com/archimedes-codes/pi-archimedes/issues/163
---

# `packages/diff` module-scope config holders — what shape-parity actually requires

Research report, not a fix. Evidence for card `tsk_7a7b2b7d-da43-4b56-b2c9-fccae1af0816`
("diff: module-scope `_readConfig` — same #156 shape… deferred from that PR"), whose stated `How`
is narrower than its own `done-when`. Every claim is cited (`repo:path:line`, or `path:line` into
the installed host). **FACT** = read from a cited source or produced by an executed harness.
**INFERENCE** = reasoned from facts. **GAP** = not established.

**Settled question.** What does full shape-parity for `packages/diff` require — removing every
module-scope binding its registration path writes, keeping live-apply by threading a config
*reader* rather than a snapshot — and how is the card's `done-when` made mechanically checkable?

---

## Executive summary

1. **The card names one binding; the registration path writes four.** `_readConfig`
   (`packages/diff/src/index.ts:44`) is the only one the suite guard can see. The other three are
   written one module away — the guard's own documented blind spot 1. (FACT, §1)
2. **"Impact: none observed" is accurate about the composed suite and false about the caches.**
   Two of the four already leak a session's config into another live session's render; reproduced
   against the real modules. (FACT, §2)
3. **The card's `How` would not fix the leak.** Holding `_readConfig` in the returned closure
   deletes the allow-list entry and leaves both leakers in place — the acceptance criterion is
   satisfiable without the `done-when` being true. (FACT §1 + INFERENCE, §6)
4. **One of the four is dead code, not misplaced state.** `_lastThemeKey`
   (`packages/diff/src/ansi/codes.ts:60`) is write-only; deleting the whole mechanism changes no
   behavior and leaves the suite green. (FACT, §3)
5. **Threading a reader is free and preserves today's behavior exactly.** 3 settings reads per new
   diff component ≈ 37 µs against a ~75 ms highlight; 0 reads per repaint. Live-apply today reaches
   only *new* rows anyway. (FACT, §4)
6. **Extending the guard across the import hop costs 2 new allow-list entries (named imports) or
   7 (also following `import * as ns`)** — each of which the guard's hygiene test requires to carry
   a `follow-up: tsk_…` id, and no such cards exist. And it still cannot see `meta`'s dynamic
   import of diff. (FACT, §5)

---

## Findings

### 1. The four bindings the registration path writes

`registerDiffTools(pi, _getTheme, readConfig)` (`packages/diff/src/index.ts:125-173`) repoints, on
every call and once per process (pi caches the extension module —
`docs/features/session-state.md:13`):

| Binding | Written at | Reached from `registerDiffTools` by | Guard sees it? |
|---|---|---|---|
| `index.ts:44` `let _readConfig: () => DiffConfig = () => DEFAULT_DIFF_CONFIG;` | `index.ts:138` | direct assignment | **Yes** — flagged, allow-listed (`packages/core/src/session-state-discipline.test.ts:120-126`) |
| `shiki.ts:13` `let _getConfig` | `shiki.ts:15` (`setConfigGetter`) | `index.ts:144` `setShikiConfig(() => getConfig())` | No — cross-file |
| `render/shared.ts:41` `let _getConfig` | `render/shared.ts:43` (`setConfigGetter`) | `index.ts:145` `setRenderConfig(() => getConfig())` | No — cross-file |
| `ansi/codes.ts:60` `let _lastThemeKey` | `codes.ts:89` (`resetDiffColors`), `codes.ts:137` | `index.ts:141` `resetDiffColors()` | No — cross-file |

Why the guard sees exactly one: the collector is intra-file
(`packages/core/src/session-state-discipline.test.ts:22-31`, header blind spot 1 at `:56-73`). Diff
has its own `pi.on("session_start")` at `index.ts:183` → `registerDiffTools`, so hop 2 fires
intra-file for `_readConfig` and stops at the three import boundaries.

Two facts that shrink the surface (both FACT):

- **`_getTheme` (`index.ts:127`) is never referenced in the function body.** The theme reaches every
  renderer as pi's own per-call `theme` argument (`tools/edit.ts:84`, `:157`; `tools/write.ts:74`,
  `:114`), not through the registration getter. Its only observable behavior is
  `meta/src/session-isolation.test.ts:260-277`, which calls it back and asserts per-session identity.
- **The Shiki LRU is already theme-keyed** — `` `${theme}\0${language}\0${code}` `` (`shiki.ts:73`),
  with `theme` read fresh at `shiki.ts:72` — so threading the theme name per call needs no cache-key
  change, and a theme switch cannot poison the cache (new theme = new key).

### 2. The leak is real, and it is not the one the card points at

Reproduced in-session against the real modules — two `registerDiffTools` calls on two fake `pi`
handles, then render as session A (harness in `/tmp/g3/leak.test.ts`, run under `vitest`):

```
BEFORE (as A): {"diffTheme":"github-light","diffSplitMinWidth":100,"split":true, "readsA":2}
AFTER  (as A): {"diffTheme":"dracula",     "diffSplitMinWidth":400,"split":false,"readsA":2}
```

Session B's registration changes what session A's render reads: the Shiki theme name *and* the
split thresholds, flipping A's view from split to unified. `readsA` does not advance — A's own
reader never fires again. (FACT, executed)

Corroborated independently by the behavior/perf angle, which also measured the syscall-level effect
(`strace` over isolated warm renders: 3 `openat` + 3 `access` per `renderSplitLines`) and reported
the same flip with the mechanism named: the whole `DiffRenderConfig` is shared, not just the theme.

**Reachability.**

- One module instance per process, many sessions: the loader caches the factory per extension path
  and builds jiti with `moduleCache: false` (`loader.js:461-491`, `:480-482`), so a cache hit skips
  the import. Verified against real jiti 2.7.0 by the perf angle (one module load, two factory
  invocations, shared counters). (FACT against 1.4.0 dist + executed jiti harness; **GAP**: not
  observed against a live two-session pi run)
- **Composed suite, single install: not observable** — every reader is the same function over the
  same file (`meta/src/index.ts:191`, `() => loadDiffConfig()`), so the shared slot always holds an
  equivalent value. That is exactly what the allow-list reason claims
  (`session-state-discipline.test.ts:121-124`). (FACT)
- **Observable in a mixed install:** a standalone diff session registers `() => DEFAULT_DIFF_CONFIG`
  (`packages/diff/src/index.ts:184`) — different values from `archimedes.diff` — so any second
  in-process session reaching `registerDiffTools` repoints the live parent's theme and thresholds.
  (FACT for the two readers; **INFERENCE** for the pairing)
- **The class the card was born from:** `docs/features/session-state.md:15` names a subordinate
  in-process session (a third-party subagent child, no `uiContext`) running its lifecycle against
  the same module instance. The suite's own `packages/subagent` forks a separate process, so it can
  never reproduce this — the same reason #156 shipped. (FACT, doc; **GAP**: whether that child
  registers diff in-process was not observed)

**Scope of the blast radius:** pi-theme-derived colors are safe — `resolveDiffColors` takes the
theme as an argument (`codes.ts:132`) and `DiffComponent` memoizes per instance
(`diff-component.ts:80-89`). The leak is confined to `diffTheme` plus the three split thresholds.

### 3. `_lastThemeKey` is dead state, and the test that pins it passes without it

`packages/diff/src/ansi/codes.ts:132-147`:

```ts
const themeKey = themeCacheKey(theme);
if (themeKey !== _lastThemeKey) { _lastThemeKey = themeKey; }   // no else, no return
if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
return { fgAdd: themeFgAnsi(theme, "toolDiffAdded") ?? FG_ADD, … };   // derived from the ARG
```

Repo-wide references to `_lastThemeKey` are `codes.ts:60, 89, 136, 137` and nothing else (FACT,
grep). The perf angle deleted the entire mechanism and ran the suite: **26/26 `codes.test.ts` pass,
218/218 `packages/diff` pass, 4/4 `session-state-discipline.test.ts` passes** (FACT, executed in a
/tmp copy). `codes.test.ts:253-284` — `"resetDiffColors > clears cache so subsequent call
re-derives"` — passes with the reset body emptied, because `resolveDiffColors` re-derives from its
argument. Six further `resetDiffColors()` calls (`:188, :194, :200, :221, :229, :245`) are hygiene
preambles that cannot fail.

History (FACT, git): at `0861819` that branch mutated nine module-scope `export let BG_*` globals;
`160c6d4` removed the aliases and left the key assignment behind.

**Trap for a future reader.** `themeCacheKey` (`codes.ts:92-107`) samples `theme.fg(...)` over 8
tokens and `theme.bg(...)` over 2 and **never looks at `getFgAnsi`** — the very accessor
`resolveDiffColors` derives from. Two themes with no `.fg` both key to `"no-theme"` (FACT, executed:
collisions confirmed for no-`.fg`, throwing-`fg`, and echoing-`fg` theme pairs). So anyone who
"restores" this into a real memo can serve one theme's diff colors to another; and because
`index.ts:141` runs per `session_start`, not per theme change, `resetDiffColors` could not catch it.

Applying the suite's own criterion (`docs/features/session-state.md:11`): no per-session value ever
flows through `_lastThemeKey`. It is an honest process-wide memo shape degenerated into a write-only
global — **dead state, not misplaced state.** Deleting it satisfies the `done-when` with no threading
at all.

### 4. Threading a reader: cost, and what live-apply is actually worth

Per **new** diff component (FACT, `strace` + timed):

| Work | settings reads |
|---|---|
| `renderSplitLines` first render | 3 (`shouldUseSplit` → `shared.ts:114`; `hlBlock` ×2 → `shiki.ts:72`) + 1 one-time `ensureShiki` (`shiki.ts:49`) |
| every repaint / resize / re-width after resolve | **0** — `_rawLines` (`diff-component.ts:54`) survives `invalidate()` (`:157-163`) |
| `edit` multi-op, up to 3 components (`edit.ts:136-142`) | up to 9 |

Timings on this machine (node v22.23.1, `~/.pi/agent/settings.json` = 1986 bytes): a `loadConfig`
equivalent is **12.4 µs/op**, 3 reads ≈ **37-42 µs**; one warm `codeToANSI` of a 50-line TS diff is
**72-81 ms**; a warm-LRU `renderSplitLines` median **4.8 ms**; `parseDiff` 225 µs; the
`readDisplacedContent` read the design already performs per `tool_call` **36.6 µs**. Ratio: reads are
**1:2000** against one highlight, **0.2-0.8%** of a render, and the same order as a read the code
already does. (FACT, measured)

**Measurement honesty:** an unpaired first attempt attributed **18.9 ms/render** to the reads; the
paired A/B (N=120, alternating) says **0.19 ms** and the direct µs measurement says 42.5 µs for all
three. The paired number is the one to believe — the reads are noise unless the settings file grows
past ~100 KB.

**What live-apply buys today** (FACT, executed): the live reader changes only the **next new diff
row**. Two independent reasons a mounted row never re-highlights: `invalidate()` never clears
`_rawLines`, and the `write` preview keys (`` `create:${themeCacheKey(theme)}:… `` `write.ts:88`;
`` `nf:… `` `:137`) hash **pi's** theme, not `diffTheme`. `meta/src/settings.ts:186-194`'s `onSave`
writes the file and does nothing else — no reload, no notify, no invalidate.

**No document promises when an `archimedes.diff` change takes effect.** `grep -rn diffTheme docs/` →
zero hits; there is no `docs/features/diff.md`. The nearest statements are `packages/diff/README.md:27`
(`/reload` picks the renderer up), `:55` (palette is Shiki-derived, not pi-theme-derived), and
`meta/README.md:164,168` ("Settings captured at startup need `/reload`"). (FACT) So threading a
**reader** — the chosen direction — reproduces today's observable behavior exactly, and neither
shape contradicts a written promise.

### 5. Extending the guard across the module boundary

Prototype over the same walk as the guard (150 files, `/tmp/g3/`, dependency-free Node, reusing the
guard's own matcher functions). Blast radius of **one** cross-file hop:

**Tier 1 — following named imports (incl. `import { x as y }` aliases and barrel re-exports):**
5 newly flagged bindings.

| Newly flagged | Reached from | Path |
|---|---|---|
| `packages/diff/src/shiki.ts:13` `_getConfig` | `packages/diff/src/index.ts` | `registerDiffTools` → `setShikiConfig` → `shiki.ts` (`setConfigGetter`) |
| `packages/diff/src/render/shared.ts:41` `_getConfig` | `packages/diff/src/index.ts` | `registerDiffTools` → `setRenderConfig` → `render/index.js` → `shared.ts` |
| `packages/diff/src/ansi/codes.ts:60` `_lastThemeKey` | `packages/diff/src/index.ts` | `registerDiffTools` → `resetDiffColors` → `ansi/index.js` → `codes.ts` |
| `packages/ui/src/startup/index.ts:171` `frameTimer` | `packages/ui/src/index.ts` | `session_shutdown` → `clearSpinInterval`/`stopStartupListing` |
| `packages/ui/src/startup/index.ts:172` `revealTimer` | same | same |

→ **2 new allow-list entries** (the two `ui` timers; all three diff entries disappear with the fix).

**Tier 2 — also following `import * as ns` (`ns.fn()` calls):** +5, all in core's bridge:
`bridge/channel.ts:66` `active`, `:67` `socketPath` (via `channel.configure()`), and
`bridge/events.ts:28` `refcount`, `:31` `subscribedOn`, `:38` `sessionCtx` (via `events.start` /
`onSessionStart` / `stop`). → **7 new entries total.**

The two tiers are not a style choice. The guard's `CALLS` regex `(?<![\w.])([A-Za-z_$][\w$]*)\s*\(`
structurally cannot match `events.onSessionStart(ctx)` (verified: returns no capture), so **Tier 1
does not deliver the `bridge/events.ts:38` case the guard header itself names as blind spot 1**
(`session-state-discipline.test.ts:58-62`). Tier 2 does, at the cost of 5 more entries — and
`bridge/channel.ts`'s `active`/`socketPath` are one-socket-per-process by design, i.e. honest state
that would be exempted rather than fixed.

**The wall that stays.** `meta/src/index.ts:162` reaches `@pi-archimedes/diff` through
`await import(...)` inside its own `session_start` handler and calls `diffMod.registerDiffTools(...)`
at `:191`. A regex-level resolver cannot follow it (FACT — no static import edge exists; the dynamic
specifiers are in `meta/src/index.ts`, `meta/src/plugins.ts`, `meta/src/settings.ts`,
`packages/subagent/src/index.ts`, `packages/web/src/extractors/pdf.ts`, `packages/diff/src/index.ts`).
So after the extension, the guard catches **diff via diff's own standalone handler only**, and never
via meta's composed wiring. That is consistent with the rule's purpose — the standalone handler is
exactly the shape that makes a package independently loadable, and therefore independently dangerous.

**Hygiene cost.** The guard's last test requires every allow-list reason to match
`/follow-up: tsk_/` (`session-state-discipline.test.ts:668-683`) and pins `EXCUSED` exactly
(`:660-666`). Each new entry therefore needs a real card id. There are no spare cards for `ui`'s
timers or `bridge`'s five, so a Tier-2 extension would need those cards created first, and a reason
citing a non-existent card would be a lie the test happily accepts (GAP: nothing validates the id
exists).

**Alternatives, measured.**

- **(b) package-local assertion in `packages/diff`.** "No module-scope `let`/`var` anywhere in
  `packages/diff/src`" is **not satisfiable today** — violations would include `_TextComponent`
  (`index.ts:90`, a top-level-await SDK load, honest process state) and `_shikiReady`
  (`shiki.ts:45`, an honest one-shot memo) alongside the four. A narrower, satisfiable rule: *no
  module-scope holder of config or theme state* — i.e. reject `setConfigGetter`-shaped exports and
  any `let` whose only writers are config setters. Cheap, package-scoped, no new cards.
- **(c) an ESLint/type-level rule.** The repo has **no lint configuration at all** — root `package.json`
  scripts are `preinstall` and `vitest run` only; `ls -a` finds no eslint/biome/oxlint/prettier
  config; CI runs `pnpm install --frozen-lockfile`, `pnpm -r exec -- tsc --noEmit`, `pnpm test`
  (`.github/workflows/ci.yml:40-46`). Choosing (c) means standing up new infrastructure plus a
  custom rule, and it would be the only lint in the suite.

`setConfigGetter` is unique to diff — grep across `packages/*/src` and `meta/src` finds no other
getter-injection site. The suite's already-threaded precedents are `ui/src/thinking/patch.ts:30-38`
(`patchThinkingRenderer(getTheme, config?, notify?)`, re-called every `session_start` from
`ui/src/index.ts:430-431`), `image-paste/src/index.ts:194` (a returned per-session handle), and
`sudo/src/index.ts:18` (`registerSudo(pi, options?)`). (FACT) **Diff is the last holder of the
getter-injection shape.**

### 6. Change surface for the threading refactor

Measured: **~92 touched source lines across 12 of 13 files** (`tools/index.ts` untouched), **~34 test
call sites across 6 diff test files**, plus **2 mandatory sites in the guard test**.

Signatures that change arity or disappear (13): `hlBlock` `+1` theme (6 call sites),
`ensureShiki` `+1`, `shouldUseSplit` `+1` cfg (1 prod + 6 test), `renderUnifiedLines`/`renderSplitLines`
`+1` each, `renderUnified`/`renderSplit` `+1` (zero call sites each), `DiffComponent` ctor `+1`
(3 sites), `createEditRenderers`/`installEditTool` `+1` (6 test sites),
`createWriteRenderers`/`installWriteTool` `+1` (5 test sites), `getDiffSettingsItems` optionality
flips to required, and both `setConfigGetter`s plus `resetDiffColors` deleted.
**Unchanged:** `lang`, `themeCacheKey`, `resolveDiffColors`, `registerDiffTools`.

Largest deletions: `render/shared.ts:32-44` + `:114` (~14 lines), `ansi/codes.ts:59-60, 88-90,
133-138` (~7), `shiki.ts:13-16` (~6), `index.ts:44-45, 138, 141, 144-145` (~8).

**Public API:** `packages/diff/package.json:17-19` exports only `"."` → `./src/index.ts`;
`setConfigGetter`, both `getConfig`s, `resetDiffColors`, `resolveDiffColors`, `hlBlock`,
`shouldUseSplit`, `renderSplit*` and `renderUnified*` are **not** on that surface — the internal
barrels (`render/index.ts:10-11`, `ansi/index.ts:10`) are not resolvable from outside (ADR 0007
dissolved-barrel policy governs intra-suite imports). So deleting them is **internal**, not a
standalone-install break. The only root-surface change is `getDiffSettingsItems(overrideConfig?)`
becoming required (`index.ts:51-52`), and the sole caller (`meta/src/settings.ts:61`) already passes
it. (FACT)

**Two constraints the plan must respect:**

- **Do not reorder `registerDiffTools`'s parameters.** `meta/src/session-isolation.test.ts:261,276`
  reads `call[1]` positionally as the theme getter — it is the #156 regression pin for diff. (FACT)
- **The guard test needs two edits, not one:** delete the `AllowEntry` (`:120-126`) *and* the string
  in the exact `EXCUSED` expectation (`:663`); the loop at `:668-683` also fails on a stale entry. (FACT)

**Test gaps that weaken the refactor's safety net:** `render/split.ts`, `render/unified.ts` and
`diff-component.ts` have **no test file at all** — three of the 13 arity changes are unverified
before and after. `render/shared.test.ts:6` imports `getConfig` and never calls it. (FACT)

### 7. Host facts (pi 1.4.0, `dist/core/extensions/types.d.ts`)

- `registerToolRenderer(resolver: ToolRendererResolver): void` at `:1256`;
  `ToolRendererResolver = (toolName, next: () => ToolRenderers | undefined) => ToolRenderers | undefined`
  at `:526`; `ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">`
  at `:521`; `renderCall(args, theme, context)` `:516`, `renderResult(result, options, theme, context)` `:518`.
- `ToolRenderContext` (`:347-377`) carries `args`, `toolCallId`, `invalidate`, `lastComponent`,
  `state` ("Shared renderer state for this tool row. Initialized by `tool-execution.ts`"), `cwd`,
  `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`, `durationMs`,
  `outputPad`. **`state` is a per-tool-row slot, not a config carrier** — nothing in the renderer
  signature can deliver a per-session config reader, so capturing the reader in the registration
  closure is the correct shape. (FACT for the types; INFERENCE for the conclusion)
- `getSettings(): Settings` at `:1285-1286`, documented: *"Get a copy of the effective settings
  (global and project settings merged, with overrides)."* It returns a **copy**, so a per-call read
  cannot be mutated into staleness — but it is not what diff reads today (below).
- **No per-session store.** `ExtensionContext` (`:213-256`) exposes `ui`, `mode`, `hasUI`, `cwd`,
  `sessionManager`, `modelRegistry`, `model`, `scopedModels`, `thinkingLevel`, `isIdle`,
  `isProjectTrusted`, `signal`, `abort`, `hasPendingMessages`, `shutdown`, `getContextUsage`,
  `compact`, `getSystemPrompt` — no `state`/`data`/`set`/`get` slot. `docs/features/session-state.md`'s
  conclusion still holds on 1.4.0. (FACT)

**Adjacent finding, independent of this card:** `loadDiffConfig` (`meta/src/config.ts:59-61`) →
`loadConfig` → `readSettings()` (`core/src/settings-io.ts:98`), **not** `readEffectiveSettings(pi)`
(`:64-89`). So diff's config never sees project-scoped `<cwd>/.pi/settings.json` or in-process
overrides, while `web` does (`packages/web/src/config.ts:28` takes `pi`). (FACT) This is what the
threaded reader reads; fixing it is a separate decision.

---

## Unresolved contradictions

- **Card vs. measurement.** The card says "harmless in the composed path… impact: none observed";
  the harness shows a cross-session flip in the shared config slot. Resolved by scope, not by
  discarding either: harmless **for the single-reader composed install**, not as a property of the
  caches. The card's claim should be restated as "unreachable today, real in a mixed install or an
  in-process child session."
- **Card `How` vs. card `done-when`.** The `How` ("capture the config reader in the closure the call
  returns") achieves the allow-list deletion and leaves `shiki.ts:13` and `render/shared.ts:41`
  leaking. The `How` must be widened to all four holders for the `done-when` to mean anything.
- **Guard header vs. guard capability.** The header presents `bridge/events.ts:38` as a known
  cross-boundary blind spot; a one-hop named-import extension does not reach it (the call is
  `events.onSessionStart(ctx)`, a namespace-member call the `CALLS` regex cannot match). Either the
  extension follows namespace imports too, or the header's claim needs correcting.

---

## Gaps

1. No live two-session TUI run. The leak is reproduced against the real modules with two fake `pi`
   handles; module-instance sharing is inferred from `loader.js` plus a jiti 2.7.0 harness.
2. Whether a third-party in-process child actually registers `@pi-archimedes/diff` is cited from
   `docs/features/session-state.md:15`, not observed.
3. `render/split.ts`, `render/unified.ts`, `diff-component.ts` have zero tests — three arity changes
   land unverified.
4. `renderSplit` (`split.ts:30`) and `renderUnified` (`unified.ts:27`) have zero call sites in the
   repo; whether to keep them is a judgement, not a fact.
5. `docs/features/session-state.md` was last verified against pi **1.5.0**; this tree's dev pins are
   **1.4.0** (`packages/diff/package.json` devDependencies). The host claims in §7 are read from 1.4.0.
6. Whether `_lastThemeKey` was ever load-bearing beyond `0861819` was not traced further than the
   commit that orphaned it.
7. Nothing in the guard validates that a `follow-up: tsk_…` id names a real card.
8. Frame-level repaint volume (fullscreen vs. regular screen, `docs/features/screen-mode.md`) was not
   measured; the "0 reads per repaint" figure is a component-level fact.

---

## Evidence

| Source | Credibility | Used for |
|---|---|---|
| `packages/*/src`, `meta/src` (read + grep, 150 scanned files) | highest — the code itself | §1, §3, §5, §6 |
| Executed harnesses (`/tmp/g3/leak.test.ts` under vitest; perf angle's esbuild harnesses, `strace`, mutation runs) | high — reproducible, but outside a live pi | §2, §3, §4 |
| `/tmp/g3/lib.mjs` + `cross.mjs` + `ns.mjs` — prototype reusing the guard's own matcher functions | high for the repo's real import forms | §5 tiers, dynamic-import verdict |
| `@earendil-works/pi-coding-agent@1.4.0` `dist/core/extensions/types.d.ts` | highest — shipped declarations | §7 |
| `docs/features/session-state.md`, `docs/research/foreign-session-shutdown-destroys-module-state.md`, `docs/research/angle5-upstream-ecosystem-per-session-state.md` | high — this suite's own prior research, cited into pi 1.5.0 dist | §2 reachability, rule criterion |
| `.github/workflows/ci.yml`, root/`packages/diff/package.json` | high | §5 option (c), §6 API surface |

Companion: [`../features/session-state.md`](../features/session-state.md) carries the rule and the
#156 mechanism; [`foreign-session-shutdown-destroys-module-state.md`](foreign-session-shutdown-destroys-module-state.md)
carries the pi-source citations for module caching and per-`emit()` context.
