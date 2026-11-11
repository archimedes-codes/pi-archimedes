---
status: committed
done-when: With @tintinweb/pi-subagents (or any in-process subordinate session) running, alt+v still attaches an image and the editor border spinner still animates after the subordinate session is torn down; a new suite-wide guard test fails if any package reintroduces a module-scope session ref, and `pnpm test` plus `pnpm -r exec -- tsc --noEmit` are green.
task: tsk_a86f1a40-3fdf-4989-ae79-87e3de0e50e7
---

# Per-session state must not live at module scope (#156)

## Spec

**Problem:** pi caches an extension's module per process but re-invokes its factory with a fresh `pi`
for every session, so module-scope state is shared by all sessions in one process. `image-paste` keeps
its paste queue there and nulls it from an unguarded `session_shutdown`, so when an in-process
subordinate session (a third-party subagent extension's child) is reaped, the main session's `alt+v`
goes dead with no error — issue #156. The same shape silently breaks `packages/ui` (a foreign shutdown
kills the live session's border spinner and splash timers) and `meta` (its stored teardown ref is
liveness-gated but not owner-gated, and `currentCtx` can be poisoned to a torn-down child's ctx).

**Solution:** per-session state moves inside `register()`, which pi re-runs per session with its own
`pi` handle, so each session owns its state and its own teardown. `registerImagePaste` returns an
explicit session handle (`{ initSession, shutdown }`) instead of relying on module-level lifecycle
exports, and `meta` holds those handles in a session-keyed map — the one place a keyed collection is
required, because meta's teardown handler must stay top-level. A new suite-wide guard test makes the
rule mechanical, modelled on the two `*-discipline.test.ts` files already in `packages/core`.

**Out of scope:** `packages/notify` (`notifyTimer`/`pendingTrigger` at `index.ts:197-198`),
`packages/diff` (`_readConfig` at `index.ts:44`), and `packages/core/src/bridge/events.ts`
(`sessionCtx` at `:38`). All three are the same class — notify's is a minor lost notification, diff's
re-assigns the same value per session in the composed path, and core's is generation-guarded by
design — and each is deliberately deferred to an allow-listed entry with its own follow-up card rather
than folded into this PR. Also out of scope: any upstream change to pi or to
`@tintinweb/pi-subagents` (evaluated and rejected as unowned — see Evidence §4), and changing
`packages/subagent`, which forks a separate process and cannot trigger this.

**Decisions:**

1. **Per-instance closure state, not a session-id-keyed Map inside packages.** pi re-invokes the cached
   factory with a brand-new `pi` per session (`loader.js:516-517`, `createExtensionAPI` builds a fresh
   `api` literal at `:215`), so closure state is per-session for free; this is also what
   `docs/extensions.md` §State Management prescribes, and what `ask` (`packages/ask/src/index.ts:7-8`),
   `todo` (`:14-17`), `session-name` (`:287-288`) and `footer` (`:38`) already do in this suite.
2. **`meta` deviates: a module-scope `const Map` keyed by session id.** meta registers image-paste
   inside `session_start` (lazy import — heavy deps must not load at startup) but its teardown handler
   is top-level, because AGENTS.md forbids registering `session_shutdown` inside `session_start`. A
   top-level handler cannot reach a per-session closure, so a keyed collection is the only shape left.
   A `const` Map whose *contents* change is not the bug shape: a foreign shutdown can only delete and
   call its own key. The rejected alternative — register the shutdown handler from inside
   `session_start` — is what AGENTS.md's event-handler rule prohibits, and it was rejected on that
   rule, not on correctness.
3. **`!ctx.hasUI` is not used as the guard.** It is `uiContext !== noOpUIContext`
   (`core/extensions/runner.js:405`) and is `true` under `--mode rpc`; it works for this one trigger
   only because `bindExtensions({})` passes no `uiContext`. Ownership comes from the closure (and, in
   meta, from the key), never from `hasUI`.
4. **`WeakMap` keyed on `ctx` is rejected outright.** pi builds a fresh ctx per `emit()`
   (`core/extensions/runner.js:814` and eleven sibling sites), so such a map gains an entry per event
   and never finds the session's.
5. **`meta`'s `currentCtx` is removed, not guarded.** `registerDiffTools` is already called inside
   `session_start` (`meta/src/index.ts:163`), so its theme getter can close over that call's own `ctx`
   (`() => ctx.ui.theme`) and the module ref disappears.
6. **The guard's rule is "assigned from a lifecycle path", not "declared at module scope".** A
   blanket ban on module-scope `let`/`var` catches ~40 legitimate process-wide caches across 11 files
   (git/stats/jj caches, bridge channel state, Shiki config) and would ship a giant allow-list on day
   one. The rule is narrowed to bindings a session lifecycle handler can actually repoint, which today
   is exactly five files — the three this doc fixes and the two deferred ones. That count is a property
   of the current tree's assignment topology: the rule is **intra-file** (see Task 4's blind-spot
   comment), so a shape that crosses a module boundary — `core/bridge/events.ts`'s `sessionCtx`,
   `ui/src/startup/index.ts`'s splash timers — is out of its scope by construction, not by exemption.

