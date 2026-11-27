/**
 * Index-level test: the bus consumer guarantee.
 *
 * The parent todo widget receives subagent todo state ONLY via the
 * TODOS_UPDATE bus event. These tests prove that whatever the producer
 * emits (legacy shapes, garbage) the consumer stored in `subagentTodos`
 * is always canonical — the widget can render real text and can never
 * print the string "undefined".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Events } from "@pi-archimedes/core/events";
import { registerTodo } from "./index.js";

/** Stands in for the host's `createEventBus()` (the `pi.events` contract). */
function fakeBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown): void {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      const subs = listeners.get(channel) ?? [];
      subs.push(handler);
      listeners.set(channel, subs);
      return () => {
        const current = listeners.get(channel) ?? [];
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      };
    },
  };
}

describe("todo index — bus consumer normalization", () => {
  const captured: Record<string, unknown> = {};
  const handlers: Record<string, Function> = {};
  const registered: { tool?: any; commands: Record<string, unknown> } = { commands: {} };

  /** The handle `registerTodo` subscribes on and the tool emits on. */
  const bus = fakeBus();

  const pi = {
    on(evt: string, fn: Function) {
      handlers[evt] = fn;
    },
    registerTool(tool: any) {
      registered.tool = tool;
    },
    registerCommand(name: string, def: unknown) {
      registered.commands[name] = def;
    },
    events: bus,
  } as unknown as ExtensionAPI;

  const ctx = {
    ui: {
      setWidget(id: string, component: unknown) {
        captured[id] = component;
      },
    },
    sessionManager: { getBranch: () => [] },
  } as any;

  // The widget calls theme.fg / theme.strikethrough; same behavior these
  // tests rely on (identity-ish, no ANSI) is enough to inspect the text.
  const theme: any = {
    fg: (_c: unknown, s: unknown) => String(s),
    strikethrough: (s: unknown) => String(s),
  };

  function renderLines(): string[] {
    // Read fresh on every render step — the factory can be replaced, or
    // self-cleared to undefined, between steps.
    const factory = captured["todo-list"] as
      | ((_tui: unknown, t: unknown) => { render(width: number): string[]; invalidate(): void })
      | undefined;
    expect(typeof factory).toBe("function");
    const comp = factory!(null, theme);
    return comp.render(200);
  }

  beforeAll(() => {
    registerTodo(pi as any);
  });

  it("normalizes a legacy subagent payload — renders real text, never 'undefined'", async () => {
    // CRITICAL ordering: session_start must fire BEFORE seeding, because
    // reconstructState → state.loadFromSession(ctx) resets the list from
    // getBranch() (mock returns []), which would wipe the seed.
    const start = handlers.session_start;
    if (typeof start !== "function") throw new Error("session_start handler not registered");
    let anyP: unknown;
    anyP = start(undefined, ctx as any);
    await anyP;

    // Seed main state through the real tool.
    const result = await registered.tool.execute(
      "c1",
      { operation: "write", todoList: [{ content: "Main task", status: "pending" }] },
      undefined,
      undefined,
      ctx as any,
    );
    expect(result.isError).toBeFalsy();

    // Legacy (old-schema) subagent payload: id/title/not-started.
    bus.emit(Events.TODOS_UPDATE, {
      source: "subagent:fake1",
      todos: [{ id: 1, title: "Old shape task", status: "not-started" }],
    });

    const lines = renderLines();
    const joined = lines.join("\n");
    expect(joined).toContain("Old shape task");
    expect(joined).toContain("Main task");
    expect(joined).not.toContain("undefined");
  });

  it("ignores unrecoverable payloads without crashing (no phantom column)", () => {
    // State from the previous test persists (same registered instance).
    expect(() => {
      bus.emit(Events.TODOS_UPDATE, { source: "subagent:fake2", todos: "garbage" });
      bus.emit(Events.TODOS_UPDATE, {
        source: "subagent:fake2",
        todos: [{ status: "pending" }],
      });
    }).not.toThrow();

    const lines = renderLines();
    const joined = lines.join("\n");
    expect(joined).toContain("Main task");
    expect(lines.some((l) => l.includes("subagent (fake2)"))).toBe(false);
  });

  it("TODOS_CLEAR removes the subagent column", () => {
    bus.emit(Events.TODOS_CLEAR, { source: "subagent:fake1" });

    const lines = renderLines();
    const joined = lines.join("\n");
    expect(lines.some((l) => l.includes("subagent (fake1)"))).toBe(false);
    expect(joined).toContain("Main task");
  });

  it("renders the plain agent name for a unique per-child (suffixed) source", async () => {
    // Fresh setup mirroring test 1: session_start first (resets main), then
    // seed main through the real tool, then a suffixed subagent bus emit.
    const start = handlers.session_start;
    if (typeof start !== "function") throw new Error("session_start handler not registered");
    let anyP: unknown;
    anyP = start(undefined, ctx as any);
    await anyP;

    const result = await registered.tool.execute(
      "c1",
      { operation: "write", todoList: [{ content: "Main task", status: "pending" }] },
      undefined,
      undefined,
      ctx as any,
    );
    expect(result.isError).toBeFalsy();

    // Per-child source now carries a suffix; the header must still render
    // just the agent name, not the uuid.
    bus.emit(Events.TODOS_UPDATE, {
      source: "subagent:fake1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      todos: [{ id: 1, title: "Old shape task", status: "not-started" }],
    });

    const lines = renderLines();
    const joined = lines.join("\n");
    expect(lines.some((l) => l.includes("subagent (fake1)"))).toBe(true);
    expect(joined).toContain("Old shape task");
    expect(joined).toContain("Main task");
    expect(joined).not.toContain("undefined");
  });

  afterAll(() => {
    // Unsubscribes the handle listeners registered by registerTodo and
    // clears state (fixture uses a pending item, so no auto-clear timer
    // is pending, but cancel defensively).
    handlers.session_shutdown?.(undefined, ctx as any);
  });
});

