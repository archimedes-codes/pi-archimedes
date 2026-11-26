import { describe, expect, it, vi } from "vitest";
import type { SubagentProgress, SubagentResult } from "./types.js";

const dispatchViaBridge = vi.hoisted(() => vi.fn());

vi.mock("@pi-archimedes/core/bridge", () => ({
  getBridge: () => ({ active: true }),
}));
vi.mock("./dispatch.js", () => ({
  dispatchViaBridge,
  buildFailedResult: vi.fn(),
}));
vi.mock("./spawn.js", () => ({
  resolveModel: ({ model, activeModel }: { model?: string; activeModel?: string }) => model ?? activeModel,
  spawnSubagent: vi.fn(() => { throw new Error("bridge test must not fork"); }),
}));

const { executeParallel } = await import("./execute.js");

function terminalProgress(agent: string, task: string, status: "completed" | "failed"): SubagentProgress {
  return {
    agent,
    status,
    ...(status === "completed" ? { outcome: "completed" as const } : {}),
    task,
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 0,
    inputTokens: 10,
    outputTokens: 2,
    tokens: 12,
    cost: 0.01,
    durationMs: 5,
    error: status === "failed" ? "bridge failed" : undefined,
    model: "test/model",
    output: undefined,
    recentOutput: undefined,
    toolCalls: undefined,
  };
}

function bridgeResult(agent: string, task: string, status: "completed" | "failed"): SubagentResult {
  return {
    agent,
    task,
    exitCode: status === "completed" ? 0 : 1,
    ...(status === "completed" ? { outcome: "completed" as const } : {}),
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
    usageAccountedElsewhere: true,
    model: "test/model",
    finalOutput: status === "completed" ? "done" : undefined,
    error: status === "failed" ? "bridge failed" : undefined,
    progress: terminalProgress(agent, task, status),
    progressSummary: { toolCount: 0, tokens: 12, durationMs: 5 },
  };
}

describe("executeParallel bridge settlement", () => {
  it("publishes each terminal result before slower siblings settle", async () => {
    const resolvers: Array<(result: SubagentResult) => void> = [];
    dispatchViaBridge.mockImplementation(() => new Promise<SubagentResult>((resolve) => {
      resolvers.push(resolve);
    }));
    const updates: SubagentProgress[][] = [];
    let batchSettled = false;
    const batch = executeParallel({
      tasks: [
        { agent: "first", agentConfig: undefined, task: "fail first", model: "test/model", activeModel: undefined, cwd: undefined },
        { agent: "second", agentConfig: undefined, task: "finish later", model: "test/model", activeModel: undefined, cwd: undefined },
      ],
      signal: undefined,
      events: { emit: () => {}, on: () => () => {} },
      onUpdate: (progress) => updates.push(progress),
    }).finally(() => { batchSettled = true; });

    expect(resolvers).toHaveLength(2);
    resolvers[0]!(bridgeResult("first", "fail first", "failed"));
    await vi.waitFor(() => {
      expect(updates.at(-1)?.map((item) => item.status)).toEqual(["failed", "running"]);
    });
    expect(batchSettled).toBe(false);

    resolvers[1]!(bridgeResult("second", "finish later", "completed"));
    await expect(batch).resolves.toMatchObject([
      { agent: "first", error: "bridge failed" },
      { agent: "second", outcome: "completed" },
    ]);
    expect(updates.at(-1)?.map((item) => item.status)).toEqual(["failed", "completed"]);
  });
});