**Evidence:** `docs/research/foreign-session-shutdown-destroys-module-state.md` (attached to this card
as the `research` artifact). Load-bearing findings: the reporter's citations against
`@tintinweb/pi-subagents@0.23.1` verify exactly and 0.23.2 is byte-identical in the same files
(`agent-runner.js:1031,1038`; `agent-manager.js:139,148,218,1325,1354`; `index.js:788,1054`); the
`session_shutdown` payload carries no identity for the dying session
(`core/extensions/types.d.ts:656-660`) and `reason: "quit"` is ambiguous between a real quit and a
child teardown; pi's own `/new`/`/resume`/`/fork`/`/reload` emit `shutdown(old)` **before**
`start(new)`, so pi's switching cannot strand a session and the bug requires two overlapping runners;
and `packages/ui`'s spinner loss was reproduced with a control (`/tmp/ui156/probe2.mjs`:
`A) FOREIGN (child) shutdown killed: 1 [ 'THE LIVE SPINNER' ]` / `B) CONTROL main shutdown killed: 0`).

## Plan

**Goal:** no package holds another session's state, and a test enforces it.
**Architecture:** per-session state lives in the `register()` closure that pi re-runs per session;
`image-paste` exposes a session handle, `meta` keys handles by session id, `ui` keeps its own refs and
its splash ownership per instance. A `*-discipline.test.ts` guard in `packages/core` fails the suite if
a lifecycle-reachable module-scope binding reappears.
**Tech Stack:** TypeScript, vitest (projects config at repo root), pnpm workspace, `tsc --noEmit` as
the only type gate.

---

## Parallelisation

**Verdict:** PARALLEL — 3 waves
- Wave 1: Task 1 (`packages/image-paste/**`), Task 2 (`packages/ui/**`) — disjoint file sets, verified
  pairwise; neither imports the other, and neither touches a shared config, lockfile, or barrel.
- Wave 2: Task 3 (`meta/**`) — imports `registerImagePaste`'s new return type from Task 1, so it fails
  gate 2 (no build-graph dependency on a symbol a sibling creates in the same wave) and cannot join Wave 1.
- Wave 3: Task 4 (guard test + docs + AGENTS.md) — its acceptance criterion is that the guard is green
  over the *fixed* tree, which needs Tasks 1-3 present (gate 4).

---

### Task 1: image-paste holds its queue per session

**Parallel:** wave 1 — disjoint from Task 2 (`packages/ui/**`); Task 2 never imports `@pi-archimedes/image-paste`.

**Context:**
Issue #156. `packages/image-paste/src/index.ts` keeps `_ctx`, `_queue`, `_pasting` at module scope
(`:176-178`) and exposes `initImagePasteSession(ctx)` (`:303`) / `shutdownImagePaste()` (`:309`) as
module-level lifecycle functions. pi reuses one module instance across every session in a process, so
when a subordinate in-process session (a third-party subagent child) shuts down, `shutdownImagePaste()`
nulls the **main** session's queue and the `alt+v` handler returns at `if (!_queue || !ctx.hasUI) return;`
(`:210`) before reading the clipboard — silently. `pi` itself is per-session (a new `api` object per
factory call), so the fix is to create the state inside `registerImagePaste` and hand the caller a
handle. meta calls both lifecycle functions by name, so this task changes the package's public export
shape; nothing in any README documents them (verified), so no doc claim breaks.

**Files:**
- Modify: `packages/image-paste/src/index.ts`
- Modify: `packages/image-paste/src/default-export.test.ts` (TAB-indented — exact-match edits must use tabs)
- Modify: `packages/image-paste/src/paste-mutex.test.ts`
- Modify: `packages/image-paste/src/preview-setting.test.ts`
- Modify: `packages/image-paste/src/shortcut-gate.test.ts`
- Create: `packages/image-paste/src/session-isolation.test.ts`

**What to implement:**

1. In `packages/image-paste/src/index.ts`, delete the three module-scope bindings at `:176-178` and
   declare the state inside `registerImagePaste` instead. Change its signature to return a handle:

   ```ts
   export interface ImagePasteSession {
     /** Adopt this session's ctx and start a fresh queue. Call from session_start. */
     initSession(ctx: ExtensionContext): void;
     /** Drop this session's state. Idempotent; touches nothing outside this session. */
     shutdown(): void;
   }

   export function registerImagePaste(pi: ExtensionAPI): ImagePasteSession;
   ```

   Inside the function body, before the `if (suiteMayClaimPasteKey())` gate, declare
   `let ctxRef: ExtensionContext | null = null; let queue: ImageQueue | null = null; let pasting = false;`.
   Rewrite the shortcut handler to close over them (`if (pasting) return; if (!queue || !ctx.hasUI) return;`
   — keep the mutex **before** the queue check, and keep the comment explaining why every read it awaits
   is bounded), the `input` handler to use `queue`/`ctxRef`, and return
   `{ initSession: (ctx) => { ctxRef = ctx; queue = createImageQueue(); }, shutdown: () => { ctxRef = null; queue = null; pasting = false; } }`.
   Keep `queueImage`, `dispatchClipboardPaste`, `createImageQueue`, `ImageQueue` and the branch-order
   comment (image → paths → text, ADR 0030) exactly as they are — the dispatch logic is not the bug.
