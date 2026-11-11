import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  TUI,
  EditorTheme,
  Component,
} from "@earendil-works/pi-tui";

import { HephaestusEditor } from "./editor/index.js";
import {
  renderHeader,
  patchStartupListing,
  revealStartupListing,
  stopStartupListing,
  modelScopeSection,
  type ListingRef,
} from "./startup/index.js";
import type { ParsedSection } from "./startup/sections.js";
import { patchThinkingRenderer } from "./thinking/patch.js";
import { transformThinkingContent } from "./thinking/transform.js";
import {
  loadUIConfig,
  saveUIConfig,
  readQuietStartup,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  type UIConfig,
  type CoreConfig,
} from "./config.js";
import { reportPiSupport } from "@pi-archimedes/core/pi-support";
import { getUISettingsItems } from "./settings.js";
import { migrateCoreToUIConfig, migrateCompactThinkingToStyle, migrateRemovedToolPatch } from "./migration.js";
import { renderBashCall, renderBashResult } from "./bash/index.js";
import { renderCodemodeCall, renderCodemodeResult } from "./codemode/index.js";

// Re-exports
export { getUISettingsItems } from "./settings.js";
export {
  loadUIConfig,
  saveUIConfig,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  THINKING_STYLE_VALUES,
  TOOL_STYLE_VALUES,
  type UIConfig,
  type CoreConfig,
  type ThinkingStyle,
  type ToolStyle,
} from "./config.js";

// No module-scope session state (#156).
//
// pi caches an extension MODULE per process and re-invokes its factory with a
// fresh `pi` per session, so anything kept at module scope is shared by every
// session in the process — including a SUBORDINATE in-process session (a
// subagent child, bound with no uiContext, so `ctx.hasUI` is false). When that
// child is reaped its `session_shutdown` runs against this same module, and any
// ref it could write or clear was the LIVE main session's: the border spinner's
// interval cleared, `spinFlag` flipped off so the main session's own teardown
// stopped handing pi's working row back, and the splash's timers stopped through
// `stopStartupListing()`. Every one of those refs therefore lives in the
// `registerUI` closure below — one set per registration — which is what makes
// the child's teardown able to reach only the child's own state.

/**
 * Draw the bash row through pi's renderer resolution (ADR 0029).
 *
 * `registerToolRenderer()` was added in pi 1.0.1 precisely for presentation
 * overrides: it chooses how calls to a tool are drawn without registering the
 * tool, and `next()` hands the tool to the remaining resolvers and then to
 * whatever is registered. Off settings therefore give back pi's own row rather
 * than the previous arrangement — re-registering `bash` from
 * `createBashToolDefinition()` with our renderers bolted on — which also means
 * anything pi later adds to that tool cannot be silently dropped by us.
 */
function registerToolRenderers(
  pi: ExtensionAPI,
  styled: () => { bash: boolean; codemode: boolean },
): void {
  // Capability check, not a version wish: on a host without the API there is
  // nothing to resolve through, and pi's own rows stand in.
  if (typeof pi.registerToolRenderer !== "function") return;

  pi.registerToolRenderer((toolName, next) => {
    // `next()` is spread first so that whatever the built-in definition
    // declares besides the two renderers — `renderShell` is the one that matters
    // today — survives resolution instead of being silently dropped by us.
    //
    // `styled()` is read HERE rather than captured at registration: the resolver
    // is registered once per `registerUI` (pi keeps a list per extension, so
    // registering it from `session_start` would stack a duplicate on every
    // `/reload`), while the settings are deliberately re-read every
    // `session_start` so a change made between sessions takes effect. A getter,
    // not a value, is what keeps those two lifetimes compatible.
    const styledNow = styled();
    const ours =
      toolName === "bash" && styledNow.bash
        ? { renderCall: renderBashCall, renderResult: renderBashResult }
        : toolName === "codemode" && styledNow.codemode
          ? { renderCall: renderCodemodeCall, renderResult: renderCodemodeResult }
          : undefined;
    return ours ? { ...next(), ...ours } : next();
  });
}

