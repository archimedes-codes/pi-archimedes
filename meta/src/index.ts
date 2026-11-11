import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// TYPE-ONLY on purpose: the package itself is lazy-loaded inside `session_start`
// (heavy deps must not load at startup) and a value import here would defeat that.
import type { ImagePasteSession } from "@pi-archimedes/image-paste";

import { time as archTime, print as archPrintTimings, reset as archResetTimings } from "@pi-archimedes/core/profiler";
import { diag, describeError } from "@pi-archimedes/core/log";
import { takePiSupportNotice } from "@pi-archimedes/core/pi-support";
import { registerCore } from "@pi-archimedes/core";
import { registerUI } from "@pi-archimedes/ui";
import { registerFooter } from "@pi-archimedes/footer";

// Mark when module finishes evaluating (before factory runs) for gap analysis
const _moduleEvalAt = Date.now();
// diff — lazy-loaded in session_start to avoid pulling @shikijs/cli at startup
// image-paste & subagent — also lazy-loaded below (heavy deps, only needed on use)
import { registerTodo } from "@pi-archimedes/todo";
import { registerAsk } from "@pi-archimedes/ask";
import { isPluginEnabled, migrateLegacyPluginsMap } from "./plugins.js";
import { registerNotify } from "@pi-archimedes/notify";
import { registerSessionName } from "@pi-archimedes/session-name";
import { registerSudo } from "@pi-archimedes/sudo";
// Light module from the image-paste package (no heavy deps) — the offer
// gates are self-contained, so it is statically imported and sequenced in
// the first-run session_start handler below, before the lazy-load.
// `runNativePasteRestore` is the composed-suite call site for the same module
// (ADR 0030 amendment — see the bottom of the lazy-load session_start handler).
import {
  offerKeybindingFix,
  runNativePasteRestore,
} from "@pi-archimedes/image-paste/keybinding-offer";
import { runOnboarding } from "./onboarding/index.js";
import { loadDiffConfig } from "./config.js";
import { openSettings } from "./settings.js"
import { registerPluginsCommand } from "./plugin-manager.js"

/**
 * Per-session state for extensions meta registers from inside `session_start`
 * but must tear down from a top-level `session_shutdown` handler (AGENTS.md).
 * Keyed by session id so a foreign session's shutdown can only ever reach its
 * own entry — a single stored ref is what let #156 kill a live session.
 */
const imagePasteSessions = new Map<string, ImagePasteSession>();

/**
 * The key a session's state is stored under. `sessionManager` is required on a real
 * ctx; a harness ctx without one falls back to a single shared key rather than
 * throwing, so a missing session manager degrades to the old single-slot behaviour
 * instead of crashing session_start.
 *
 * Both call sites — the `session_start` that stores and the `session_shutdown`
 * that deletes — must resolve the SAME session, or an entry is orphaned and a
 * live session's handle is dropped by the wrong teardown. pi guarantees that:
 * `/new`, `/resume`, `/fork` and `/reload` all emit `shutdown(old)` BEFORE
 * `start(new)` (research §6, observed against 1.5.0), and the shutdown's ctx is
 * built from the runner being torn down, so its `sessionManager` still reports
 * the dying session's id (research §3). Do not "simplify" either side to read
 * the id at a different moment than the other.
 */
const UNKEYED_SESSION = "__unkeyed__";
function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager?.getSessionId?.() ?? UNKEYED_SESSION;
}