2. Delete the exported `initImagePasteSession` and `shutdownImagePaste` functions entirely (they cannot
   exist without module state). Update the default export at the bottom of the file so it wires the
   handle instead: `const session = registerImagePaste(pi);` then `pi.on("session_start", …)` calls
   `session.initSession(ctx)` **before** `await runNativePasteRestore(ctx)` — the restore can reload,
   so the queue must already be live when it runs (keep the `runNativePasteRestore` try/catch and its
   `diag` call verbatim)
   and `pi.on("session_shutdown", …)` calls `session.shutdown()`. **Both handlers stay registered at the
   top level of the default export** — AGENTS.md's event-handler rule; do not nest them.
3. Update the three harnesses that call the deleted exports. `paste-mutex.test.ts`'s `createHarness()`
   (`:67-69`) currently does `registerImagePaste(pi); initImagePasteSession(ctx);` with an `on: () => {}`
   pi — capture the handle: `const session = registerImagePaste(pi); session.initSession(ctx);`.
   `preview-setting.test.ts` does the same at `:65-66` and calls `shutdownImagePaste()` with no
   arguments at `:89` and `:140` (inside `beforeEach` and a loop) — replace both with the handle's
   `session.shutdown()`; because `registerSession()` creates the session, have it return the handle
   (`return { pi, notify, pasteAndSubmit, session }`) so the reset at `:89` can call it.
   `shortcut-gate.test.ts` calls `registerImagePaste(pi as never)` at nine sites and never touches the
   lifecycle exports — its existing assertions (`on` event-name lists, registered shortcut keys) must
   keep passing with the return value ignored; if TypeScript objects at an unused return, no change is
   needed (a bare call statement is fine).
4. Rewrite the one test that pins the broken contract. `default-export.test.ts:40` is named "resets the
   per-session queue on session_start and clears it on shutdown" and asserts the handlers exist and do
   not throw (`:45-51`). Re-title it to say what is now guaranteed — that a session's shutdown clears
   **its own** queue and leaves another session's intact — and keep the existing "one `session_start`
   handler per factory run" and `runNativePasteRestore` twice assertions (`:89-93`), which are about
   handler accumulation and are unaffected.
5. Create `packages/image-paste/src/session-isolation.test.ts` as the regression test. It must fail
   before step 1-2 and pass after. Model the harness on `preview-setting.test.ts` (mock
   `@earendil-works/pi-coding-agent` for `getAgentDir`, mock `./clipboard.js` so
   `readClipboardImage` resolves `{ bytes: new Uint8Array([1,2,3]), mimeType: "image/png" }`), and drive
   **two sessions through one module instance**, which is how pi runs it:

   ```ts
   const main = makeSession();      // registerImagePaste(mainPi) + main.initSession(mainCtx)
   // main pastes an image; the marker "[Image #1]" is in the editor
   const child = makeSession();     // second factory run, same module — pi does this per session
   child.initSession(childCtx);     // child session_start
   child.shutdown();                // child session_shutdown (reason: "quit")

   // 1. main's shortcut still reaches the clipboard
   await main.paste(mainCtx);
   expect(mockReadClipboardImage).toHaveBeenCalledTimes(1);   // the reader actually ran for main
   // 2. main's queued image still attaches on submit
   const result = await main.input({ text: "[Image #1] look", source: "interactive" });
   expect(result.action).toBe("transform");
   expect(result.images).toHaveLength(1);
   ```

   Two `it`s, matching the two symptoms: *"a foreign session's shutdown does not stop the main
   session's paste"* and *"a foreign session_start does not orphan the main session's queued image"*.
   The second one is the case where only `child.initSession(...)` runs (no shutdown). Both assertions
   come from the `input` handler's return value, so no pi internals are needed.

**Steps:**
- [ ] Write `packages/image-paste/src/session-isolation.test.ts` first, written against the **new** API
      (`registerImagePaste` returning a handle), and run `npx vitest run packages/image-paste` from the
      repo root. It must fail — currently with `main.initSession is not a function` (the handle does not
      exist yet), which is the expected pre-fix failure. Confirm it is failing for the API/behaviour
      reason and not a mock setup error.
- [ ] Implement steps 1-2 in `packages/image-paste/src/index.ts`.
- [ ] Run `npx vitest run packages/image-paste`. Expect the two new tests green and the three existing
      harness files green after step 3. If `shortcut-gate.test.ts` or `default-export.test.ts` fail on
      handler *counts*, fix the wiring, not the assertion — the "one `session_start` per factory run"
      guarantee must survive.
- [ ] Run `npx tsc --noEmit` **from inside `packages/image-paste/`**. Must be clean. Expect errors
      naming `initImagePasteSession`/`shutdownImagePaste` in `meta/src/index.ts` — those belong to
      Task 3 and are resolved there; record them in your report rather than editing meta from this task.
- [ ] Commit on this task's branch: `fix(image-paste): hold the paste queue per session (#156)`

**Acceptance criteria:**
- [ ] `packages/image-paste/src/index.ts` contains no module-scope `let`/`var` (verifiable with
      `grep -n "^let \|^var " packages/image-paste/src/index.ts` → no output).
- [ ] `registerImagePaste` returns `{ initSession, shutdown }`; `initImagePasteSession` and
      `shutdownImagePaste` no longer exist as exports.