export function registerUI(pi: ExtensionAPI): void {
  // Floor check before anything that can fail (ADR 0026): pi never installs or
  // solves peers, so the peer range below cannot warn anyone — the runtime
  // comparison against the host's own VERSION is the only thing that can. It
  // records a warning for meta to print once, aggregated; nothing here is
  // withheld on a below-floor host, because a `ui` that registered nothing
  // would make /plugins report an enabled package that did nothing.
  reportPiSupport("ui", "1.2.0");

  // ── This registration's session state (#156) ────────────────────────────────
  //
  // Everything a single session owns, held per `registerUI` call rather than at
  // module scope — see the note above `registerToolRenderers`.

  /** The splash ref this session installed (`undefined` = no splash on screen). */
  let uiRef: ListingRef | undefined;
  /** The ctx of the last `session_start` THIS registration handled. */
  let uiCtx: ExtensionContext | undefined;
  /** Whether this session hid pi's working row for the border spinner. */
  let spinFlag = false;
  /** The border spinner's interval, handed over by `HephaestusEditor`. */
  let spinInterval: ReturnType<typeof setInterval> | undefined;
  /**
   * Which Archimedes tool rows this session asks for, refreshed at every
   * `session_start` and read by the renderer resolver through the getter below
   * (ADR 0029).
   */
  let styledTools = { bash: false, codemode: false };
  /**
   * Whether THIS registration put the splash in pi's header slot and has not
   * handed it back — the ownership flag that scopes `stopStartupListing()`.
   *
   * `stopStartupListing()` stops the frame/reveal timers in
   * `./startup/index.js`, and those two stay module-scope there on purpose (see
   * the note in that file: one splash is on screen at a time, and pi disposes
   * the header it is replacing before it builds the next, so a module pair of
   * timers cannot leak a second animation). What must not be module-scope is the
   * *decision to ask that pair to stop*: on a shutdown that does not own the
   * splash — a subagent child reaped while the main session's logo is still
   * animating — calling it freezes the parent's animation mid-reveal. So the
   * call is gated on having installed the header ourselves, which is also why
   * `startup/index.ts` needed no change at all.
   */
  let weInstalledTheSplash = false;

  function clearSpinInterval(): void {
    if (spinInterval) {
      clearInterval(spinInterval);
      spinInterval = undefined;
    }
  }

  // Registered once per extension load, before any session exists (ADR 0029).
  registerToolRenderers(pi, () => styledTools);

  // One-time migration of any legacy core config to UI config
  migrateCoreToUIConfig();
  migrateCompactThinkingToStyle();
  // The toolStyle "Full" auto-expand patch was removed: drop any wrapper a
  // previous version left on the shared prototype (upgrade + /reload case).
  migrateRemovedToolPatch();

  pi.on("message_end", (event, _ctx) => {
    if (loadUIConfig().codeUnindent) {
      transformThinkingContent(event.message as any);
    }
  });

  // session_shutdown handler (top-level to prevent accumulation on /reload)
  pi.on("session_shutdown", (_event, ctx) => {
    // `uiCtx` is the closure ref of THIS registration, so the fallback can only
    // ever find the ctx this instance last saw — a foreign session's shutdown
    // cannot reach another instance's ctx through it (#156). The shape is kept
    // rather than reduced to `ctx`: pi hands a ctx built off its own runner, and
    // asserting its defaults verbatim is exactly what ADR 0031 refuses to do.
    const targetCtx = ctx?.hasUI ? ctx : uiCtx;
    if (targetCtx?.hasUI) {
      // Give back what this session took: the row we hid for the border spinner,
      // and only if we hid it. pi resets the indicator and the row's visibility
      // itself before the next session starts (`resetExtensionUI()`), and asserting
      // a default here would overwrite another extension's choice — so the
      // indicator is not touched on the way out either (#147, ADR 0031).
      if (spinFlag) targetCtx.ui.setWorkingVisible(true);
      // These two ARE ours to hand back: `labelText` is an archimedes setting and
      // the editor component is ours outright, so both calls undo state this
      // session demonstrably took rather than asserting a default.
      targetCtx.ui.setHiddenThinkingLabel(undefined);
      targetCtx.ui.setEditorComponent(undefined);
    }
    clearSpinInterval();
    spinFlag = false;

    // The splash: stop the frame/reveal timers, then freeze the ref so a late
    // render of a header still on screen cannot restart the animation. Only if
    // THIS session installed the header and has not handed it back — the timers
    // `stopStartupListing()` stops are module state in `startup/index.ts`, so an
    // unguarded call here let a subagent child's shutdown freeze the live main
    // session's logo mid-reveal (#156). Nothing else to undo — the startup
    // listing interception and the console.log patch this used to un-install are
    // gone (pi 1.x alignment, Task 8).
    if (weInstalledTheSplash) {
      stopStartupListing();
      weInstalledTheSplash = false;
    }
    if (uiRef) {
      uiRef.settled = true;
    }
  });

  // session_start handler
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    uiCtx = ctx;

    const config = loadUIConfig();
    const toolStyle = normalizeToolStyle(config.toolStyle);
    const minimal = toolStyle === "Minimal";

    // What the resolver answers with for this session (see `styledTools`).
    // `Minimal` = archimedes tool styling (the per-tool toggles fine-tune it);
    // `Native` = none of it, so pi's own rows stand everywhere.
    styledTools = {
      bash: minimal && config.bashToolStyling !== false,
      codemode: minimal && config.codemodeToolStyling !== false,
    };

    if (ctx.hasUI) {
      spinFlag = config.editorSpinBorder;

      // pi 1.x owns the startup screen, and the suite's splash is opt-in
      // (`archimedes.ui.startupSplash`, default off — the maintainer's call: keep
      // the code, flip the default). `ctx.scopedModels` is the model scope pi
      // would otherwise have printed, so nothing here scrapes pi's stdout or its
      // component tree any more (that was `startup/capture.ts` plus the
      // `addChild` interception in `patchStartupListing`, both removed here).
      //
      // The two settings are independent knobs, so their combination is stated
      // in full. `quietStartup` is pi's own (`false` = header + details,
      // `"header"` = header alone, `true` = nothing);
      // `startupSplash` is ours (off = we never install a header).
      //
      //   startupSplash   quietStartup   what the header slot gets      timers
      //   -------------   ------------   ----------------------------   ------
      //   false (default) false          pi's own header                none
      //   false (default) "header"       pi's own header                none
      //   false (default) true           pi's own (empty) header        none
      //   true            false          our splash (+ `[Models]` if    armed
      //                                   any model is scoped)
      //   true            "header"       our splash, no scope           armed
      //   true            true           pi's own (empty) header        none
      //
      // Off wins outright: with the splash off we hand the header back to pi
      // whatever `quietStartup` says, and pi's own setting then decides what pi
      // draws — its header and resource listing, its header alone, or its empty
      // `Text("", 0, 0)` — exactly as it does with no archimedes loaded. Handing
      // it back through `setHeader(undefined)` rather than simply doing nothing
      // is what makes a splash left installed by an earlier session in the same
      // process (`/reload` after turning it off) give way: pi puts its
      // `builtInHeader` back in the slot (`setExtensionHeader()`,
      // interactive-mode.js:2006-2011).
      //
      // On means today's behaviour, unchanged. `startupSplash: true` with
      // `quietStartup: true` is the one row worth naming: pi asked for no header
      // at all, so the splash stands down and pi's silence stands — opting in to
      // the splash is not an instruction to overrule pi's own quiet startup, and
      // `quietStartup` keeps deciding whether the resource listing (and so our
      // `[Models]` row) shows. Pinned cell by cell in
      // `startup-splash-gate.test.ts`.
      //
      // `startupSplash` is ours, and read strictly: anything that is not the
      // literal `true` — a hand-edited `"true"`, a `1` — means off, the same way
      // core's `isConfigEnabled` refuses to guess at a boolean.
      const startupSplash = config.startupSplash === true;
      // pi's own answer, asked only when the splash is on: with it off we install
      // no header, so there is nothing for `quietStartup` to decide.
      const quietStartup = startupSplash ? readQuietStartup(pi) : undefined;

      if (!startupSplash) {
        ctx.ui.setHeader(undefined);
        uiRef = undefined;
        // The slot is pi's again (or was never ours) — this session owns no
        // splash, so its teardown must not stop the animation module's timers.
        weInstalledTheSplash = false;
      } else if (quietStartup === true) {
        // pi's own header is an empty component in this mode. Handing ours back
        // is what keeps that silence: a splash left installed from an earlier
        // session in the same process (`/reload` after a settings change) would
        // otherwise animate over it.
        ctx.ui.setHeader(undefined);
        uiRef = undefined;
        weInstalledTheSplash = false;
      } else {
        // What the splash reveals after the logo. The version row belongs to
        // the header itself; the model scope is a startup *detail*, so it
        // follows pi's own rule for the `Model scope:` line and the resource
        // listing: visible only when `quietStartup` is `false`.
        const sections: ParsedSection[] = [];
        const models = quietStartup === false ? modelScopeSection(ctx.scopedModels) : undefined;
        if (models) sections.push(models);

        // Set animated header
        uiRef = {
          sections: [],
          frame: 0,
          revealed: false,
          revealedAt: 0,
          scaffoldAt: 0,
          settled: false,
        };
        const ref = uiRef;
        const headerFactory = (tui: TUI, theme: Theme): Component & { dispose(): void } => {
          // Nothing here is sized by the screen: pi calls this factory again
          // whenever the header is replaced — a new session, `/reload` (which
          // goes through `resetExtensionUI()`), or any `setHeader()` — and never
          // for a `tuiMode` switch (`switchTuiMode()` re-mounts the components it
          // already has), so a per-screen measurement taken here would be the
          // measurement the header kept until the next replacement. The header
          // does not need one: it renders its own content on either screen
          // (`renderHeader`), which is both what keeps a frame-bounded viewport
          // usable (ADR 0027) and what leaves pi's listing directly below it.
          const comp: Component & { dispose(): void } = {
            // pi invalidates the component tree on every theme change
            // (`onThemeChange()` → `ui.invalidate()`) and from the theme file
            // watcher, and the splash's cached lines carry the theme's colours
            // — so this is the hook that keeps a finished splash from rendering
            // yesterday's palette for the rest of the session. The cache key is
            // the width it was drawn at, which a theme switch leaves alone.
            // Only the memo goes: this is a repaint, not an animation restart.
            invalidate(): void {
              delete ref.cachedLines;
              delete ref.cachedWidth;
            },
            render(width: number): string[] {
              return renderHeader(theme, ref, width);
            },
            // pi disposes the header it is replacing before it builds the next
            // one (`setExtensionHeader()` disposes, then calls the factory), so
            // this is where the splash's timers die on a `setHeader()`
            // replacement or a session restart — no stored renderer needed. A
            // `tuiMode` switch does not dispose: it re-mounts this same
            // component, whose timers then run until they settle themselves.
            dispose(): void {
              stopStartupListing();
              // We no longer own the animation: pi is replacing (or removing)
              // the header, so the timers are already stopped and a later
              // `session_shutdown` has nothing left to stop here.
              weInstalledTheSplash = false;
            },
          };
          patchStartupListing(tui, ref);
          revealStartupListing(tui, ref, sections);
          return comp;
        };
        ctx.ui.setHeader(headerFactory);
        // From here on this registration owns the splash: it is the one that put
        // the animation in pi's header slot, so it is the only one allowed to
        // stop it on the way out (`session_shutdown`, or `dispose()` above).
        weInstalledTheSplash = true;
      }

      clearSpinInterval();
      // One announcement, in one place. pi's working row writes "Working" above
      // the editor and our border spinner writes its label — `editorSpinLabel`
      // defaults to "Working" as well — into the editor's own top border, so with
      // both on screen the word appeared twice. The border is ours, so while it
      // spins the row is hidden through pi's own switch (`setWorkingVisible()`,
      // `types.d.ts:88`).
      //
      // Only the direction this setting asks for is written. `setWorkingIndicator`
      // is never called, and the row is never asserted visible: pi restores both
      // itself wherever they could have been altered (`resetExtensionUI()`:
      // `workingVisible = true` at `interactive-mode.js:1921`, `setWorkingIndicator()`
      // at `:1922`, reached by startup defaults and by `/new`, `/resume`, `/fork`
      // and `/reload`), and asserting either would overwrite another extension's
      // choice — pi's working-row setters are an unskeyed last-write-wins
      // (`:1831-1837`). Writing `setWorkingIndicator(undefined)` unconditionally is
      // how 2.11.1 deleted a user's customised spinner (#147, ADR 0031).
      //
      // Read per session rather than remembered: `editorSpinBorder` can change
      // between sessions, and every `pi` handle gets its own handler.
      if (spinFlag) ctx.ui.setWorkingVisible(false);

      // The word a collapsed thinking block shows is pi's own row, so the
      // setting is handed to pi rather than rebuilt here. An empty setting
      // hands the label back to pi's default.
      ctx.ui.setHiddenThinkingLabel(config.labelText.trim() || undefined);

      if (spinFlag) {
        // The border spinner lives in the editor frame, not in scrollback, so
        // it runs on either screen. The renderer is handed straight to the
        // editor and never kept by us, and idleness is read from `ctx` rather
        // than from the renderer, so a screen-mode switch cannot strand it.
        //
        // `ctx.isIdle()` is false from `before_agent_start` onward — i.e. from
        // the moment a run begins, not from the first token — which is exactly
        // the *Busy episode* boundary in `CONTEXT.md` (idle → working → idle),
        // so the spinner starting on the run's first tick is the behaviour the
        // term defines, not an early start.
        ctx.ui.setEditorComponent(
          (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
            const theme = ctx.ui.theme;
            return new HephaestusEditor(tui, editorTheme, keybindings, {
              getTheme: () => theme,
              isIdle: () => ctx.isIdle(),
              shutdown: () => ctx.shutdown(),
              spin: true,
              spinSpeed: config.editorSpinSpeed,
              spinStyle: config.editorSpinStyle,
              spinLabel: config.editorSpinLabel,
              onSpinInterval: (i) => {
                spinInterval = i;
              },
            });
          },
        );
      }

      patchThinkingRenderer(
        () => ctx.ui.theme,
        {
          labelText: config.labelText,
          labelColor: config.labelColor,
          autoCollapseThinking: config.autoCollapseThinking,
          thinkingStyle: normalizeThinkingStyle(config.thinkingStyle),
        },
        // The patch's one user-visible diagnostic (a skipped patch) goes to the
        // notification surface — the console is not a surface on either screen
        // mode, and a subagent child discards it.
        (message) => ctx.ui.notify(message, "warning"),
      );
    }
  });
}

export default function (pi: ExtensionAPI): void {
  registerUI(pi);
}
