/**
 * Config threading (issue #163, the #156 shape-parity card).
 *
 * `registerDiffTools(pi, getTheme, readConfig)` used to park `readConfig` in a
 * module-scope binding and re-point two submodule getters at it. Two sessions in
 * one process therefore shared ONE config slot: after the second registration,
 * the first session's rows rendered with the second session's `diffTheme` and
 * split thresholds — measured flipping a 200-column render from split to unified.
 *
 * The pin drives INSTALLED RENDERERS, never a leaf function. Passing a config
 * straight to `shouldUseSplit` cannot observe the shared holder, so a test
 * written against the leaf reads green on both the broken and the fixed tree and
 * pins nothing.
 *
 * Red on the base tree: session A's reader stops firing the moment session B
 * registers (`expected N to be greater than N`). Green once the reader is
 * captured per registration.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiffTools } from "./index.js";
import type { DiffRenderConfig } from "./render/index.js";

/**
 * A `pi` handle that collects every resolver, the way pi collects a LIST of them
 * per extension (same shape as `src/tools/register.test.ts`).
 */
function fakePi() {
  const renderers: ((name: string, next: () => any) => any)[] = [];
  const pi = {
    registerTool: () => {},
    registerToolRenderer: (r: (name: string, next: () => any) => any) => {
      renderers.push(r);
    },
    on: () => () => {},
  } as unknown as ExtensionAPI;
  return { pi, renderers };
}

/**
 * Resolve the way pi does: fold every registered resolver over the previous
 * answer. Both installers push a resolver, so capturing only the last one would
 * overwrite the `edit` answer — the fold is what keeps it.
 */
function resolveTool(
  resolvers: readonly ((name: string, next: () => any) => any)[],
  toolName: string,
) {
  let out: any = { renderShell: "default" };
  for (const r of resolvers) out = r(toolName, () => out) ?? out;
  return out;
}

// The theme stub from `src/tools/edit.test.ts` — a token-addressable fake, so
// nothing here decides a colour by reading an escape sequence.
const theme = {
  fg: (token: string, text?: string) =>
    text === undefined ? `[${token}]` : `[${token}:${text}]`,
  bold: (text: string) => `**${text}**`,
  bg: (_token: string, text: string) => text,
  italic: (text: string) => text,
} as any;

/**
 * A FRESH context per call, exactly as pi hands one to a renderer. A reused ctx
 * would let the `ctx.state._pk` memo short-circuit the row before it ever built
 * a component, and the read we are counting would not happen.
 */
function freshCtx() {
  return {
    state: {},
    outputPad: 1,
    argsComplete: true,
    lastComponent: undefined,
    invalidate: () => {},
    isError: false,
    expanded: false,
  } as any;
}

/** Render a row the way pi does: build it, then draw it at a real width. */
function drawRow(renderers: any, args: any, width: number): string[] {
  const component = renderers.renderCall(args, theme, freshCtx());
  return component.render(width);
}

/** Let the component's async render promise run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function workspace(dir: string, name: string, contents: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

describe("config threading across two sessions in one process", () => {
  it("keeps session A reading its own config after session B registers (#163)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "diff-threading-"));
    try {
      let readsA = 0;
      let readsB = 0;

      // A wants a wide-enough terminal for the split view and a light theme.
      const configA: DiffRenderConfig = {
        diffTheme: "github-light",
        diffSplitMinWidth: 100,
        diffSplitMinCodeWidth: 30,
        diffSplitWrapCheck: false,
      };
      // B wants a terminal wider than any real one: every render falls back to
      // unified. If A inherits B's reader, A's split view disappears.
      const configB: DiffRenderConfig = {
        diffTheme: "dracula",
        diffSplitMinWidth: 4000,
        diffSplitMinCodeWidth: 30,
        diffSplitWrapCheck: false,
      };

      const readerA = () => {
        readsA++;
        return configA;
      };
      const readerB = () => {
        readsB++;
        return configB;
      };

      const sessionA = fakePi();
      registerDiffTools(sessionA.pi, () => theme, readerA);

      const editA = resolveTool(sessionA.renderers, "edit");
      expect(typeof editA?.renderCall).toBe("function");

      const first = workspace(dir, "first.ts", "const a = 1;\n");
      drawRow(
        editA,
        { path: first, oldText: "const a = 1;\n", newText: "const b = 2;\n" },
        200,
      );
      await settle();

      const readsAfterFirst = readsA;
      expect(readsAfterFirst).toBeGreaterThan(0);

      // A second session, on a DIFFERENT `pi` handle, with a different reader.
      const sessionB = fakePi();
      registerDiffTools(sessionB.pi, () => theme, readerB);
      expect(resolveTool(sessionB.renderers, "edit")?.renderCall).toBeTypeOf("function");

      // A brand new `edit` row, still rendered by A's resolvers.
      const second = workspace(dir, "second.ts", "const c = 3;\n");
      drawRow(
        editA,
        { path: second, oldText: "const c = 3;\n", newText: "const d = 4;\n" },
        200,
      );
      await settle();

      // A's rows must still ask A. On the shared-holder tree this reads
      // `expected N to be greater than N`: B's registration re-pointed the
      // module binding and A's reader never fires again.
      expect(readsA).toBeGreaterThan(readsAfterFirst);
      // A's rows must not have been rendered by B's reader either.
      expect(readsB).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