- [ ] Both `session-isolation.test.ts` cases pass, and reverting `index.ts` alone (keeping the new
      tests) makes them fail — i.e. the test genuinely pins the fix.
- [ ] The full `packages/image-paste` suite passes; `npx tsc --noEmit` in the package is clean.
- [ ] The paste branch order (image → file paths → text), the 20MB guard, the mutex comment and ADR
      0030's superset comment are unchanged.

---

### Task 2: ui holds its refs and its splash ownership per session

**Parallel:** wave 1 — disjoint from Task 1 (`packages/image-paste/**`); `packages/ui` imports neither it nor meta.

**Context:**
The same bug, second victim, verified with a control: loading `packages/ui/src/index.ts` once and
registering it against two `pi` handles, then firing a child session's `session_shutdown` (`hasUI: false`,
exactly what `bindExtensions({})` produces), **killed the main session's border-spinner interval**
(`/tmp/ui156/probe2.mjs`; the control proves the instrumentation detects a real teardown). Three leaks:
`uiCtx` is assigned at `packages/ui/src/index.ts:169` **before** the `ctx.hasUI` check at `:183`, so a
UI-less child overwrites the ref that `:140`'s `targetCtx?.hasUI ? ctx : uiCtx` later falls back to;
`clearSpinInterval()` (`:154`), `spinFlag = false` (`:155`) and `uiRef.settled = true` (`:162`) run
unguarded; and `stopStartupListing()` (`:161`) clears the module-scope `frameTimer`/`revealTimer` in
`packages/ui/src/startup/index.ts:171-172`, so a child's shutdown also stops the parent's splash
animation. All of it disappears when the refs live in the `registerUI` closure.

**Files:**
- Modify: `packages/ui/src/index.ts`
- Create: `packages/ui/src/session-isolation.test.ts`

**What to implement:**

1. In `packages/ui/src/index.ts`, delete the module-scope bindings `uiRef` (`:60`), `uiCtx` (`:61`),
   `spinFlag` (`:63`), `spinInterval` (`:64`) and `styledTools` (`:74`), and declare each inside
   `registerUI` (the function starts at `:113`). They are read by `registerToolRenderers` (`:94`,
   `styledTools` at `:104,106`), so pass the value in as a parameter rather than reading a module
   binding: `function registerToolRenderers(pi: ExtensionAPI, styled: () => { bash: boolean; codemode: boolean }): void`.
   `registerToolRenderers` is called once per `registerUI` (`:123`), and the resolver it registers must
   read `styled()` **at resolve time** (not capture a snapshot), because `styledTools` is deliberately
   re-read every `session_start` so a settings change between sessions takes effect.
2. Make `stopStartupListing()` ownership-scoped. `packages/ui/src/index.ts` calls it from exactly two
   places today: the `session_shutdown` handler (`:161`) and the splash header component's `dispose()`
   (`:295`, which pi drives when it replaces or removes the header — that one is correct and stays).
   Add a closure flag, e.g. `let weInstalledTheSplash = false;`, set it `true` on the branch that
   installs the header (`ctx.ui.setHeader(headerFactory)`, `:301`), and `false` both on the two branches
   that hand the header back (`ctx.ui.setHeader(undefined)` at `:235` and `:241`) and inside the
   component's `dispose()` alongside the existing `stopStartupListing()` call. Then gate the
   `session_shutdown` call on it. `packages/ui/src/startup/index.ts` is NOT changed — its two timers
   stay module-scope and its own comment's claim ("a module pair of timers cannot leak a second
   animation") stays true; what changes is that ui stops asking that module-global pair to stop on a
   shutdown that does not own it. Note in the code why the flag exists and that `startup/index.ts` was
   left alone deliberately.
3. `session_shutdown` (`:139`) then becomes: keep the `targetCtx?.hasUI ? ctx : uiCtx` shape but with
   `uiCtx` now closure-scoped (so the fallback can only ever find *this* instance's ctx), keep the
   ADR 0031 comment about not asserting pi's defaults verbatim, and replace the unguarded tail with
   the same-instance calls: `clearSpinInterval(); spinFlag = false;` then the ownership-gated
   `stopStartupListing()`, then `if (uiRef) uiRef.settled = true;`. `clearSpinInterval` (`:76`) becomes
   a closure function over the closure `spinInterval`.
4. `session_start` (`:168`) keeps its exact behaviour — `uiCtx = ctx` first, then `loadUIConfig()`,
   then `styledTools = {...}`, then the `if (ctx.hasUI)` block — with the assignments now hitting
   closure bindings. Keep `onSpinInterval: (i) => { spinInterval = i; }` (`:355`) working against the
   closure binding. **Do not** change `docs/features/ui.md`'s documented behaviour (the working row is
   handed back only if we hid it; `setWorkingIndicator` is never called).
