import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme } from "@earendil-works/pi-tui";

// ── One module instance, two sessions (#156) ────────────────────────────────
//
// pi caches an extension MODULE per process and re-invokes its factory with a
// fresh `pi` per session. Anything `registerUI` keeps at module scope is
// therefore shared by every session in the process, and a SUBORDINATE in-process
// session — a subagent child, bound with no uiContext, so `hasUI` is false —
// tears the LIVE main session's state down when it is reaped: its
// `session_shutdown` clears the spinner interval the main session's border
// spinner is running on, stops the main session's splash animation, and can hand
// back the main session's editor row through a ref the child overwrote.
//
// The three cases below drive TWO registrations against ONE module instance and
// fake the clock, because the damage is a timer that stops: `index.test.ts` runs
// on real timers and so cannot see the spinner handle at all — which is exactly
// why the leak survived it. `startup-splash-gate.test.ts` uses fake timers but
// stubs nothing in `./startup/index.js`, and neither does this file: "the timer
// is still armed" is only evidence when the real animation module armed it.

vi.mock("@pi-archimedes/core/settings-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-archimedes/core/settings-io")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    removeConfig: vi.fn(),
  };
});

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadUIConfig: vi.fn() };
});

// Not under test here, and both touch state outside this module (pi's thinking
// renderer prototype, message content).
vi.mock("./thinking/patch.js", () => ({ patchThinkingRenderer: vi.fn() }));
vi.mock("./thinking/transform.js", () => ({ transformThinkingContent: vi.fn() }));
vi.mock("./migration.js", () => ({
  migrateCoreToUIConfig: vi.fn(),
  migrateCompactThinkingToStyle: vi.fn(),
  migrateRemovedToolPatch: vi.fn(),
  UI_CONFIG_KEYS: [],
}));

import { registerUI } from "./index.js";
import { loadUIConfig, DEFAULT_UI_CONFIG, type UIConfig } from "./config.js";
import { stopStartupListing } from "./startup/index.js";

// ── Harness ─────────────────────────────────────────────────────────────────

/** What a session's `ui` surface must offer; everything else answers a no-op. */
interface UiSpies {
  setHeader: Mock;
  setEditorComponent: Mock;
  setWorkingVisible: Mock;
  setHiddenThinkingLabel: Mock;
  notify: Mock;
  onTerminalInput: Mock;
}

interface Session {
  /** The per-session `pi` handle pi builds for a runner. */
  pi: ExtensionAPI;
  /** The ctx pi hands that runner's handlers. */
  ctx: ExtensionContext;
  ui: UiSpies;
  start: (uiConfig?: Partial<UIConfig>) => void;
  /**
   * Fire `session_shutdown`. `withCtx` replaces the ctx pi hands the handler —
   * pass a UI-less one to model a shutdown that arrives after the UI context is
   * gone, which is the case the `uiCtx` fallback exists for.
   */
  shutdown: (withCtx?: unknown) => void;
}

/**
 * One registration + one session, driven the way pi drives it: `registerUI(pi)`
 * with a fresh `pi`, then `session_start` / `session_shutdown` with that
 * session's own ctx (`emit()` builds a ctx off the runner and passes it, so the
 * ctx a handler sees belongs to the session that emitted the event).
 */
function makeSession(hasUI: boolean): Session {
  const listeners: Record<string, ((event: any, ctx: any) => void)[]> = {};
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    registerTool: vi.fn(),
    registerToolRenderer: vi.fn(),
    // `quietStartup` is what the splash gate reads out of this; `{}` is pi's
    // default (`false` = header and details shown).
    getSettings: vi.fn(() => ({})),
  } as unknown as ExtensionAPI;

  const ui: UiSpies = {
    setHeader: vi.fn(),
    setEditorComponent: vi.fn(),
    setWorkingVisible: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
  };
  // The `ui` object pi hands a context is a fixed surface; anything this suite
  // has not spelled out answers an inert spy rather than throwing.
  const uiSurface = new Proxy(ui as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "theme") return theme;
      if (prop in target) return target[prop as string];
      return vi.fn();
    },
    has: () => true,
  });

  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: "/workspace/test-project",
    ui: uiSurface,
    isIdle: vi.fn(() => true),
    shutdown: vi.fn(),
    scopedModels: [],
  } as unknown as ExtensionContext;

  const fire = (
    event: string,
    config?: Partial<UIConfig>,
    eventCtx: unknown = ctx,
  ): void => {
    if (event === "session_start") {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        ...config,
      } as UIConfig);
    }
    for (const handler of listeners[event] ?? []) {
      handler({ type: event, reason: "quit" }, eventCtx);
    }
  };

  return {
    pi,
    ctx,
    ui,
    start: (config) => fire("session_start", config),
    shutdown: (eventCtx) => fire("session_shutdown", undefined, eventCtx),
  };
}

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  getBgAnsi: () => "",
} as unknown as Theme;

