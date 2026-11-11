---
status: live
last-verified: 2026-11-11
verified-by: "`npx vitest run packages/core/src/session-state-discipline.test.ts` → 4 passed; the guard's own violation census over every `packages/<name>/src` + `meta/src` (150 files) is exactly three bindings — `packages/notify/src/index.ts:197`, `:198`, `packages/diff/src/index.ts:44` — all allow-listed with a follow-up card, and `grep -rn 'pi\\.on(\"session_start\"\\|pi\\.on(\"session_shutdown\"\\|pi\\.on(\"session_before_switch\"\\|pi\\.on(\"turn_start\"' packages/*/src meta/src --include=*.ts | grep -v .test.ts` lists the 19 handler sites the guard reads. The ownership claims below were read from source: `packages/image-paste/src/index.ts` (the `ImagePasteSession` handle, `ctxRef`/`queue`/`pasting` inside `registerImagePaste`), `packages/ui/src/index.ts` (the closure refs and `weInstalledTheSplash`), `meta/src/index.ts` (`imagePasteSessions`, `sessionKey`), `packages/ask/src/index.ts:7-8`, `packages/todo/src/index.ts:14-17`, `packages/session-name/src/index.ts:287-288`, `packages/footer/src/index.ts:38`. The pi-side mechanism (module cached per process, factory re-invoked with a fresh `pi`, `ctx` rebuilt per `emit()`, `hasUI` true under RPC) is `docs/research/foreign-session-shutdown-destroys-module-state.md`'s, cited into pi 1.5.0's `dist/`; it was not re-measured against a live pi in this pass. Reverting `packages/image-paste/src/index.ts` to its pre-fix commit makes the guard report `packages/image-paste/src/index.ts:176-178`, which is the check that the guard is not decorative."
---

# Per-session state (`#156`)

## The rule

**Per-session state lives in the `register()` closure. Never at module scope.**

Pi caches an extension **module** per process — the loader's cache is keyed by extension path, so a cache hit skips the import and module-scope bindings survive a session switch — and then re-invokes the cached factory with a **fresh `pi`** for every session. The factory closure is therefore per-session for free; anything hoisted above it belongs to the process.

The failure that makes this a bug rather than a style preference: a subordinate **in-process** session — a third-party subagent child, bound with no `uiContext` — runs its `session_shutdown` against the same module instance the live parent session is using. Any module-scope binding that handler can write or clear is the live session's, and clearing it is silent. That is #156: `image-paste` lost its queue (the paste key returned before reading the clipboard), `ui` lost the border spinner's interval and its hand-back flag, and `meta`'s shutdown ref was liveness-gated but not owner-gated. All three shipped, and no test could see it — `packages/subagent`, the suite's own subagent package, **forks a separate process**, so a different module instance and no repro.

`ask` (`packages/ask/src/index.ts:7-8`), `todo` (`:14-17`), `session-name` (`:287-288`) and `footer` (`:38`) already kept their state inside `register()`; the three broken packages hoisted it. Pi's own `docs/extensions.md` §State Management prescribes the closure, states plainly that module-level variables stay shared across sessions, and requires teardown handlers to be idempotent.

## What is not a session key

- **`ctx` is not an identity.** pi builds a **fresh `ExtensionContext` per `emit()`**, not per session, so a `WeakMap` keyed on `ctx` gains an entry per event and never finds the session's. It is the tempting fix and it cannot work.
- **`ctx.hasUI` is not a session guard.** It is `uiContext !== noOpUIContext` — it answers *"is there a dialog-capable UI attached?"* — and it is **`true` in RPC mode**, and for any host-supplied UI shim. It appeared to work for #156 only because the child in the triggering package binds with no `uiContext`. Never use it to decide ownership; use `ctx.mode === "tui"` when the question is really "is this interactive".
- **`ctx.sessionManager.getSessionId()` is the identity** when one is needed: a `uuidv7`, stable within a session, distinct across `/new`/`/fork`, and — unlike `getSessionFile()` — always defined. Read it at handler time. The `session_shutdown` **event payload** carries no such field (`type`, `reason`, `targetSessionFile?` only), and `reason: "quit"` is ambiguous between a real quit and a child teardown, so a guard on the event cannot tell whose shutdown it is.