describe("todo index — auto-clear widget refresh", () => {
  function setup(branch: unknown[] = []) {
    const handlers: Record<string, Function> = {};
    const widgetValues: unknown[] = [];
    let tool: any;
    const bus = fakeBus();
    const pi = {
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
      registerTool(registeredTool: any) {
        tool = registeredTool;
      },
      registerCommand() {},
      events: bus,
    } as unknown as ExtensionAPI;
    const ctx = {
      ui: {
        setWidget(id: string, value: unknown) {
          if (id === "todo-list") widgetValues.push(value);
        },
        notify() {},
      },
      sessionManager: { getBranch: () => branch },
    } as any;

    registerTodo(pi);
    return {
      bus,
      ctx,
      handlers,
      get tool() {
        return tool;
      },
      widgetValues,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the widget when a completed write auto-clears", async () => {
    const fixture = setup();
    await fixture.handlers.session_start?.(undefined, fixture.ctx);

    await fixture.tool.execute(
      "complete",
      { operation: "write", todoList: [{ content: "Done", status: "completed" }] },
      undefined,
      undefined,
      fixture.ctx,
    );
    expect(typeof fixture.widgetValues.at(-1)).toBe("function");

    vi.advanceTimersByTime(2000);

    expect(fixture.widgetValues.at(-1)).toBeUndefined();
    fixture.handlers.session_shutdown?.(undefined, fixture.ctx);
  });

  it("keeps subagent columns when the main list auto-clears", async () => {
    const fixture = setup();
    await fixture.handlers.session_start?.(undefined, fixture.ctx);
    fixture.bus.emit(Events.TODOS_UPDATE, {
      source: "subagent:scout:11111111",
      todos: [{ content: "Child task", status: "pending" }],
    });
    await fixture.tool.execute(
      "complete",
      { operation: "write", todoList: [{ content: "Done", status: "completed" }] },
      undefined,
      undefined,
      fixture.ctx,
    );

    vi.advanceTimersByTime(2000);

    // The main column is gone; the widget stays for the child column.
    expect(typeof fixture.widgetValues.at(-1)).toBe("function");
    fixture.handlers.session_shutdown?.(undefined, fixture.ctx);
  });

  it("reconstructs a completed latest list, then clears and repaints", async () => {
    const fixture = setup([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "manage_todo_list",
          details: { todos: [{ content: "Earlier", status: "pending" }] },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "manage_todo_list",
          details: { todos: [{ content: "Restored done", status: "completed" }] },
        },
      },
    ]);

    await fixture.handlers.session_tree?.(undefined, fixture.ctx);
    expect(typeof fixture.widgetValues.at(-1)).toBe("function");

    vi.advanceTimersByTime(2000);

    expect(fixture.widgetValues.at(-1)).toBeUndefined();
    fixture.handlers.session_shutdown?.(undefined, fixture.ctx);
  });

  it("keeps a restored pending list visible", async () => {
    const fixture = setup([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "manage_todo_list",
          details: { todos: [{ content: "Restored open", status: "pending" }] },
        },
      },
    ]);

    await fixture.handlers.session_start?.(undefined, fixture.ctx);
    vi.advanceTimersByTime(2000);

    expect(typeof fixture.widgetValues.at(-1)).toBe("function");
    fixture.handlers.session_shutdown?.(undefined, fixture.ctx);
  });

  it("prevents the auto-clear callback from repainting after shutdown", async () => {
    const fixture = setup();
    await fixture.handlers.session_start?.(undefined, fixture.ctx);
    await fixture.tool.execute(
      "complete",
      { operation: "write", todoList: [{ content: "Done", status: "completed" }] },
      undefined,
      undefined,
      fixture.ctx,
    );

    fixture.handlers.session_shutdown?.(undefined, fixture.ctx);
    const callsAfterShutdown = fixture.widgetValues.length;
    vi.advanceTimersByTime(2000);

    // A surviving timer would call onAutoClear -> refreshWidget -> setWidget.
    expect(fixture.widgetValues).toHaveLength(callsAfterShutdown);
  });
});
