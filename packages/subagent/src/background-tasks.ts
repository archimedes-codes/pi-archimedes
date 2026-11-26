import type { SubagentProgress } from "./types.js";

export const BACKGROUND_TASKS_CHANNEL = "pi:background-tasks";
export const BACKGROUND_TASKS_REQUEST_CHANNEL = "pi:background-tasks:request";
export const BACKGROUND_TASKS_SOURCE = "pi-archimedes";

export const MAX_BACKGROUND_TASKS = 64;
export const MAX_BACKGROUND_ID = 200;
export const MAX_BACKGROUND_NAME = 64;
export const MAX_BACKGROUND_LABEL = 160;
export const MAX_BACKGROUND_DETAIL = 320;
export const MAX_BACKGROUND_TASK = 16 * 1024;
export const MAX_BACKGROUND_TRANSCRIPT = 64 * 1024;
export const MAX_BACKGROUND_SNAPSHOT_TEXT = 2 * 1024 * 1024;
export const MAX_BACKGROUND_SESSION_ID = 200;

const MAX_TRANSCRIPT_TOOL_NAME = 128;
const MAX_TRANSCRIPT_ARGS = 2 * 1024;
const TRANSCRIPT_TRUNCATION_MARKER = "\n[transcript truncated]";

export interface BackgroundTaskUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface BackgroundTask {
  id: string;
  kind: "subagent";
  label: string;
  /** Agent name. Optional so existing v1 consumers keep accepting the row. */
  name?: string;
  /** Full task prompt, subject to MAX_BACKGROUND_TASK. */
  task?: string;
  /** Display transcript, subject to MAX_BACKGROUND_TRANSCRIPT and the snapshot budget. */
  transcript?: string;
  state: "starting" | "running";
  startedAt: number;
  usage?: BackgroundTaskUsage;
  usagePartial?: true;
  detail: string;
}

export interface BackgroundTaskSnapshot {
  version: 1;
  source: typeof BACKGROUND_TASKS_SOURCE;
  sessionId: string;
  tasks: BackgroundTask[];
}

export interface LiveSubagentTask {
  id: string;
  agent: string;
  task: string;
  state: "starting" | "running";
  startedAt: number;
  model?: string;
  progress?: SubagentProgress;
}