There is **no sanctioned per-session store** on `pi` or `ctx` (pi's only persistence is `pi.appendEntry()`, durable and session-scoped, and `pi.events`, a process-wide bus). Upstream tracks the gap in Discussion #1546 and has not closed it.

## The shapes that are correct

1. **Closure state, per registration** — the default. `registerImagePaste(pi)` creates `ctxRef`/`queue`/`pasting` inside itself and hands back an `ImagePasteSession` handle (`initSession(ctx)` / `shutdown()`), so whoever holds the handle can only reach the session that created it. Same for `packages/ui`, whose `uiRef`/`uiCtx`/`spinFlag`/`spinInterval`/`styledTools` live in `registerUI`'s closure.
2. **A session-keyed `const Map` at module scope** — `meta` only, and for a specific reason. meta registers image-paste from inside `session_start` (heavy deps stay lazy) but must tear it down from a **top-level** `session_shutdown` handler, because registering `session_shutdown` inside `session_start` accumulates handlers on every `/reload` (AGENTS.md's event-handler rule). A top-level handler cannot see a per-session closure, so `meta/src/index.ts` keeps `const imagePasteSessions = new Map<string, ImagePasteSession>()` and keys it with `sessionKey(ctx)` = `ctx.sessionManager.getSessionId()`. **Ownership is the key, not the liveness of a stored ref**: the shutdown handler looks up its own session's entry, calls `shutdown()` on it and `delete`s it — a session that registered nothing finds nothing, and a foreign session cannot reach another's entry. A `const` Map whose *contents* change is not the bug shape: the binding is never assigned, so no handler can repoint it at another session's state.
3. **Teardown that is idempotent and hands back only what it took** — see ADR 0031; `ui`'s `session_shutdown` restores the working row only `if (spinFlag)` and calls `stopStartupListing()` only when `weInstalledTheSplash` says this registration put the header there.

## What the guard checks, and where it is blind

`packages/core/src/session-state-discipline.test.ts` walks every `packages/<name>/src` and `meta/src` (the same walk as `log-discipline.test.ts` and `screen-mode-discipline.test.ts`) and flags a module-scope `let`/`var` whose **binding is assigned** from a session lifecycle path: inside a `pi.on("session_start" | "session_shutdown" | "session_before_switch" | "turn_start")` handler body, **or inside a function that handler body calls directly**. Two hops, not one: #156's assignment was `_queue = null` inside a named teardown function one call away from the handler, so a one-hop rule reads green over the bug that shipped. Mutating a binding's *contents* (`map.set()`, `arr.length = 0`, `obj.field = …`) is not an assignment to the binding, which is what makes shape 2 above a real escape rather than a collector artifact — the liveness test pins a **`let`** Map mutated through `.set()`/`.delete()` precisely because a `const` Map would pass without proving anything about the assignment test.

Three bindings are allow-listed today, each with a follow-up card: `notify`'s `notifyTimer`/`pendingTrigger` (a foreign shutdown cancels the live session's pending delayed notification — minor, deferred) and `diff`'s `_readConfig` (re-assigned per `session_start` with an equivalent value in the composed path — deferred).

**The guard is a blind spot, not coverage.** It is **intra-file** and it only follows **direct calls**, so:

- `core/src/bridge/index.ts:160`'s `session_start` handler writes `bridge/events.ts:38`'s `sessionCtx` — through `events.onSessionStart(ctx)`, one module away.
- `ui/src/index.ts:183`'s `session_shutdown` clears `ui/src/startup/index.ts:171-172`'s `frameTimer`/`revealTimer` — through `stopStartupListing()`, one module away.
- An assignment inside a closure a handler **passes elsewhere** (image-paste's `registerShortcut` callback, which assigned the paste mutex pre-fix) is not followed either, because the callback is not a `pi.on` handler body.

None of those three needs an allow-list entry, and both cross-boundary ones are legitimate on their own merits — `events.stop()` is idempotent and generation-guarded by design, and the startup module's own comment explains why one module pair of timers cannot leak a second animation. But the guard is green there because it **cannot see** them. Move any of those assignments one module boundary closer to its handler and the rule's coverage of it changes — in either direction, without a test failing to tell you. The process-wide caches the guard deliberately ignores (footer's git/jj/token-stat caches, `bridge/channel.ts`, `diff/src/shiki.ts`, `diff/src/ansi/codes.ts`, `diff/src/render/shared.ts`, `ui/src/thinking/theme.ts`) are out of scope for the same structural reason: no session handler assigns them.

## Follow-ups

- notify's timer/trigger pair and diff's config reader: the two deferred cards named in the guard's allow-list.
- Upstream: pi Discussion #1546 (a per-session store) and `@tintinweb/pi-subagents`, whose child teardown supplies the trigger. Neither is ours to change; `isolated: true` on a subagent definition avoids the bug only by disabling all extension tools in children, which is a capability loss, not a repair.

Companion: [`docs/research/foreign-session-shutdown-destroys-module-state.md`](../research/foreign-session-shutdown-destroys-module-state.md) carries the pi-source citations (loader cache, per-session factory call, per-`emit()` ctx, `hasUI` under RPC), the trigger verified against the package the reporter named, the blast-radius census across all 13 packages, and the `packages/ui` experiment with its control.