5. Create `packages/ui/src/session-isolation.test.ts`. Use `vi.useFakeTimers()` (the pattern in
   `startup-splash-gate.test.ts`; `index.test.ts` does not use fake timers and therefore cannot observe
   `spinInterval` at all — which is why this leak survived). Build two registrations against one module
   instance with the `makePi`/`makeCtx` idiom from `packages/ui/src/index.test.ts:130-152` (copy it; the
   `ui` object needs `setWorkingVisible`, `setHiddenThinkingLabel`, `setEditorComponent`, `setHeader`,
   `theme`, `notify`, `onTerminalInput` — a `Proxy` returning `vi.fn()` is acceptable). Then:

   ```ts
   // main: registerUI(mainPi); session_start(mainCtx hasUI:true); then arm the spinner the way
   //       index.test.ts:373-375 does — take the factory from
   //       ui.setEditorComponent.mock.calls[0]![0] and call it with a fake tui/EditorTheme/Keybindings.
   expect(vi.getTimerCount()).toBeGreaterThan(0);
   // child: registerUI(childPi); session_start(childCtx hasUI:false); session_shutdown(childCtx)
   expect(vi.getTimerCount()).toBe(<unchanged>);   // the child killed nothing
   // control: main's own session_shutdown DOES clear it
   ```

   Three `it`s: *"a foreign session's shutdown does not stop the main session's border spinner"* (assert
   the timer count is unchanged after the child's shutdown, then assert the control — main's own
   shutdown clears it to 0), and *"a UI-less session_start does not replace the main session's ctx"*
   (fire a `hasUI: false` `session_start` on the child registration, then shut the **main** session down
   and assert the main ctx's `setEditorComponent` was still called with `undefined` — the handback
   reaches the right ctx). Assert the control in the same test so a broken harness cannot pass. Add a
   third `it` covering the ownership flag's `dispose()` path, which no existing test combines with a
   foreign shutdown: install the splash on main, call the header component's `dispose()` (as
   `index.test.ts:373-381` does for the editor and `:812-824` does for the header — pi calls it when it
   replaces the header), **then** fire the child's `session_shutdown`, and assert nothing throws and no
   timer was cleared that main still owns. Do NOT
   stub `./startup/index.js` — `startup-splash-gate.test.ts:34` explains why ("no timer is armed" is
   only provable against the real module), and the same reasoning applies here.

**Steps:**
- [ ] Write `packages/ui/src/session-isolation.test.ts` against the current code and run
      `npx vitest run packages/ui`. Expect the spinner-isolation case to FAIL (the child's shutdown
      clears the timer) — that is the bug. If it passes, the harness did not arm a real timer: check
      that the factory handed to `setEditorComponent` was actually invoked.
- [ ] Implement steps 1-4.
- [ ] Run `npx vitest run packages/ui`. Existing files must stay green; pay particular attention to
      `startup-splash-gate.test.ts:427-497`, which drives **two sessions through one `registerUI`** and
      asserts `vi.getTimerCount()` drops to `0` on the second `session_start` — that path goes through
      the header factory, not `session_shutdown`, so the ownership flag must not stop the in-session
      `stopStartupListing()` calls at `:235`/`:241`/`:295`.
- [ ] Run `npx tsc --noEmit` from inside `packages/ui/`.
- [ ] Commit on this task's branch: `fix(ui): hold session refs and splash ownership per session (#156)`

**Acceptance criteria:**
- [ ] `grep -n "^let \|^var " packages/ui/src/index.ts` returns no output.
- [ ] The new test's spinner case passes and fails again if `session_shutdown`'s tail is made
      unconditional.
- [ ] `packages/ui`'s full suite green, including `startup-splash-gate.test.ts` and both
      `index.screen-mode.test.ts` / `index.test.ts` teardown blocks.
- [ ] `setWorkingIndicator` is still never called anywhere in the package (`grep -rn setWorkingIndicator packages/ui/src --include=*.ts | grep -v test` → no output), per ADR 0031.
- [ ] `packages/ui/src/startup/index.ts` is unchanged.

---

### Task 3: meta stops holding one session's teardown and one session's ctx

**Parallel:** none — wave 2. Modifies `meta/src/index.ts`, which imports Task 1's `ImagePasteSession`
return type; it cannot compile in a Wave 1 worktree.

**Context:**
`meta/src/index.ts` has two module-scope session refs. `let imagePasteShutdown` (`:35`) is assigned
inside `session_start` (`:170`) and called from the top-level `session_shutdown` (`:89`); it is
liveness-gated (`?.`) but **not owner-gated**, so a shutdown belonging to any session runs the teardown
that some other session installed. `let currentCtx` (`:39`) is assigned at `:133` and read by diff's
theme getter at `:163` — a child's `session_start` repoints it at the child's ctx, and after that child
is disposed every property read on the stale ctx throws (`core/extensions/runner.js:488-490`,
`assertActive`), which would surface as a crash inside diff's theme lookup. Neither can use a closure
because the teardown handler must stay top-level (AGENTS.md: nested `session_shutdown` registration
accumulates), so meta uses a session-keyed collection instead — see spec Decision 2.

**Files:**
- Modify: `meta/src/index.ts`
- Modify: `meta/src/factory-lifecycle.test.ts`
- Modify: `meta/src/pi-support-notice.test.ts`
- Create: `meta/src/session-isolation.test.ts`

**What to implement:**

