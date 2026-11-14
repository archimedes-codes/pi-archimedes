/**
 * Module-state shape pin for `packages/diff` (issue #163).
 *
 * `packages/core/src/session-state-discipline.test.ts` is the cross-package
 * guard, but it is INTRA-FILE: it follows a session handler's body and the
 * functions that body calls in the same file, so it was satisfied here by
 * assigning `_readConfig` one line away from the handler that wrote it. This
 * file asserts the SOURCE SHAPE instead, so it cannot be satisfied by moving an
 * assignment to another file or one line further down.
 *
 * What is banned: a module-scope `let`/`var` holding a config getter, a config
 * value, or a theme key, and any exported `setConfigGetter` — the setter being
 * the tell that the binding is re-pointed per session rather than owned by the
 * process.
 *
 * What stays allowed, deliberately: `_TextComponent` (`index.ts` — loaded once
 * at module evaluation, never re-pointed) and `_shikiReady` (`shiki.ts` — an
 * honest "the Shiki warm-up has run" flag). Both are pinned below so this file
 * cannot quietly become a blanket "no module state" rule.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("./", import.meta.url));

/** Every non-test `.ts` file under `packages/diff/src`. */
function sourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** A module-scope binding holding config, a config reader, or a theme key. */
const CONFIG_HOLDER = /^\s*(?:export\s+)?(?:let|var)\s+_?(?:getConfig|_readConfig|_lastThemeKey)\b/;

/** The exported setter that re-points such a binding per session. */
const CONFIG_SETTER = /^\s*export\s+(?:function|const)\s+setConfigGetter\b/;

function violations(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CONFIG_HOLDER.test(line)) {
        found.push(`${rel}:${i + 1} [config holder at module scope] ${line.trim()}`);
      }
      if (CONFIG_SETTER.test(line)) {
        found.push(`${rel}:${i + 1} [per-session config setter exported] ${line.trim()}`);
      }
    });
  }
  return found;
}

describe("diff module state (#163)", () => {
  it("scans a non-empty file set (so the guard cannot go vacuous)", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(statSync(file).isFile()).toBe(true);
    expect(files.map((f) => relative(SRC_ROOT, f).replace(/\\/g, "/"))).toContain("shiki.ts");
  });

  it("declares no module-scope config holder and exports no setConfigGetter", () => {
    expect(violations(sourceFiles())).toEqual([]);
  });

  it("still allows the two honest process-wide bindings", () => {
    const index = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");
    const shiki = readFileSync(join(SRC_ROOT, "shiki.ts"), "utf8");
    expect(index).toMatch(/^let _TextComponent:/m);
    expect(shiki).toMatch(/^let _shikiReady = false;$/m);
  });

  it("keeps shiki.ts free of any import from index.js or render/ (no cycle)", () => {
    const shiki = readFileSync(join(SRC_ROOT, "shiki.ts"), "utf8");
    expect(shiki).not.toMatch(/from\s+["']\.\/index\.js["']/);
    expect(shiki).not.toMatch(/from\s+["']\.\/render\//);
  });
});
