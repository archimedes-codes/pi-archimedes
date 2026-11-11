---
status: current
last-verified: 2026-11-11
verified-by: code research against pi 1.5.0 dist + executed harnesses + @tintinweb/pi-subagents 0.23.1/0.23.2 tarballs — 5 angles, 1 web pass, 2026-11-11
task: tsk_a86f1a40-3fdf-4989-ae79-87e3de0e50e7
---

# Foreign `session_shutdown` destroys another live session's module state (#156)

Research report, not a fix. Evidence for issue [#156](https://github.com/danielcherubini/pi-archimedes/issues/156)
and the scope of its remedy.

**Settled question:** is #156's root cause real, and which fix should `specify` turn into a
spec — scoped to `image-paste`, or to every suite package that holds per-session state at module
scope?

Citations: `path:line` against the **installed** host runtime
`/home/daniel/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist` (1.5.0, per
`package.json:3`) unless marked otherwise. Claims are marked **FACT** (read at a cited line, or
observed in a run), **INFER** (reasoned from facts), or **GAP** (could not verify).

Companion: [angle5-upstream-ecosystem-per-session-state.md](angle5-upstream-ecosystem-per-session-state.md)
carries the extended upstream/ecosystem census (pi issues, changelog archaeology, the extension
population) behind §7 and §8. This report is self-contained; that one is the depth. (That file is
untracked as of writing — it came from a parallel session — so the link is local-only until it lands.)

## Executive summary

1. **The bug is ours and the reporter's diagnosis is correct.** `_ctx`/`_queue`/`_pasting` are
   module-scope; an unguarded `session_shutdown` handler nulls them; the paste key then returns
   before touching the clipboard. FACT — reproduced.
2. **The reporter's trigger is real.** `@tintinweb/pi-subagents` — the version they named — matches
   their line numbers exactly, and the current release is byte-identical in the same files. FACT.
3. **`image-paste` is not the only victim.** `packages/ui` loses the live session's border spinner
   on a foreign shutdown (verified with a control), and `meta`'s shutdown ref is liveness-gated but
   not owner-gated. FACT.
4. **A tempting fix cannot work.** `ctx` is constructed per *event*, not per session, so a `WeakMap`
   keyed on `ctx` gains an entry per event and never finds the session's. FACT.
5. **A second tempting guard is unsound.** `!ctx.hasUI` is `uiContext !== noOpUIContext`, and is
   `true` under `--mode rpc`. It happens to work for this trigger by luck. FACT.
6. **pi's own docs already prescribe the correct pattern** — factory-closure state, reset in
   `session_start`, idempotent shutdown — and there is **no** per-session store on `pi` or `ctx`.
   The suite's own `ask`/`todo`/`session-name`/`footer` already follow it; the four above do not.

## 1. Root cause in our code

All line numbers are `packages/image-paste/src/index.ts`, verified **byte-identical** to published
`@pi-archimedes/image-paste@2.13.0` (the version the reporter ran) by `git show v2.13.0:… | diff`
against the working tree. FACT.

| What | Where | Note |
|---|---|---|
| `_ctx`, `_queue`, `_pasting` at module scope | `:176-178` | one instance per **process**, not per session |
| Silent bail-out | `:210` | `if (_pasting) return; if (!_queue \|\| !ctx.hasUI) return;` — no notify, no `diag` |
| State install | `:303-306` | `initImagePasteSession(ctx)` assigns `_ctx` **and** `_queue` |
| State destroy | `:309-313` | `shutdownImagePaste()` nulls both, resets the mutex |
| Unguarded wiring | `:334`, `:347` | `session_start` → init, `session_shutdown` → destroy; neither asks *which* session |

The `input` handler repeats the same shape at `:237-251` (`if (!_queue || !_queue.markers.length || !_ctx)`
→ `continue`), which is the second symptom: a queued image is dropped rather than attached.

## 2. Why the mechanism is inevitable: pi's instance model

- **The factory is cached; the module is not re-imported.** `extensionCache` is keyed by extension
  path under a `{cwd, generation}` token — `core/extensions/loader.js:90-104, 461-470, 491`. A cache
  hit skips the import, so **module-scope state survives a session switch**. FACT.
- **The factory is re-invoked per session with a brand-new `pi`.** `initializeExtension` calls
  `createExtensionAPI(...)` then `factory(load.api)` — `loader.js:516-517` — and `createExtensionAPI`
  builds a fresh `const api = {…}` literal every call (`loader.js:215`). Reached per session via
  `agent-session-runtime.js:161` → `main.js:599-609` → `agent-session-services.js:63-69` (a new
  `DefaultResourceLoader` each time). FACT.
- **Observed:** two loads of one file gave `factory invocations: 2`, `pi#1 === pi#2 ? false`,
  distinct `handlers` Maps, and a **0 ms** second import (cache hit). FACT — executed.
- **Consequence:** state captured in the factory closure is per-session; state hoisted to module
  scope is process-wide. This is the whole bug class. FACT.

## 3. `session_shutdown` carries no identity for the dying session

`SessionShutdownEvent` is exactly three fields — `type`, `reason`, `targetSessionFile?` — with
`reason: "quit" | "reload" | "new" | "resume" | "fork"` (`core/extensions/types.d.ts:656-660`).
FACT.

Three emission sites only:

| Site | Reasons | Trigger |
|---|---|---|
| `core/agent-session-runtime.js:102-113` `teardownCurrent` | `new`, `resume`, `fork` | `/new` (`interactive-mode.js:5886`), `/resume` (`:4862`), `/fork`/`/clone` (`:2668`/`:2673`), RPC `new_session` (`rpc-mode.js:336`), extension `ctx.newSession()` |
| `core/agent-session-runtime.js:296-303` `dispose()` | `quit` (hard-coded) | Ctrl+D/`/quit` (`:3540`, `:2735`), SIGHUP/SIGTERM (`:3644-3661`), RPC exit |
| `core/agent-session.js:3019` `reload()` | `reload` (hard-coded) | `/reload` (`:5437`) |

FACT. Two consequences that matter:

- **There is no session id in the payload.** `targetSessionFile` names the *destination*, and is
  `undefined` for `quit`/`reload`. A handler cannot tell whose shutdown it is **from the event**.
- **`reason: "quit"` is ambiguous.** A third-party child teardown emits the same `{type:
  "session_shutdown", reason: "quit"}` as a real process quit — which is exactly what
  `@tintinweb/pi-subagents` does (§4). A guard on `reason` cannot separate them. FACT.

**But identity is available from `ctx`:** `emit()` builds the ctx from the runner being torn down
(`core/extensions/runner.js:813-814`), whose `sessionManager` is still the outgoing session's, so
`ctx.sessionManager.getSessionId()` resolves the dying session's id. Observed:
`event {reason:"new", targetSessionFile:"/sessions/new.jsonl"}` alongside
`ctx.sessionManager.getSessionId() -> OLD-SESSION-ID`. FACT.

## 4. The trigger, verified against the package the reporter actually named

`@tintinweb/pi-subagents@0.23.1` (npm tarball; **not** the same project as `pi-subagents` by Nico
Bailon — two extensions share the name, and one research pass audited the wrong one before the
error was caught). All citations verified in the published `dist/`; the current release **0.23.2 is
byte-identical** in `agent-manager.js`, `agent-runner.js` and `index.js` (`diff -q` → SAME), so the
finding is live today, not stale. FACT.

| Reporter claim | Verdict | Evidence |
|---|---|---|
| `agent-runner.js:1031-1038` `createAgentSession` + `bindExtensions` → child `session_start` | **HOLDS, lines exact** | `dist/agent-runner.js:1031` `createAgentSession(sessionOpts)`, `:1038` `await session.bindExtensions({...})`, comment says the bind exists so `session_start` fires |
| `agent-manager.js:139-160` `shutdownChildSession` emits `session_shutdown` | **HOLDS** | `:139` def; `:148` `runner.emit({ type: "session_shutdown", reason: "quit" })` raced against a timeout, then `session.dispose()` |
| `:218` 60 s cleanup timer; `:1353-1361` removes records >10 min old | **HOLDS** | `:218` `setInterval(() => this.cleanup(), 60_000)`; `:1354` `const cutoff = Date.now() - 10 * 60_000` |
| `:1311-1325` the removal path calls the shutdown | **HOLDS** | `removeRecord` → `:1325` `void shutdownChildSession(session)`, with the comment "this runs from the 60s cleanup timer" |
| `clearCompleted()` on `session_start` and session switch | **HOLDS** | `dist/index.js:788` (`session_start`) and `:1054` (`session_before_switch`) |
| Children run in-process with extensions enabled unless `isolated` | **HOLDS** | `agent-runner.js:609-615`: `const isolated = … ?? options.isolated; const extensions = isolated ? false : config.extensions;` and `noExtensions = extensions === false` (`:681`) |
| Main session loses paste ~10-11 min after a subagent finishes | **INFER, correct as arithmetic** | 60 s tick × >10 min age. Never stopwatch-measured by us (Gaps, item 2) |
| `isolated: true` prevents it | **HOLDS** | `isolated` ⇒ `extensions === false` ⇒ `noExtensions` ⇒ the child loads no user extensions ⇒ our handlers are never bound in that child |

Note the child calls `bindExtensions` with **no `uiContext`**, so the child's `ctx.hasUI` is `false`
(`runner.js:405`; `bindExtensions({})` leaves `_extensionUIContext` undefined → the `noOpUIContext`
sentinel). That is why the `!ctx.hasUI` guard *appears* to work here — and why it is luck (§7).

## 5. Blast radius: two more victims, one already-correct pattern

Audited by hand across all 13 packages (the dispatched auditor returned corrupted output).
`let`/`var` at module scope in non-test source, plus the lifecycle handler that mutates it:

| Package | State | Handler + guard | Impact |
|---|---|---|---|
| **image-paste** | `_ctx`/`_queue`/`_pasting` `index.ts:176-178` | `session_shutdown` `:347`, **no guard** | **breaks a feature silently** — alt+v dead, queued image dropped |
| **ui** | `uiCtx` `:61`, `spinInterval` `:64`, `spinFlag` `:63`, `uiRef` `:60` | `session_shutdown` `:139` — UI handback is guarded by `targetCtx?.hasUI` (`:140-141`), but `clearSpinInterval()` `:154`, `spinFlag = false` `:155`, `stopStartupListing()` `:160`, `uiRef.settled = true` `:162` are **unguarded**; and `uiCtx = ctx` is assigned at `:169` **before** the `hasUI` check at `:183`, so a UI-less child poisons the ref | **breaks a feature silently** — live spinner killed |
| **meta** | `imagePasteShutdown` `index.ts:35`, invoked `:89` | liveness-gated (`?.`) but **not owner-gated** — nothing records which session set the ref | **breaks a feature silently**, one layer up; this is the composed-suite path into the image-paste row |
| **notify** | `notifyTimer`/`pendingTrigger` `:197-198`, declared at module scope **outside** `registerNotify` (`:250`) | `session_shutdown` `:286` → `cancelPending()` | **minor but real** — a child's shutdown silently cancels the live session's pending delayed notification |
| **core (bridge)** | `refcount`/`generation`/`sessionCtx`/`pending` `bridge/events.ts:28-41`, stopped unconditionally at `bridge/index.ts:176-177` | `stop()` is idempotent and generation-guarded by design | **judged intentional** — process-wide by design. Not exercised in bridge mode (Gaps, item 3) |
| web | `cache` Map `storage/cache.ts:9`, cleared `index.ts:7-8` | unconditional | **harmless** — a recomputable 50-item LRU, cost only |
| sudo | `credentialCache` cleared `index.ts:26-31` | unconditional | **harmless / safe direction** — clearing a secret early is ADR 0010's intent |
| **ask** | `unsubscribes`, `currentCtx` **inside** `registerAsk` (`index.ts:7-8`) | per-instance | **already correct** |
| **todo** | `state`, `subagentTodos`, `currentCtx` **inside** `registerTodo` (`:14-17`) | per-instance | **already correct** |
| **session-name** | `hasNamed`, `failCount` **inside** `registerSessionName` (`:287-288`) | per-instance | **already correct** |
| **footer** | `unsubscribeVcsChange` **inside** `registerFooter` (`:38`) | per-instance | **already correct** |
| diff | config/theme getters + a ready flag (`index.ts:44,90`, `shiki.ts:13,45`) | no session lifecycle handler | **harmless** — process-wide config |
| subagent | no module-scope session state | — | **not exposed**; it forks a separate process (§6) |

**The four already-correct packages demonstrate the fix pattern inside our own suite**: state
declared inside `register()`, which pi re-invokes per session with a fresh `pi` (§2). The four
broken ones hoisted it to module scope.

### `packages/ui` verified experimentally

Harness `/tmp/ui156/probe2.mjs` loads the real `packages/ui/src/index.ts` once through pi 1.5.0's own
jiti, registers it against **two** `pi` objects (one module, two sessions — how pi runs it), arms the
border-spinner interval the way `HephaestusEditor`'s `onSpinInterval` does
(`packages/ui/src/editor/index.ts:141-142`), then fires a **child** session's `session_shutdown`
(`hasUI: false`, as `bindExtensions({})` produces):

```
editor factory captured? function
intervals created so far: 1
A) FOREIGN (child) shutdown killed: 1 [ 'THE LIVE SPINNER' ]
B) CONTROL main shutdown killed: 0 []
VERDICT: foreign shutdown kills the live session's spinner interval? true
```

The control matters: the same instrumentation detects the *main* session's own teardown
(`clearSpinInterval()` is unconditional), so the `1` above is not a harness artifact. FACT.

## 6. Scope of reachability: pi's own switching cannot strand you

Driven against the **real** pi 1.5.0 CLI in `--mode rpc`, one process, two sessions via the
`new_session` command, temp `PI_CODING_AGENT_DIR`:

```
MODULE-TOPLEVEL run #1      ← module top level executed exactly ONCE
IPMOD-SAME true             ← both sessions saw the SAME module instance
start reason=startup hasUI=true
shutdown reason=new         ← the OLD session's shutdown fires FIRST
start reason=new hasUI=true
```

The order is **`shutdown(old)` → `start(new)`** for `/new`, `/resume`, `/fork` and `/reload`
(`agent-session-runtime.js:102-165, 281-291`; `agent-session.js:3019, 3035-3044`), confirmed by
observation, not just reading. So a session switch leaves the *new* session functional: its own
`session_start` re-initialises the state after the old shutdown. FACT.

**Therefore the bug needs two overlapping runners** — a subordinate session torn down while the
parent stays live. Two consequences:

- **Our own `packages/subagent` can never trigger it.** It forks a separate `pi` process
  (`packages/subagent/src/execute.ts:108` `spawnSubagent`), and a different process has a different
  module instance. This is why the suite never caught #156 in its own tests — FACT.
- **A third-party in-process subagent extension is the practical trigger** — which is precisely
  `@tintinweb/pi-subagents` (§4).

## 7. Two tempting fixes that must be rejected

**A `WeakMap` keyed on `ctx` cannot work.** `emit()` builds a **fresh ctx per event**
(`core/extensions/runner.js:814`, and the same construction at `:760, 843, 865, 901, 958, 974, 1007,
1067, 1096, 1124, 1166, 1202`, plus `createToolContext` `:699` / `createCommandContext` `:728`).
Observed: `runner.createContext() !== runner.createContext()` on one runner. Such a map would gain
an entry per event and never find the session's own. A `WeakMap` keyed on **`ctx.sessionManager`**
*is* viable — one object per session, observed distinct. FACT.

**`!ctx.hasUI` is not a sound session guard.** It is `this.uiContext !== noOpUIContext`
(`runner.js:405`), exposed as a live getter (`:626-629`), and is **`true` under `--mode rpc`**
(`rpc-mode.js:231-232` passes a real `uiContext`) and for any host-supplied UI shim
(`agent-session.d.ts:169` `ExtensionBindings.uiContext` is public). It answers "is a dialog-capable
UI attached?", not "is this my session". It works for #156 only because `bindExtensions({})` passes
no `uiContext`. Use `ctx.mode === "tui"` for interactive-only work, and session identity for
ownership. FACT.

Usable identity keys, best first: (1) state in the factory closure; (2)
`ctx.sessionManager.getSessionId()` read at handler time — `session-manager.d.ts:253`, `uuidv7`,
stable within a session, distinct across `/new`/`/fork` (`session-manager.js:696, 722, 1289, 1319`);
(3) a `WeakMap` on `ctx.sessionManager`. Prefer the id over `getSessionFile()`, which returns
`string | undefined` and stays `undefined` until the session has a message
(`session-manager.js:786-799`). FACT; the file-path hazard is INFER from that gate.

## 8. What pi offers, and what upstream could change

- **No sanctioned per-session store exists.** `ExtensionContext` has 18 members and no store or index
  signature (`core/extensions/types.d.ts:232-272`); the live `pi` object has 33 keys and no state
  slot. The only sanctioned persistence is `pi.appendEntry()` (durable, session JSONL) and `pi.events`
  (process-wide pub/sub, no session scoping). FACT.
- **pi's docs already prescribe the pattern we violated.** `docs/extensions.md` §State Management
  keeps state in the factory closure and rebuilds it in `session_start`, and requires cleanup
  handlers to be **idempotent**; the same docs state that module-level variables remain shared across
  sessions. FACT.
- **Upstream knows the gap and has not solved it.** `earendil-works/pi` Discussion **#1546** (open)
  asks for a per-session store, noting extensions that need one must resort to `globalThis`. The
  loader/cache model is treated as intended; the cache is path-keyed by design, so per-session module
  instances would be an upstream redesign. FACT (via the companion report; the maintainer quote is
  second-hand — treat as INFER).
- **No version moved under us.** The extension factory cache is unchanged in shape from 0.80.x
  through 1.5.0, so this reproduces identically on our 1.4.0 type-check pin and on users' 1.5.0.
  FACT (companion report §6).

Remedies outside our package, evaluated but not chosen:

| Option | Owner | Feasibility |
|---|---|---|
| Harden our four packages | us | **high** — matches pi's documented contract, no upstream dependency |
| A distinct `session_shutdown` reason for child teardowns, or a runner marker | `@tintinweb/pi-subagents` | **medium** — they already race the emit and care about this path (`agent-manager.js:144-150`), but a reason alone still leaves the guard in our hands |
| Per-session module instances / a session-scoped store in pi | upstream pi | **low** — Discussion #1546 open, cache keyed by path by design |
| `isolated: true` on subagent definitions | the user | **works but not a fix** — it disables *all* extension tools in children, which is a capability loss, not a repair |

## 9. Regression-test shape

A vitest test can express the invariant without real pi. Draft at `/tmp/ip156/regression-draft.test.ts`
(deliberately outside the repo), run with a scratch config:

```
FAIL regression-draft.test.ts (2 tests | 2 failed)
  × foreign session's shutdown does not empty the main session's queue (alt+v keeps working)
    → expected 'continue' to be 'transform'
  × foreign session_start alone must not orphan the main session's queued image
    → expected 'continue' to be 'transform'
```

The repo's existing suite is green in the same run (`npx vitest run packages/image-paste` → 7 files,
285 tests), so these two fail for the bug and nothing else. FACT.