1. Delete `let imagePasteShutdown` (`:35`) and `let currentCtx` (`:39`) and their comments. In their
   place, at module scope, add a keyed collection whose *binding* never changes:

   ```ts
   /**
    * Per-session state for extensions meta registers from inside `session_start`
    * but must tear down from a top-level `session_shutdown` handler (AGENTS.md).
    * Keyed by session id so a foreign session's shutdown can only ever reach its
    * own entry — a single stored ref is what let #156 kill a live session.
    */
   const imagePasteSessions = new Map<string, ImagePasteSession>();
   ```

   Import the handle type as a **type-only** import at the top of the file with the other type
   imports: `import type { ImagePasteSession } from "@pi-archimedes/image-paste";`. It must be
   `import type` — the package itself is deliberately lazy-loaded inside `session_start` (heavy deps
   must not load at startup), and a value import at the top would defeat that.
2. Inside the lazy-load `session_start` handler, key both entries on
   `ctx.sessionManager.getSessionId()` (sanctioned: `ReadonlySessionManager` picks `"getSessionId"` at
   `core/session-manager.d.ts:178`, returns `string`, stable within a session). In the `if (ipMod)`
   block (`:165-173`) replace the two lines with:

   ```ts
   const session = ipMod.registerImagePaste(pi);
   imagePasteSessions.set(sessionKey(ctx), session);
   session.initSession(ctx);
   ```

   Keep the call **order** `registerImagePaste` → `initSession` → `runNativePasteRestore` exactly —
   `factory-lifecycle.test.ts:338-353` asserts that order by `invocationCallOrder`, because the
   restore's settings reload invalidates ctx.

   **`sessionKey` is load-bearing and must be written, not elided.** Real pi always supplies a
   `sessionManager` (`ExtensionContext.sessionManager` is a required field,
   `core/extensions/types.d.ts:223`), but meta's existing test harnesses call the start handler with a
   bare `{}`, and `ctx.sessionManager.getSessionId()` on `{}` throws a `TypeError` — the failure would
   land in the *start* path, not the shutdown path, and would look like an unrelated crash. Add:

   ```ts
   /**
    * The key a session's state is stored under. `sessionManager` is required on a real
    * ctx; a harness ctx without one falls back to a single shared key rather than
    * throwing, so a missing session manager degrades to the old single-slot behaviour
    * instead of crashing session_start.
    */
   const UNKEYED_SESSION = "__unkeyed__";
   function sessionKey(ctx: ExtensionContext): string {
     return ctx.sessionManager?.getSessionId?.() ?? UNKEYED_SESSION;
   }
   ```
3. For diff (`:163`), drop the `currentCtx` indirection and close over the current call's ctx:
   `diffMod.registerDiffTools(pi, () => ctx.ui.theme, () => loadDiffConfig());`. No new collection is
   needed for diff — delete the `currentCtx` binding and its comment at `:36-38` entirely, and if the
   `if (diffMod)` block's comment still claims the ref "survives /reload, /new, /fork", correct it to
   say the getter now closes over the session that registered it.
4. In the top-level `session_shutdown` handler (`:83-91`), replace
   `imagePasteShutdown?.(); imagePasteShutdown = undefined;` with a keyed delete-and-call:

   ```ts
   const key = _ctx ? sessionKey(_ctx as ExtensionContext) : UNKEYED_SESSION;
   imagePasteSessions.get(key)?.shutdown();
   imagePasteSessions.delete(key);
   ```

   Using the same `sessionKey` helper keeps the start and shutdown paths symmetric: a harness ctx
   without a `sessionManager` resolves to `UNKEYED_SESSION` on both sides, so the existing tests that
   pass `{}` to both handlers keep working unchanged. A shutdown for a session that registered nothing
   (config toggled off mid-session) finds no entry and runs nothing — which is exactly what the old
   stale-ref guard was trying to achieve, now by construction. Guard the lookup against a missing
   second argument (`_ctx` may be `undefined`). `archPrintTimings()` stays where it is. Leave a comment
   stating that ownership is the key, and that this replaces the old liveness-only ref.
5. Update the mocks and assertions. `meta/src/factory-lifecycle.test.ts:79-83` and
   `meta/src/pi-support-notice.test.ts:70-74` both stub
   `{ registerImagePaste: vi.fn(), shutdownImagePaste: vi.fn(), initImagePasteSession: vi.fn() }`.
   Change both to return a handle with spies on its methods:

   ```ts
   vi.mock("@pi-archimedes/image-paste", () => ({
     registerImagePaste: vi.fn(() => ({ initSession: vi.fn(), shutdown: vi.fn() })),
   }));
   ```

   Then rewrite the six assertions that counted the old functions (`:196, :204, :212, :215, :224, :233`)
   and the ordering list at `:341-342` to count the handle's `initSession`/`shutdown` instead. Reach the
   spies through `vi.mocked(registerImagePaste).mock.results[0].value` (or a hoisted spy pair — either
   is fine, but do not assert on a function that no longer exists).
   **`initSession` must remain a distinct, separately-counted call after `registerImagePaste`** — the
   ordering claim is load-bearing, not decoration.
6. Give the "stale shutdown ref" test real teeth again. `factory-lifecycle.test.ts:218-234` builds its
   two sessions from **two `freshFactory()` calls**, i.e. two meta factory runs and two shutdown
   handlers, so a keyed map passes it trivially. Rewrite it to drive **two sessions through one
   `freshFactory()`**: give the harness a way to start a session with a caller-supplied session id
   (`startSession(ctx)` already forwards `ctx`, so pass `{ sessionManager: { getSessionId: () => "A" } }`
   and `…"B"`), then assert session A's shutdown calls A's `shutdown()` exactly once and leaves B's
   handle untouched, and that B's shutdown never re-runs A's.