export default function (pi: ExtensionAPI): void {
  // Must run before any isPluginEnabled gate evaluation: re-points the
  // legacy archimedes.plugins map onto per-package namespaces, once.
  migrateLegacyPluginsMap();
  archResetTimings();
  archTime(`factory start (module eval was ${Date.now() - _moduleEvalAt}ms ago)`);

  // Register all component extensions (static imports already compiled by jiti above)
  registerCore(pi);
  archTime("registerCore");
  if (isPluginEnabled("ui")) {
    registerUI(pi);
    archTime("registerUI");
  }
  if (isPluginEnabled("footer")) registerFooter(pi);
  archTime("registerFooter");

  // image-paste & subagent lazy-loaded in session_start below — not here

  // Register todo (lightweight, registers tool + bus listener)
  if (isPluginEnabled("todo")) registerTodo(pi);
  archTime("registerTodo");

  // Register ask tool
  if (isPluginEnabled("ask")) registerAsk(pi);
  archTime("registerAsk");

  // Register notify
  if (isPluginEnabled("notify")) registerNotify(pi);
  archTime("registerNotify");

  // Register session-name
  if (isPluginEnabled("session-name")) registerSessionName(pi);
  archTime("registerSessionName");

  // Register sudo (lightweight: tool + guard + /sudo command + lifecycle)
  if (isPluginEnabled("sudo")) registerSudo(pi);
  archTime("registerSudo");

  archTime("factory end");

  // session_shutdown handler (top-level to prevent accumulation on /reload)
  pi.on("session_shutdown", (_event, _ctx) => {
    // Ownership is the KEY, not the liveness of a stored ref: look up the entry
    // THIS session registered and drop only that one. This replaces the old
    // module-scope `imagePasteShutdown` ref, which any session's shutdown could
    // fire — that is what let a subordinate session's teardown destroy a live
    // session's state (#156). A session that registered nothing (config toggled
    // off mid-session via /plugins) finds no entry and runs nothing, so the
    // stale-ref guard the old code needed is now a property of the map.
    const key = _ctx ? sessionKey(_ctx as ExtensionContext) : UNKEYED_SESSION;
    imagePasteSessions.get(key)?.shutdown();
    imagePasteSessions.delete(key);
    archPrintTimings();
  });

  // First-run flows, sequenced in ONE handler (see the module docs in
  // packages/image-paste/src/keybinding-offer.ts and meta/src/onboarding/
  // index.ts): the keybinding offer (if any) fully resolves BEFORE the
  // onboarding overlay shows — no stacked first-run dialogs.
  //
  // Deliberately NOT gated with isPluginEnabled("image-paste"): that call
  // resolves to isConfigEnabled("archimedes.imagePaste") (ADR 0012), which
  // is exactly the same key the module's own gate 1 already checks — adding
  // a wrapper here would be a redundant duplicate of the identical check.
  // This handler runs unconditionally on every session_start; the offer's
  // gates (1, 1b, 2–4; and the onboarding's two) make it a no-op when not
  // applicable. Gate 1b is the one that keeps the two paste-key flows apart:
  // under one setting value the offer acts only while the suite will hold the
  // key and `runNativePasteRestore`, at the end of the registration handler
  // below, only while it will not — so a single session can never create
  // keybindings.json and empty it again (issue #133).
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // The offer may block on a user confirm; it must never fail session
    // startup — any throw is logged, never propagated.
    let reloaded = false;
    try {
      reloaded = await offerKeybindingFix(ctx);
    } catch (e) {
      diag("meta", `[archimedes] keybinding offer failed: ${describeError(e)}`);
    }
    // If the offer triggered a reload, the fresh session runs this handler
    // again (where the offer is a no-op — keybindings.json now exists), so
    // do NOT run the onboarding on the now-stale ctx.
    if (reloaded) return;
    void runOnboarding(ctx).catch((err) =>
      diag("meta", `[archimedes] onboarding failed: ${describeError(err)}`),
    );
  });
  archTime("first-run handler");

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    archTime(`session_start (factory was ${Date.now() - _moduleEvalAt}ms ago)`);

    // ── Parallel lazy-load all four packages (saves ~100ms vs sequential) ──
    const [diffMod, ipMod, saMod, webMod] = await Promise.all([
      isPluginEnabled("diff")
        ? import("@pi-archimedes/diff").catch((e) => { diag("meta", `[archimedes] diff load failed: ${describeError(e)}`); return null; })
        : Promise.resolve(null),
      isPluginEnabled("image-paste")
        ? import("@pi-archimedes/image-paste").catch((e) => { diag("meta", `[archimedes] image-paste load failed: ${describeError(e)}`); return null; })
        : Promise.resolve(null),
      isPluginEnabled("subagent")
        ? import("@pi-archimedes/subagent").catch((e) => { diag("meta", `[archimedes] subagent load failed: ${describeError(e)}`); return null; })
        : Promise.resolve(null),
      isPluginEnabled("web")
        ? import("@pi-archimedes/web").catch((e) => {
            diag("meta", `[archimedes] web load failed: ${describeError(e)}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    archTime("4 packages loaded in parallel");

    // Each session_start fires on a fresh Extension (pi creates a new
    // ExtensionRunner per session). Registration is safe to — and must —
    // run every time. The registeredLazy guard was removed because it
    // prevented subagent/diff/image-paste from being registered after
    // /new, /fork, /resume: jiti caches the compiled module, so the guard
    // persisted across sessions while each new session creates a fresh
    // Extension with empty tools/commands maps.
    if (diffMod) {
      // The theme getter closes over THIS call's ctx — the session that
      // registered it (it used to read a module-scope "current ctx" ref that
      // any other session's session_start could repoint, which after that
      // session was disposed threw on every property read; #156).
      diffMod.registerDiffTools(pi, () => ctx.ui.theme, () => loadDiffConfig());
    }
    if (ipMod) {
      // registerImagePaste calls pi.on("input", ...) and pi.registerShortcut()
      // on the current Extension. Since each session replacement creates a
      // new Extension with its own handler list, there is no accumulation.
      // The handle it returns is stored under THIS session's id, so only this
      // session's shutdown can reach its teardown (#156).
      const session = ipMod.registerImagePaste(pi);
      imagePasteSessions.set(sessionKey(ctx), session);
      // initSession must run every session_start (captures fresh ctx) and stay
      // AFTER registerImagePaste / BEFORE runNativePasteRestore — the restore's
      // settings reload invalidates ctx, so nothing may use it afterwards.
      session.initSession(ctx);
    }
    if (saMod) {
      saMod.registerSubagent(pi);
      saMod.registerAgentsCommand(pi);
    }
    if (webMod) {
      webMod.registerWeb(pi);
    }

    // One aggregated host-version notice, never one per package (ADR 0026).
    // Every package reports during its own registration — the ones above, and
    // `ui`/`footer`/… from the factory — so this is the only place the suite
    // shows it. Reading the notice spends it: a second `session_start` (`/new`,
    // `/fork`) or a `/reload` (fresh modules, same process, and the same pi
    // version — it cannot change without a restart) stays quiet. `notify` is a
    // no-op outside a UI, so `diag` records it too: headless runs and subagent
    // children have no surface to show, but they do have the log file.
    const piNotice = takePiSupportNotice();
    if (piNotice) {
      diag("meta", piNotice);
      ctx.ui?.notify?.(piNotice, "warning");
    }

    // ── Native-paste restoration (ADR 0030 amendment, 2026-10-13) ──
    // `archimedes.imagePaste.suppressNativePaste: false` hands ctrl+v back to
    // pi in two halves: this call deletes the suite's own
    // `app.clipboard.pasteImage` unbinding from
    // ~/.pi/agent/keybindings.json, and the gate inside `registerImagePaste`
    // (above) stops image-paste registering a shortcut for the key — without it
    // pi 1.2.0 keeps the extension shortcut and the restored binding never
    // runs. Gated on ipMod: the registration gate is what ADR 0012 permits (a
    // package never reads its own `enabled` flag), so a disabled image-paste
    // never reaches into the file. Deliberately the LAST thing in this handler —
    // a successful restore can call ctx.reload(), which invalidates this ctx, so
    // nothing may use it afterwards.
    if (ipMod) {
      try {
        await runNativePasteRestore(ctx);
      } catch (e) {
        diag("meta", `[archimedes] native paste restore failed: ${describeError(e)}`);
      }
    }
  });

  // Register /archimedes command
  pi.registerCommand("archimedes", {
    description: "Open Archimedes settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await openSettings(pi, ctx);
    },
  });

  // Register /plugins command (plugin manager — single home in plugin-manager.ts)
  registerPluginsCommand(pi);
  archTime("registerCommands");
}
