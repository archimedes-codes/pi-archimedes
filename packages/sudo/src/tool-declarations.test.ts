/**
 * Task 11 item 3 — what pi's callers are told about `sudo_exec`.
 *
 * `annotations` are author-declared hints with MCP's meaning, and pi documents
 * them as unverified — the input for a permission gate that decides which calls
 * to confirm, not a guarantee (`pi: dist/core/extensions/types.d.ts`,
 * `ToolAnnotations`). So this test pins the declaration, nothing more: `sudo_exec`
 * runs arbitrary privileged commands, so it is destructive and not read-only.
 */

import { describe, it, expect } from "vitest";
import { createSudoExecTool } from "./tool.js";

const tool = createSudoExecTool() as unknown as {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  exposure?: string;
};

describe("sudo_exec annotations", () => {
  it("says it is destructive", () => {
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it("says it is not read-only", () => {
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it("leaves the hints it has not earned undeclared", () => {
    // idempotentHint would be a lie — a second `sudo rm` is not a no-op — and
    // openWorldHint belongs to the tools that reach the web, not this one.
    expect(tool.annotations?.idempotentHint).toBeUndefined();
    expect(tool.annotations?.openWorldHint).toBeUndefined();
  });

  it("stays reachable by default (direct exposure, active on registration)", () => {
    expect(tool.exposure ?? "direct").toBe("direct");
  });
});

describe("sudo_exec description", () => {
  // The description is handed to the model on every call, and it now carries the
  // skip contract (ADR 0033): without a pin the wording drifts silently, which is
  // how bullet 2 kept saying "for the session" after the cache became
  // process-scoped.
  const description = tool.description ?? "";

  it("names the setting that skips the gate, so the model can explain the exception", () => {
    expect(description).toContain("confirmWhenCached");
  });

  it("scopes the cache to the process, not the session", () => {
    expect(description).toContain("cached in memory for the process");
    expect(description).not.toContain("for the session");
  });

  it("still says the password is never exposed", () => {
    expect(description).toContain("never exposed");
  });
});
