import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProgress, SubagentResult } from "./types.js";
import {
  BACKGROUND_TASKS_CHANNEL,
  BACKGROUND_TASKS_REQUEST_CHANNEL,
  MAX_BACKGROUND_DETAIL,
  MAX_BACKGROUND_LABEL,
  MAX_BACKGROUND_NAME,
  MAX_BACKGROUND_SANITIZE_SCAN,
  MAX_BACKGROUND_SNAPSHOT_TEXT,
  MAX_BACKGROUND_TASK,
  MAX_BACKGROUND_TASKS,
  MAX_BACKGROUND_TRANSCRIPT,
  backgroundTaskId,
  backgroundTaskSnapshot,
  type BackgroundTaskSnapshot,
  type LiveSubagentTask,
} from "./background-tasks.js";

const discoverAgents = vi.hoisted(() => vi.fn(() => []));
const executeSubagent = vi.hoisted(() => vi.fn());
const executeParallel = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  discoverAgents,
}));
vi.mock("./execute.js", () => ({ executeSubagent, executeParallel }));

const { registerSubagent } = await import("./index.js");

type Handler = (...args: any[]) => unknown;

function progress(overrides: Partial<SubagentProgress> = {}): SubagentProgress {
  return {
    agent: "reviewer",
    status: "running",
    task: "inspect the parser",
    currentTool: "read",
    currentToolArgs: undefined,
    currentToolStartedAt: Date.now(),
    toolCount: 1,
    inputTokens: 1200,
    outputTokens: 80,
    tokens: 1280,
    cost: 0.04,
    durationMs: 20,
    error: undefined,
    model: "anthropic/claude-sonnet-4",
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
    ...overrides,
  };
}

function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    agent: "reviewer",
    task: "inspect the parser",
    exitCode: 0,
    outcome: "completed",
    usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.04, turns: 1 },
    model: "anthropic/claude-sonnet-4",
    finalOutput: "done",
    error: undefined,
    progress: progress({ status: "completed", outcome: "completed", currentTool: undefined }),
    progressSummary: { toolCount: 1, tokens: 1280, durationMs: 20 },
    ...overrides,
  };
}

function context(sessionId: string) {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId },
    hasUI: false,
    ui: { notify: vi.fn() },
  };
}