7. Create `meta/src/session-isolation.test.ts`: with one meta factory run, start session A and session
   B (distinct ids), fire **B's** `session_shutdown`, and assert A's handle's `shutdown` was **not**
   called. Also assert the diff getter: after starting a UI-less session B, invoking the theme getter
   captured for session A still returns A's theme (`ctx.ui.theme`) and not B's — pass distinguishable
   `ui.theme` values in the two fake ctxs.

**Steps:**
- [ ] Write `meta/src/session-isolation.test.ts` and run `npx vitest run meta`. Expect it to fail
      against current code (A's teardown runs on B's shutdown). If the harness cannot distinguish two
      sessions, that is the bug this task exists to fix — make the ids distinct, do not drop the case.
- [ ] Implement steps 1-4 in `meta/src/index.ts`.
- [ ] Apply steps 5-6 to `factory-lifecycle.test.ts` and step 5's mock change to
      `pi-support-notice.test.ts`.
- [ ] Run `npx vitest run meta`. The `startRcCount === 2` assertion (`:246-250`) must still hold — this
      task adds no `pi.on("session_start", …)`.
- [ ] Run `npx tsc --noEmit` from inside `meta/`. This is where Task 1's dangling
      `initImagePasteSession` import errors must disappear.
- [ ] Commit on this task's branch: `fix(meta): key per-session extension state by session id (#156)`

**Acceptance criteria:**
- [ ] `grep -n "^let \|^var " meta/src/index.ts` returns no output.
- [ ] A shutdown for session B never invokes session A's `shutdown()`; proven by a test that drives two
      sessions through one meta factory run.
- [ ] `currentCtx` is gone; diff's theme getter closes over the registering session's ctx.
- [ ] `npx vitest run meta` green, including the rewritten stale-ref test and `startRcCount === 2`.
- [ ] `npx tsc --noEmit` in `meta/` clean, with Task 1's API in place.

---

### Task 4: make the rule mechanical, and write it down

**Parallel:** none — wave 3. Its acceptance criterion is a green guard over the fixed tree, so it needs
Tasks 1-3 present.

**Context:**
Three of the four exposed packages were caught by reading, not by any test, and the suite's own
`packages/subagent` cannot trigger the bug at all (it forks a separate process), which is why #156
shipped. The suite already has the right mechanism twice over: `packages/core/src/log-discipline.test.ts`
and `packages/core/src/screen-mode-discipline.test.ts` walk every `packages/*/src` plus `meta/src` and
fail on a pattern, with a reasoned allow-list. This task adds the third, plus the documentation the rule
needs to survive.

**Files:**
- Create: `packages/core/src/session-state-discipline.test.ts`
- Create: `docs/features/session-state.md`
- Modify: `AGENTS.md`
- Modify: `docs/features/image-paste.md`
- Modify: `docs/features/ui.md`

**What to implement:**

1. Create `packages/core/src/session-state-discipline.test.ts` by copying the walk verbatim from
   `packages/core/src/screen-mode-discipline.test.ts` (`REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))`,
   `sourceDirs()`, `collectSourceFiles()`, the `ViolationRule`/`AllowEntry` interfaces with
   `{ file, line, reason }`, and `isAllowed` matching on **file + exact trimmed line** so a new
   violation in an exempt file still fails). Its four `it`s follow the same shape: anti-vacuity walk,
   the guard, pattern liveness, allow-list hygiene.
2. Implement the rule as **two-hop assignment reachability**, not "declared at module scope". For each
   scanned file: collect module-scope `let`/`var` names (`/^(?:export\s+)?(?:let|var)\s+(\w+)/m`); find
   each `pi.on("session_start"|"session_shutdown"|"session_before_switch"|"turn_start", …)` handler body
   by brace-matching; a name is a violation if it is assigned (`(?<![\w.])name\s*=[^=]`) inside a handler
   body **or** inside the body of a function that a handler body calls directly. Report as
   `` `${file}:${line} [${rule}] ${text}` ``. The second hop is mandatory — `image-paste`'s `_queue` is
   assigned inside `initImagePasteSession`, one call away from the handler, and a one-hop rule would
   have missed the shipped bug.
