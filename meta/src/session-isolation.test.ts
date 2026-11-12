import { describe, it, expect, vi, beforeEach } from "vitest";

// ── #156 at the meta level: one process, two sessions, no shared slot ───────
//
// pi caches an extension MODULE per process but re-invokes its factory with a
// fresh `pi` for every session, so meta runs its factory ONCE per process and
// every `pi.on("session_start" | "session_shutdown", …)` handler it registered
// then serves ALL sessions in that process. meta held two module-scope refs:
//
//   * `imagePasteShutdown` — one session's teardown function, called by the
//     top-level shutdown handler regardless of WHICH session was shutting down.
//     A UI-less subordinate session (a third-party subagent child) torn down
//     with `{type:"session_shutdown", reason:"quit"}` therefore destroyed the
//     MAIN session's image-paste state. Reproduced live against pi 1.5.0: the
//     main session's alt+v went from attaching `[Image #1]` to doing nothing.
//   * `currentCtx` — one session's ctx, read by diff's theme getter. A child's
//     session_start repointed it at the child; after that child was disposed,
//     every property read threw (runner.js `assertActive`), i.e. a crash inside
//     diff's theme lookup on the main session.
//
// Both are fixed by keying state on the session id instead of holding a single
// slot. This file drives TWO sessions through ONE meta factory run — the shape
// pi actually produces — which the existing per-factory-run tests cannot: a
// fresh factory per session gives each session its own module closure and so
// passes trivially.

// ── settings-io: in-memory store (mirrors factory-lifecycle.test.ts) ────────

vi.mock("@pi-archimedes/core/settings-io", () => {
  const store: Record<string, unknown> = {};
  return {
    loadConfig: vi.fn(
      (ns: string, defaults: object) =>
        ({ ...defaults, ...((store[ns] as object) ?? {}) }),
    ),
    saveConfig: vi.fn((ns: string, config: object) => {
      store[ns] = config;
    }),
    removeConfig: vi.fn((ns: string) => {
      delete store[ns];
    }),
    isConfigEnabled: vi.fn((ns: string) => {
      const cfg = (store[ns] ?? {}) as Record<string, unknown>;
      return cfg.enabled !== false;
    }),
    setConfigEnabled: vi.fn((ns: string, enabled: boolean) => {
      if (enabled) {
        const cfg = { ...((store[ns] as object) ?? {}) } as Record<string, unknown>;
        delete cfg.enabled;
        if (Object.keys(cfg).length === 0) delete store[ns];
        else store[ns] = cfg;
      } else {
        store[ns] = { ...((store[ns] as object) ?? {}), enabled: false };
      }
    }),
    // Exposed for test setup/teardown only
    __store: store,
  };
});

const settingsIo = await import("@pi-archimedes/core/settings-io");
const mockStore = (settingsIo as unknown as { __store: Record<string, unknown> }).__store;

// ── Every package the factory touches, so this stays a unit test ────────────