function harness(options: { throwOnSnapshot?: boolean } = {}) {
  const tools: Array<{ name: string; execute: Handler }> = [];
  const lifecycle = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const emissions: Array<{ channel: string; value: unknown }> = [];
  const pi = {
    registerTool(tool: { name: string; execute: Handler }) { tools.push(tool); },
    registerCommand() {},
    getAllTools: () => [],
    on(name: string, handler: Handler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    events: {
      on(channel: string, handler: (value: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
      emit(channel: string, value: unknown) {
        emissions.push({ channel, value });
        if (options.throwOnSnapshot && channel === BACKGROUND_TASKS_CHANNEL) throw new Error("listener broke");
        for (const handler of eventHandlers.get(channel) ?? []) handler(value);
      },
    },
  };
  registerSubagent(pi as never);
  const tool = tools.find((candidate) => candidate.name === "subagent");
  if (!tool) throw new Error("subagent tool not registered");
  return {
    tool,
    emissions,
    snapshots: () => emissions
      .filter((item) => item.channel === BACKGROUND_TASKS_CHANNEL)
      .map((item) => item.value as BackgroundTaskSnapshot),
    fire(name: string, ...args: unknown[]) {
      for (const handler of lifecycle.get(name) ?? []) handler(...args);
    },
    request(value: unknown) {
      for (const handler of eventHandlers.get(BACKGROUND_TASKS_REQUEST_CHANNEL) ?? []) handler(value);
    },
  };
}

beforeEach(() => {
  discoverAgents.mockClear();
  executeSubagent.mockReset();
  executeParallel.mockReset();
  executeSubagent.mockResolvedValue(result());
  executeParallel.mockResolvedValue([result()]);
});

describe("public background-task protocol", () => {
  it("answers only matching v1 session requests", () => {
    const host = harness();
    const ctx = context("owner");
    host.fire("session_start", { type: "session_start" }, ctx);
    const baseline = host.snapshots().length;

    host.request({ version: 2, sessionId: "owner" });
    host.request({ version: 1, sessionId: "other" });
    expect(host.snapshots()).toHaveLength(baseline);

    host.request({ version: 1, sessionId: "owner" });
    expect(host.snapshots()).toHaveLength(baseline + 1);
    expect(host.snapshots().at(-1)).toEqual({
      version: 1,
      source: "pi-archimedes",
      sessionId: "owner",
      tasks: [],
    });
  });

  it("does not publish a task before dispatch validation passes", async () => {
    const host = harness();
    const ctx = context("owner");
    host.fire("session_start", {}, ctx);
    host.emissions.length = 0;

    await expect(host.tool.execute(
      "invalid",
      { agent: "missing", task: "must not start" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({ isError: true });
    expect(host.snapshots()).toEqual([]);
    expect(executeSubagent).not.toHaveBeenCalled();
  });

  it("publishes start, progress usage, and terminal removal for a single run", async () => {
    executeSubagent.mockImplementation(async (options: { onUpdate?: (value: SubagentProgress) => void }) => {
      options.onUpdate?.(progress({
        currentTool: "write",
        currentToolArgs: "src/parser.ts\nignored row",
        toolCalls: [
          { name: "read", argsPreview: "src/input.ts", error: false },
          { name: "bash", argsPreview: "pnpm test", error: true },
          { name: "write", argsPreview: "stale args", error: false },
        ],
        output: "First paragraph.\n\nSecond line.\x1b[2J",
      }));
      return result();
    });
    const host = harness();
    const ctx = context("owner");
    host.fire("session_start", {}, ctx);
    host.emissions.length = 0;

    await host.tool.execute("call-7", { agent: undefined, task: "inspect\nparser" }, undefined, undefined, ctx);
    const snapshots = host.snapshots();
    expect(snapshots.map((snapshot) => snapshot.tasks[0]?.state ?? "empty"))
      .toEqual(["starting", "running", "empty"]);
    expect(snapshots[0]!.tasks[0]).toMatchObject({
      id: "call-7:0",
      kind: "subagent",
      label: "subagent: inspect parser",
      name: "subagent",
      task: "inspect\nparser",
    });
    expect(snapshots[1]!.tasks[0]).toMatchObject({
      id: "call-7:0",
      usage: { input: 1200, output: 80, cost: 0.04 },
      usagePartial: true,
    });
    expect(snapshots[1]!.tasks[0]!.detail).toContain("Model: anthropic/claude-sonnet-4");
    expect(snapshots[1]!.tasks[0]!.detail).toContain("Tool: write");
    expect(snapshots[1]!.tasks[0]!.detail).toContain("Archimedes subagent tool row");
    expect(snapshots[1]!.tasks[0]!.detail).not.toMatch(/cancel|resume|stop/i);
    expect(snapshots[1]!.tasks[0]!.transcript).toBe([
      "✓ read: src/input.ts",
      "✗ bash: pnpm test",
      "▸ write: src/parser.ts ignored row",
      "",
      "First paragraph.",
      "",
      "Second line.",
    ].join("\n"));
  });

  it("uses stable tool-call-plus-index IDs for parallel runs", async () => {
    executeParallel.mockImplementation(async (options: { onUpdate?: (value: SubagentProgress[]) => void }) => {
      options.onUpdate?.([
        progress({ agent: "reviewer", task: "review" }),
        progress({ agent: "tester", task: "test" }),
      ]);
      options.onUpdate?.([
        progress({ agent: "reviewer", task: "review", status: "completed", outcome: "completed" }),
        progress({ agent: "tester", task: "test" }),
      ]);
      return [result({ task: "review" }), result({ agent: "tester", task: "test" })];
    });
    const host = harness();
    const ctx = context("owner");
    host.fire("session_start", {}, ctx);
    host.emissions.length = 0;

    await host.tool.execute("batch-3", {
      tasks: [{ task: "review" }, { task: "test" }],
    }, undefined, undefined, ctx);
    expect(host.snapshots()[0]!.tasks.map((task) => task.id)).toEqual(["batch-3:0", "batch-3:1"]);
    expect(host.snapshots()[1]!.tasks.map((task) => task.id)).toEqual(["batch-3:0", "batch-3:1"]);
    expect(host.snapshots()[2]!.tasks.map((task) => task.id)).toEqual(["batch-3:1"]);
    expect(host.snapshots().at(-1)!.tasks).toEqual([]);
  });

  it("cleans the shelf on errors, cancellation, reload, and shutdown", async () => {
    let rejectRun: ((error: Error) => void) | undefined;
    executeSubagent.mockImplementation(() => new Promise((_resolve, reject) => { rejectRun = reject; }));
    const host = harness();
    const owner = context("owner");
    host.fire("session_start", {}, owner);
    host.emissions.length = 0;
    const failed = host.tool.execute("error", { task: "fail" }, undefined, undefined, owner);
    rejectRun!(new Error("spawn failed"));
    await expect(failed).rejects.toThrow("spawn failed");
    expect(host.snapshots().at(-1)!.tasks).toEqual([]);

    let finishRun: ((value: SubagentResult) => void) | undefined;
    executeSubagent.mockImplementation(() => new Promise((resolve) => { finishRun = resolve; }));
    const controller = new AbortController();
    const cancelled = host.tool.execute("cancel", { task: "wait" }, controller.signal, undefined, owner);
    controller.abort();
    expect(host.snapshots().at(-1)!.tasks).toEqual([]);
    finishRun!(result({ outcome: "aborted" }));
    await cancelled;

    host.fire("session_start", {}, owner);
    expect(host.snapshots().at(-1)).toEqual({
      version: 1, source: "pi-archimedes", sessionId: "owner", tasks: [],
    });
    host.fire("session_shutdown", { reason: "reload" }, owner);
    expect(host.snapshots().at(-1)).toEqual({
      version: 1, source: "pi-archimedes", sessionId: "owner", tasks: [],
    });
  });

  it("ignores foreign lifecycle events until the owning session shuts down", async () => {
    let finishRun: ((value: SubagentResult) => void) | undefined;
    executeSubagent.mockImplementation(() => new Promise((resolve) => { finishRun = resolve; }));
    const host = harness();
    const owner = context("owner");
    const child = context("child");
    host.fire("session_start", {}, owner);
    host.emissions.length = 0;

    const pending = host.tool.execute("pending", { task: "keep running" }, undefined, undefined, owner);
    expect(host.snapshots().at(-1)!.tasks).toHaveLength(1);

    const beforeForeignLifecycle = host.snapshots().length;
    host.fire("session_start", {}, child);
    host.fire("session_shutdown", {}, child);
    expect(host.snapshots()).toHaveLength(beforeForeignLifecycle);
    expect(host.snapshots().at(-1)!.tasks[0]).toMatchObject({ id: "pending:0" });

    host.request({ version: 1, sessionId: "owner" });
    expect(host.snapshots()).toHaveLength(beforeForeignLifecycle + 1);
    expect(host.snapshots().at(-1)!.tasks[0]).toMatchObject({ id: "pending:0" });

    host.fire("session_shutdown", {}, owner);
    expect(host.snapshots().at(-1)).toEqual({
      version: 1, source: "pi-archimedes", sessionId: "owner", tasks: [],
    });
    const afterOwnerShutdown = host.snapshots().length;
    host.request({ version: 1, sessionId: "owner" });
    expect(host.snapshots()).toHaveLength(afterOwnerShutdown);

    finishRun!(result());
    await pending;
    expect(host.snapshots()).toHaveLength(afterOwnerShutdown);
  });

  it("does not let a failing snapshot listener affect execution", async () => {
    const host = harness({ throwOnSnapshot: true });
    const ctx = context("owner");
    expect(() => host.fire("session_start", {}, ctx)).not.toThrow();
    await expect(host.tool.execute("call", { task: "run" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: false });
  });

  it("bounds every public text field and the whole rich-text snapshot", () => {
    const runs: LiveSubagentTask[] = Array.from({ length: 80 }, (_, index) => ({
      id: `call:${index}`,
      agent: `agent-${index}${"x".repeat(100)}\x1b[2J`,
      task: `first line\n${"long task ".repeat(2000)}`,
      state: index % 2 ? "running" : "starting",
      startedAt: index,
      model: "model",
      progress: progress({
        agent: `agent-${index}${"x".repeat(100)}\x1b[2J`,
        task: `first line\n${"long task ".repeat(2000)}`,
        currentTool: "read\nwrite",
        toolCalls: [{ name: "read\x1b[31m", argsPreview: "a".repeat(3000), error: false }],
        output: `${"dialogue line\n".repeat(7000)}\x1b]0;private title\x07`,
      }),
    }));
    const snapshot = backgroundTaskSnapshot("owner", runs);
    expect(snapshot.tasks).toHaveLength(MAX_BACKGROUND_TASKS);
    expect(new Set(snapshot.tasks.map((task) => task.id)).size).toBe(MAX_BACKGROUND_TASKS);
    expect(snapshot.tasks.every((task) => task.label.length <= MAX_BACKGROUND_LABEL)).toBe(true);
    expect(snapshot.tasks.every((task) => task.detail.length <= MAX_BACKGROUND_DETAIL)).toBe(true);
    expect(snapshot.tasks.every((task) => (task.name?.length ?? 0) <= MAX_BACKGROUND_NAME)).toBe(true);
    expect(snapshot.tasks.every((task) => (task.task?.length ?? 0) <= MAX_BACKGROUND_TASK)).toBe(true);
    expect(snapshot.tasks.every((task) => (task.transcript?.length ?? 0) <= MAX_BACKGROUND_TRANSCRIPT)).toBe(true);
    expect(snapshot.tasks.reduce(
      (total, task) => total + (task.name?.length ?? 0) + (task.task?.length ?? 0) + (task.transcript?.length ?? 0),
      0,
    )).toBeLessThanOrEqual(MAX_BACKGROUND_SNAPSHOT_TEXT);
    expect(snapshot.tasks.every((task) => !/\x1b|\x07/.test(
      task.label + task.detail + (task.name ?? "") + (task.task ?? "") + (task.transcript ?? ""),
    ))).toBe(true);
    expect(snapshot.tasks[0]!.task).toContain("first line\nlong task");
    expect(snapshot.tasks[0]!.transcript).toContain("[transcript truncated]");
    const longCall = "x".repeat(300);
    expect(backgroundTaskId(longCall, 0)).not.toBe(backgroundTaskId(longCall, 1));
    expect(backgroundTaskId(longCall, 63)).toHaveLength(200);
  });

  it("reuses unchanged rendering and invalidates usage, tool, output, and state changes", () => {
    const toolCalls = [{ name: "read", argsPreview: "one.ts", error: false }];
    const run: LiveSubagentTask = {
      id: "memo:0",
      agent: "reviewer",
      task: "review",
      state: "running",
      startedAt: 1,
      model: "test/model",
      progress: progress({ output: "first", toolCalls }),
    };

    const first = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    const heartbeat = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    expect(heartbeat).toBe(first);

    run.progress = { ...run.progress!, durationMs: run.progress!.durationMs + 1000 };
    const durationOnlyHeartbeat = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    expect(durationOnlyHeartbeat).toBe(first);

    run.progress = progress({
      currentTool: "write",
      currentToolArgs: "two.ts",
      inputTokens: 1400,
      outputTokens: 100,
      cost: 0.06,
      output: "second",
      toolCalls: [...toolCalls, { name: "write", argsPreview: "two.ts", error: false }],
    });
    const changedProgress = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    expect(changedProgress).not.toBe(first);
    expect(changedProgress).toMatchObject({ usage: { input: 1400, output: 100, cost: 0.06 } });
    expect(changedProgress.detail).toContain("Tool: write");
    expect(changedProgress.transcript).toContain("second");
    expect(changedProgress.transcript).toContain("write: two.ts");

    run.progress.toolCalls!.at(-1)!.error = true;
    run.progress.currentTool = undefined;
    run.progress.currentToolArgs = undefined;
    const changedToolResult = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    expect(changedToolResult).not.toBe(changedProgress);
    expect(changedToolResult.transcript).toContain("✗ write: two.ts");

    run.state = "starting";
    const changedState = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
    expect(changedState).not.toBe(changedToolResult);
    expect(changedState.state).toBe("starting");
  });

  it("bounds sanitizer input before processing very large output", () => {
    const replace = vi.spyOn(String.prototype, "replace");
    const run: LiveSubagentTask = {
      id: "large:0",
      agent: "reviewer",
      task: "review",
      state: "running",
      startedAt: 1,
      progress: progress({ output: "x".repeat(MAX_BACKGROUND_TRANSCRIPT * 100) }),
    };

    let task: BackgroundTaskSnapshot["tasks"][number];
    try {
      task = backgroundTaskSnapshot("owner", [run]).tasks[0]!;
      const largestScannedInput = Math.max(...replace.mock.instances.map((value) => String(value).length));
      expect(largestScannedInput).toBeLessThanOrEqual(MAX_BACKGROUND_SANITIZE_SCAN);
    } finally {
      replace.mockRestore();
    }
    expect(task.transcript).toHaveLength(MAX_BACKGROUND_TRANSCRIPT);
    expect(task.transcript).toContain("[transcript truncated]");
  });
});