/** A renderer the editor and the splash can both be handed. */
function makeTui(): TUI & { requestRender: Mock } {
  return {
    terminal: { rows: 24, cols: 80 },
    requestRender: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as TUI & { requestRender: Mock };
}

/** Build the editor pi was handed, so the border spinner's interval is armed. */
function buildEditor(session: Session, tui: TUI): { dispose(): void } {
  const factory = session.ui.setEditorComponent.mock.calls[0]![0] as (
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
  ) => { dispose(): void };
  return factory(tui, { borderColor: (s: string) => s } as unknown as EditorTheme, {} as KeybindingsManager);
}

/** Build the header pi was handed, i.e. put the splash where pi puts it. */
function buildHeader(session: Session, tui: TUI): { dispose(): void } {
  const factory = session.ui.setHeader.mock.calls.at(-1)![0] as (
    tui: TUI,
    theme: Theme,
  ) => { dispose(): void };
  return factory(tui, theme);
}

describe("session isolation: one module instance, several sessions (#156)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // The splash's timers are module state in `startup/index.ts`; a test that
    // leaves one armed would leak it into the next file's timer counts.
    stopStartupListing();
    vi.useRealTimers();
  });

  it("a foreign session's shutdown does not stop the main session's border spinner", () => {
    // The main session: interactive, spinner on, no splash (so the ONLY timer in
    // the process is the border spinner's).
    const main = makeSession(true);
    registerUI(main.pi);
    main.start({ startupSplash: false, editorSpinBorder: true });

    const tui = makeTui();
    buildEditor(main, tui);
    const armed = vi.getTimerCount();
    expect(armed, "the harness armed no timer — the editor factory was never invoked").toBeGreaterThan(0);

    // A subagent child in the SAME process: registered through the same module,
    // bound with no uiContext (`hasUI: false`), and now reaped by its parent.
    const child = makeSession(false);
    registerUI(child.pi);
    child.start();
    child.shutdown();

    // The child's teardown killed nothing of the main session's.
    expect(vi.getTimerCount()).toBe(armed);

    // The control: the same shutdown on the session that OWNS the spinner does
    // clear it, so the assertion above is not passing because nothing was ever
    // armed or because the handler never runs.
    main.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a UI-less session_start does not replace the main session's ctx", () => {
    // Main: interactive, spinner on. It hid pi's working row and installed our
    // editor — both of which its own teardown has to hand back.
    const main = makeSession(true);
    registerUI(main.pi);
    main.start({ startupSplash: false, editorSpinBorder: true });
    buildEditor(main, makeTui());
    expect(main.ui.setWorkingVisible).toHaveBeenLastCalledWith(false);

    // The UI-less session starts (the subagent child's `session_start`), and is
    // then reaped. Its `session_start` is the assignment that, at module scope,
    // moved the ref every later handler falls back to.
    const child = makeSession(false);
    registerUI(child.pi);
    child.start();
    child.shutdown();

    // Nothing of the handback happened on the main ctx while the child was being
    // reaped — the child never took any of it.
    expect(main.ui.setEditorComponent).not.toHaveBeenCalledWith(undefined);
    expect(main.ui.setWorkingVisible).not.toHaveBeenCalledWith(true);

    // Now the main session's own shutdown: the handback reaches the main ctx,
    // and it still happens — the spinner was on when the child tore itself down,
    // which at module scope had flipped the shared "we hid the row" flag off.
    main.shutdown();
    expect(main.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    expect(main.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);

    // The same teardown arriving with a UI-less ctx (pi hands the ctx built off
    // its runner, so this is what a shutdown looks like once the UI context is
    // gone): the handler falls back to the ref it kept, and that ref has to be
    // THIS registration's main ctx. At module scope the child's `session_start`
    // had overwritten it, so the handback went to the child instead.
    const before = main.ui.setEditorComponent.mock.calls.length;
    main.shutdown({ hasUI: false, ui: main.ui, isIdle: () => true });
    expect(main.ui.setEditorComponent.mock.calls.length).toBe(before + 1);
    expect(main.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    // And it stayed off the child's ctx, which has nothing of ours to hand back.
    expect(child.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it("the splash's dispose() path survives a foreign shutdown, and the splash outlives one", () => {
    // Main with the splash on: pi's header slot holds our animated header, so
    // the real animation module has its frame + reveal timers armed.
    const main = makeSession(true);
    registerUI(main.pi);
    main.start({ startupSplash: true, editorSpinBorder: false });
    const tui = makeTui();
    const comp = buildHeader(main, tui);
    const armed = vi.getTimerCount();
    expect(armed, "the harness armed no splash timer — no header was built").toBeGreaterThan(0);

    const child = makeSession(false);
    registerUI(child.pi);
    child.start();

    // The child's shutdown must not stop an animation it never installed.
    child.shutdown();
    expect(vi.getTimerCount()).toBe(armed);

    // pi replaces or removes the header → the component's `dispose()` runs, and
    // that IS ours to act on: it stops the splash and records that we no longer
    // own it.
    expect(() => comp.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    // The plan's ordering, and the one no existing test combines: a foreign
    // shutdown AFTER our own dispose() handed the animation back. Nothing to
    // stop, nothing to throw.
    expect(() => child.shutdown()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    // And the main session's own teardown, with the splash already disposed, is
    // still safe.
    expect(() => main.shutdown()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