vi.mock("@pi-archimedes/core/profiler", () => ({
  time: vi.fn(),
  print: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@pi-archimedes/core/log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pi-archimedes/core/log")>();
  return { ...real, diag: vi.fn() };
});
vi.mock("@pi-archimedes/core", () => ({ registerCore: vi.fn() }));
vi.mock("@pi-archimedes/ui", () => ({ registerUI: vi.fn() }));
vi.mock("@pi-archimedes/footer", () => ({ registerFooter: vi.fn() }));
vi.mock("@pi-archimedes/todo", () => ({ registerTodo: vi.fn() }));
vi.mock("@pi-archimedes/ask", () => ({ registerAsk: vi.fn() }));
vi.mock("@pi-archimedes/notify", () => ({ registerNotify: vi.fn() }));
vi.mock("@pi-archimedes/session-name", () => ({ registerSessionName: vi.fn() }));
vi.mock("@pi-archimedes/sudo", () => ({ registerSudo: vi.fn() }));
vi.mock("@pi-archimedes/diff", () => ({
  registerDiffTools: vi.fn(),
}));
// image-paste is lazy-loaded inside session_start; the handle shape is the
// contract under test, so the mock hands back a handle with its own spies.
vi.mock("@pi-archimedes/image-paste", () => ({
  registerImagePaste: vi.fn(() => ({ initSession: vi.fn(), shutdown: vi.fn() })),
}));
vi.mock("@pi-archimedes/image-paste/keybinding-offer", () => ({
  offerKeybindingFix: vi.fn(async () => false),
  runNativePasteRestore: vi.fn(async () => ({ kind: "suppressed" })),
}));
vi.mock("@pi-archimedes/subagent", () => ({
  registerSubagent: vi.fn(),
  registerAgentsCommand: vi.fn(),
}));
vi.mock("@pi-archimedes/web", () => ({ registerWeb: vi.fn() }));

vi.mock("./config.js", () => ({ loadDiffConfig: vi.fn(() => ({})) }));
vi.mock("./settings.js", () => ({ openSettings: vi.fn() }));
vi.mock("./plugin-manager.js", () => ({ registerPluginsCommand: vi.fn() }));
vi.mock("./onboarding/index.js", () => ({ runOnboarding: vi.fn(async () => {}) }));

const { default: metaFactory } = await import("./index.js");
const { registerImagePaste } = await import("@pi-archimedes/image-paste");
const { registerDiffTools } = await import("@pi-archimedes/diff");

// ── Harness ─────────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

interface Handle {
  initSession: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

interface Harness {
  /** Fire the lazy-load session_start handler with a caller-supplied ctx. */
  startSession: (ctx: unknown) => Promise<unknown>;
  /** Fire the top-level session_shutdown handler with that session's ctx. */
  shutdownSession: (ctx: unknown) => unknown;
}

/**
 * ONE meta factory run — one process. Both sessions therefore share the module
 * scope exactly the way they share it under pi, which is the whole point.
 */
function oneFactoryRun(): Harness {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  metaFactory(pi as never);

  const startRcs = handlers["session_start"] ?? [];
  const shutdownRcs = handlers["session_shutdown"] ?? [];
  expect(startRcs.length).toBeGreaterThan(0);
  expect(shutdownRcs.length).toBeGreaterThan(0);
  const lazyStart = startRcs[startRcs.length - 1] as Handler;
  const shutdown = shutdownRcs[shutdownRcs.length - 1] as Handler;

  return {
    startSession: (ctx: unknown) => lazyStart(undefined, ctx) as Promise<unknown>,
    shutdownSession: (ctx: unknown) => shutdown(undefined, ctx),
  };
}

/**
 * A session exactly as pi hands one to a handler: an id the state can be keyed
 * on (`ctx.sessionManager.getSessionId()`, required on a real ctx and stable
 * within a session) and a distinguishable theme so a getter can be proven to
 * answer for THIS session and not for whichever session ran last.
 *
 * `dispose()` mirrors pi's `ExtensionRunner.invalidate()` + `assertActive()`:
 * after a session is replaced or torn down, every ctx property goes through a
 * getter that throws (`get ui() { runner.assertActive(); … }`, runner.js). That
 * is what made the old shared `currentCtx` a crash rather than a wrong answer.
 *
 * A UI-less session (a subagent child) still gets pi's `noOpUIContext`, which
 * does expose a `theme` — `hasUI: false` does NOT mean `ctx.ui` is undefined.
 */
function sessionCtx(id: string, theme: string, opts: { hasUI?: boolean } = {}) {
  let active = true;
  const raw = {
    hasUI: opts.hasUI ?? true,
    mode: (opts.hasUI ?? true) ? "tui" : "print",
    cwd: "/tmp",
    ui: { theme, notify: vi.fn() },
    sessionManager: { getSessionId: () => id },
    dispose: () => {
      active = false;
    },
  };
  const ctx = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "dispose") return Reflect.get(target, prop, receiver);
      if (!active) throw new Error(`Session ${id} is disposed (assertActive)`);
      return Reflect.get(target, prop, receiver);
    },
  });
  return ctx;
}