3. Anti-vacuity must include the historical case: assert the rule's matcher, applied to a fixture string
   reproducing the old image-paste shape (`let _queue: … | null = null;` + a handler body calling
   `shutdownQueue()` + `function shutdownQueue() { _queue = null; }`), yields exactly one violation.
   Pair it with the Decision-2 escape case, and make the escape case **enter the collector**: a
   module-scope **`let sessions = new Map()`** whose handler body only ever calls
   `sessions.set(...)` / `sessions.delete(...)` and never assigns `sessions =` must yield zero
   violations. (A `const` Map would also yield zero, but only because `const` is outside the collector's
   class — that version proves nothing about the assignment test, so the `let`-Map is the one that
   carries the load: it is exactly meta's post-fix shape, and it is what proves "contents change,
   binding doesn't" is a real escape and not a collector artifact.) Add a third fixture: a `let`
   assigned only outside any handler — zero violations.
4. Allow-list: the guard reports the **declaration line** of each offending binding, so pin entries to
   declaration lines, not assignment sites. Exactly three entries (notify has two bindings), each
   matching file + exact trimmed line, each with a `reason` naming the deferred follow-up:
   - `packages/notify/src/index.ts:197` — `let notifyTimer`: a foreign shutdown cancels the live
     session's pending delayed notification. Minor; deferred.
   - `packages/notify/src/index.ts:198` — `let pendingTrigger`: same mechanism, same deferral.
   - `packages/diff/src/index.ts:44` — `let _readConfig`: assigned at `:138` inside `registerDiffTools`,
     which the composed path re-runs per `session_start` with an equivalent value; deferred.
   Enforce in the hygiene test that every entry's reason is non-empty and contains the token
   `follow-up:`, so an exemption without a removal point fails the guard.
   `packages/core/src/bridge/events.ts:38` (`sessionCtx`) and `packages/ui/src/startup/index.ts:171-172`
   (`frameTimer`/`revealTimer`) **must not need entries**, and the guard's header comment must name both
   as intentional escapes and say why: the rule is **intra-file**, and both assignment paths cross a
   module boundary — `bridge/index.ts:150`'s `session_start` handler calls `events.onSessionStart(ctx)`
   (`events.ts:65-66`), which is where `sessionCtx` is written; `ui/src/index.ts:161`'s
   `session_shutdown` calls `stopStartupListing()`, which clears the timers declared in the *startup*
   module. Both are legitimate on their own merits (`stop()` is idempotent and generation-guarded by
   design; the startup module's own comment explains why a module pair of timers cannot leak a second
   animation), but the header comment must state plainly that **this is a blind spot, not coverage**:
   the moment any of the four packages moves an assignment one module boundary away, the guard goes
   green over the bug. Name a third blind spot in the same comment — an assignment inside a closure a
   handler passes elsewhere (image-paste's `registerShortcut` callback, which assigned `_pasting`
   pre-fix) is not followed either, because the callback is not a `pi.on` handler body; that is why the
   anti-vacuity fixture uses a named directly-called function rather than a passed closure. If either
   file *does* need an entry, the rule has changed shape — stop and report rather than widening it.
5. Create `docs/features/session-state.md` (`status: live`, `last-verified`) stating the rule in
   present tense: pi caches the extension module per process and re-runs the factory with a fresh `pi`
   per session, therefore per-session state belongs in the `register()` closure; `ctx` is per-`emit()`
   so it is not a map key; `ctx.sessionManager.getSessionId()` is the identity when one is needed;
   `ctx.hasUI` answers "is there a dialog-capable UI" and is `true` in RPC mode, so it is not a session
   guard; `meta` uses a session-keyed `const` Map and why. Cite `docs/research/foreign-session-shutdown-destroys-module-state.md`.
6. Add an **Event Handlers** bullet to `AGENTS.md` (the section that already carries the
   nested-registration rule): never keep per-session state at module scope — pi reuses one module
   instance across sessions in a process, so a `session_shutdown` belonging to another session will
   clear it (#156, guard at `packages/core/src/session-state-discipline.test.ts`, rule in
   `docs/features/session-state.md`). Add `docs/features/session-state.md` to nothing else — no index.
7. Update `docs/features/image-paste.md` and `docs/features/ui.md` wherever they describe the queue or
   the spinner/splash lifecycle as module-level, so each matches the new ownership. Keep every existing
   behavioural claim (ADR 0030's superset branch order; ADR 0031's hand-back-only-what-we-took) intact.

**Steps:**
- [ ] Write the guard test and run `npx vitest run packages/core`. Expect it to report **only** the three
      allow-listed entries (`notify:197`, `notify:198`, `diff:44`). If it reports `packages/image-paste`,
      `packages/ui` or `meta`, a Task 1-3 fix is incomplete — fix that, do not add an allow-list entry.
- [ ] Run the liveness fixture check (`npx vitest run packages/core/src/session-state-discipline.test.ts`)
      and confirm the historical image-paste shape is caught **and** the `let`-Map-mutated-by-`.set()`
      escape case yields zero violations.
- [ ] Write the docs (steps 5-7) and re-read `docs/features/ui.md`'s spinner paragraph to confirm the
      ownership change is described where the shutdown behaviour is described.
- [ ] Run `pnpm test` from the repo root and `pnpm -r exec -- tsc --noEmit`. Both must be green.
- [ ] Open follow-up cards for the two allow-listed packages (notify, diff) and put their identifiers
      in all three allow-list reasons.
- [ ] Commit on this task's branch: `test(core): guard against module-scope session state (#156)`

**Acceptance criteria:**
- [ ] `pnpm test` green; the guard's violation list equals the three-entry allow-list exactly.
- [ ] Reverting any one of Tasks 1-3's source changes makes the guard fail (spot-check image-paste).
- [ ] The liveness fixture proves the rule catches a one-call-indirect assignment and does not flag a
      `const` Map keyed by session id.
- [ ] Every allow-list entry names a `follow-up:` reference; none was added for image-paste, ui, or meta.
- [ ] `docs/features/session-state.md` exists with `status: live`, and `AGENTS.md` carries the rule.