/** Remove terminal controls while retaining readable dialogue line breaks. */
function withoutTerminalControls(value: string): string {
  return value
    // OSC, including hyperlinks and title changes.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI and the remaining two-byte escape forms.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // Keep LF. Everything else in C0/C1 is a terminal control.
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Remove line breaks where the v1 field is defined as one display row. */
function boundedLine(value: string | undefined, limit: number, fallback: string): string {
  const line = withoutTerminalControls(value ?? "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (line || fallback).slice(0, limit);
}

function boundedText(value: string | undefined, limit: number): string | undefined {
  const text = withoutTerminalControls(value ?? "").trim();
  if (!text) return undefined;
  return text.slice(0, limit);
}

function boundedTranscript(value: string | undefined, limit: number): string | undefined {
  const text = withoutTerminalControls(value ?? "").trim();
  if (!text) return undefined;
  if (text.length <= limit) return text;
  if (limit <= TRANSCRIPT_TRUNCATION_MARKER.length) return text.slice(0, limit);
  return text.slice(0, limit - TRANSCRIPT_TRUNCATION_MARKER.length) + TRANSCRIPT_TRUNCATION_MARKER;
}

function transcriptFor(progress: SubagentProgress | undefined): string | undefined {
  if (!progress) return undefined;
  const lines: string[] = [];
  const calls = progress.toolCalls ?? [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const running =
      index === calls.length - 1 &&
      progress.currentTool !== undefined &&
      call.name === progress.currentTool;
    const glyph = running ? "▸" : call.error ? "✗" : "✓";
    const name = boundedLine(call.name, MAX_TRANSCRIPT_TOOL_NAME, "tool");
    const rawArgs = running ? progress.currentToolArgs : call.argsPreview;
    const args = boundedLine(rawArgs, MAX_TRANSCRIPT_ARGS, "");
    lines.push(`${glyph} ${name}${args ? `: ${args}` : ""}`);
  }
  if (progress.currentTool && calls.length === 0) {
    const name = boundedLine(progress.currentTool, MAX_TRANSCRIPT_TOOL_NAME, "tool");
    const args = boundedLine(progress.currentToolArgs, MAX_TRANSCRIPT_ARGS, "");
    lines.push(`▸ ${name}${args ? `: ${args}` : ""}`);
  }

  const output = boundedTranscript(progress.output, MAX_BACKGROUND_TRANSCRIPT);
  const transcript = [lines.join("\n"), output].filter(Boolean).join("\n\n");
  return boundedTranscript(transcript, MAX_BACKGROUND_TRANSCRIPT);
}

function knownUsage(progress: SubagentProgress | undefined): BackgroundTaskUsage | undefined {
  if (!progress) return undefined;
  const usage: BackgroundTaskUsage = {};
  if (Number.isFinite(progress.inputTokens) && progress.inputTokens >= 0) usage.input = progress.inputTokens;
  if (Number.isFinite(progress.outputTokens) && progress.outputTokens >= 0) usage.output = progress.outputTokens;
  if (Number.isFinite(progress.cost) && progress.cost >= 0) usage.cost = progress.cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function backgroundTaskId(toolCallId: string, index: number): string {
  const suffix = `:${index}`;
  const prefix = boundedLine(toolCallId, Math.max(1, MAX_BACKGROUND_ID - suffix.length), "subagent");
  return `${prefix}${suffix}`;
}

export function toBackgroundTask(run: LiveSubagentTask): BackgroundTask {
  const name = boundedLine(run.progress?.agent ?? run.agent, MAX_BACKGROUND_NAME, "subagent");
  const labelAgent = name.slice(0, 48);
  const task = boundedLine(run.progress?.task ?? run.task, MAX_BACKGROUND_LABEL, "task");
  const label = boundedLine(`${labelAgent}: ${task}`, MAX_BACKGROUND_LABEL, "subagent: task");
  const model = boundedLine(run.progress?.model ?? run.model, 96, "model pending");
  const tool = boundedLine(run.progress?.currentTool, 64, "no active tool");
  const detail = boundedLine(
    `Model: ${model} · Tool: ${tool} · Inspect the Archimedes subagent tool row for authoritative status.`,
    MAX_BACKGROUND_DETAIL,
    "Inspect the Archimedes subagent tool row for authoritative status.",
  );
  const usage = knownUsage(run.progress);
  const fullTask = boundedText(run.progress?.task ?? run.task, MAX_BACKGROUND_TASK);
  const transcript = transcriptFor(run.progress);
  return {
    id: boundedLine(run.id, MAX_BACKGROUND_ID, "subagent"),
    kind: "subagent",
    label,
    name,
    ...(fullTask ? { task: fullTask } : {}),
    ...(transcript ? { transcript } : {}),
    state: run.state,
    startedAt: run.startedAt,
    ...(usage ? { usage, usagePartial: true as const } : {}),
    detail,
  };
}

export function backgroundTaskSnapshot(
  sessionId: string,
  runs: Iterable<LiveSubagentTask>,
): BackgroundTaskSnapshot {
  const tasks: BackgroundTask[] = [];
  let textRemaining = MAX_BACKGROUND_SNAPSHOT_TEXT;
  for (const run of runs) {
    if (tasks.length >= MAX_BACKGROUND_TASKS) break;
    const task = toBackgroundTask(run);
    for (const field of ["name", "task", "transcript"] as const) {
      const value = task[field];
      if (value === undefined) continue;
      if (textRemaining <= 0) {
        delete task[field];
        continue;
      }
      if (value.length > textRemaining) {
        const clipped = field === "transcript"
          ? boundedTranscript(value, textRemaining)
          : boundedText(value, textRemaining);
        if (clipped === undefined) delete task[field];
        else task[field] = clipped;
      }
      textRemaining -= task[field]?.length ?? 0;
    }
    tasks.push(task);
  }
  return {
    version: 1,
    source: BACKGROUND_TASKS_SOURCE,
    sessionId: boundedLine(sessionId, MAX_BACKGROUND_SESSION_ID, "session"),
    tasks,
  };
}

export function isBackgroundTaskRequest(
  value: unknown,
): value is { version: 1; sessionId: string } {
  if (!value || typeof value !== "object") return false;
  const request = value as { version?: unknown; sessionId?: unknown };
  return request.version === 1 && typeof request.sessionId === "string";
}