/** The handle the nth `registerImagePaste` call returned. */
function handleForCall(index: number): Handle {
  const results = vi.mocked(registerImagePaste).mock.results;
  const result = results[index];
  if (!result) throw new Error(`registerImagePaste was called ${results.length} time(s), no call #${index}`);
  return result.value as Handle;
}

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  vi.clearAllMocks();
});

describe("per-session isolation across one meta factory run (#156)", () => {
  it("a shutdown for session B never runs session A's image-paste teardown", async () => {
    const { startSession, shutdownSession } = oneFactoryRun();

    // Session A: the main, interactive session.
    await startSession(sessionCtx("session-A", "dark"));
    // Session B: a UI-less subordinate sharing the process (a subagent child).
    await startSession(sessionCtx("session-B", "light", { hasUI: false }));

    expect(vi.mocked(registerImagePaste)).toHaveBeenCalledTimes(2);
    const a = handleForCall(0);
    const b = handleForCall(1);
    expect(a.initSession).toHaveBeenCalledTimes(1);
    expect(b.initSession).toHaveBeenCalledTimes(1);

    // B is torn down (`{type: "session_shutdown", reason: "quit"}` in real pi).
    shutdownSession(sessionCtx("session-B", "light", { hasUI: false }));

    // B's own teardown ran…
    expect(b.shutdown, "the shutting-down session's own teardown must still run").toHaveBeenCalledTimes(1);
    // …and A's handle is untouched — the bug ran whatever the last session had
    // installed, which silently took the MAIN session's paste key out of service.
    expect(
      a.shutdown,
      "#156: a foreign session's shutdown must not tear down a live session",
    ).not.toHaveBeenCalled();

    // B's shutdown is not repeatable either: a second one finds no entry.
    shutdownSession(sessionCtx("session-B", "light", { hasUI: false }));
    expect(b.shutdown).toHaveBeenCalledTimes(1);
    expect(a.shutdown).not.toHaveBeenCalled();
  });

  it("A's own shutdown still runs A's teardown after B has gone", async () => {
    const { startSession, shutdownSession } = oneFactoryRun();

    await startSession(sessionCtx("session-A", "dark"));
    await startSession(sessionCtx("session-B", "light", { hasUI: false }));
    const a = handleForCall(0);
    const b = handleForCall(1);

    shutdownSession(sessionCtx("session-B", "light", { hasUI: false }));
    shutdownSession(sessionCtx("session-A", "dark"));

    expect(a.shutdown).toHaveBeenCalledTimes(1);
    expect(b.shutdown).toHaveBeenCalledTimes(1);
  });

  it("diff's theme getter answers for the session that registered it, not the latest one", async () => {
    const { startSession } = oneFactoryRun();

    const ctxA = sessionCtx("session-A", "arch-dark");
    const ctxB = sessionCtx("session-B", "arch-light", { hasUI: false });

    await startSession(ctxA);
    await startSession(ctxB);

    expect(vi.mocked(registerDiffTools)).toHaveBeenCalledTimes(2);
    const getters = vi.mocked(registerDiffTools).mock.calls.map(
      (call) => (call as unknown as [unknown, () => unknown, unknown])[1],
    );

    // B is gone. Reading A's theme through the getter diff captured for A must
    // still answer — the old module-scope `currentCtx` pointed at B by then, so
    // this same read threw inside diff's theme lookup.
    ctxB.dispose();
    expect(getters[0]?.()).toBe("arch-dark");
    // B's own getter belongs to a disposed session; it is not what A's tools use.
    expect(() => getters[1]?.()).toThrow(/disposed/);

    // And a fresh session_start for A (a /new in the same process) still
    // captures A's theme — the newest registration is A's too, not B's.
    await startSession(ctxA);
    const thirdGetter = vi.mocked(registerDiffTools).mock.calls[2]?.[1] as () => unknown;
    expect(thirdGetter()).toBe("arch-dark");
  });
});