**One existing test pins the broken contract:** `packages/image-paste/src/default-export.test.ts:40`,
"resets the per-session queue on session_start and clears it on shutdown". Under a per-session fix a
shutdown must clear *its own* queue only, so that wording and its assertion must change with the fix.
FACT.

## Unresolved contradictions

- **Which `pi-subagents`.** Two unrelated extensions share the name. The reporter's citations resolve
  against `@tintinweb/pi-subagents` exactly and against `nicobailon`/`Bailon`'s `pi-subagents` not at
  all (that one spawns child *processes*, has no `agent-runner.js`, and no `isolated` option).
  Resolved in favour of the reporter: their lines match to the digit. The Bailon package's
  `globalThis`-keyed store with owner-token teardown is still the best third-party prior art.
- **Is the ~10-minute figure measured?** No source measured it. It is correct arithmetic over a 60 s
  tick and a 10-minute age cutoff. Reported as INFER throughout.

## Gaps

1. **No real TUI keypress.** RPC mode has no keyboard path, so the handler was invoked directly. The
   guard short-circuit was proven with counters (`hasUI` reads `1` → `0`, clipboard reader calls
   `2` → `0`), not by pressing alt+v.
2. **The 10-minute wall-clock path was never timed.** `@tintinweb/pi-subagents` was not installed; the
   state transition it triggers was reproduced, not the timer.
3. **`packages/core`'s bridge relay was not exercised in bridge mode.** Judged process-wide by design
   from its generation guards and `stop()` idempotence, not from a run.
4. **`packages/diff` and `packages/subagent` were read, not probed.** Both look unexposed (no session
   lifecycle handler; separate process respectively).
5. **Upstream issue numbers for pi** come from the companion report's web pass; the load-bearing ones
   (`#1546`, `#7816`) were not independently re-fetched here, and `#7816`'s maintainer quote is
   second-hand.
