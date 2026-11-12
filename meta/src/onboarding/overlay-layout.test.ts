/**
 * Content-level layout audit for the onboarding wizard's plugin step.
 *
 * `meta/src/overlay-width-audit.test.ts` measures whether every produced line
 * lands on the frame. It cannot see a row that is under-sized: `wrapWithBorder`
 * calls `padEnd(line, contentWidth)` (`packages/core/src/overlay.ts:94`), which
 * pads short rows up and truncates long ones, so a row built to any width at all
 * still measures exactly the frame. That audit therefore passes on an 18-column
 * layout regression (verified by mutation) — it detects bleed, not layout.
 *
 * This file measures the fields INSIDE a row instead: the label column and the
 * description column of the plugin step, in drawn columns, against the content
 * cell `wrapWithBorder` actually allocates.
 */

import { describe, it, expect, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { borderContentWidth } from "@pi-archimedes/core/overlay";
import { createOnboardingOverlay } from "./overlay.js";

// Parity with overlay.test.ts / overlay-width-audit.test.ts: the live spinner
// previews are not what this file measures, and the mock keeps renders
// deterministic. (Step 3 is never rendered here.)
vi.mock("@pi-archimedes/ui/editor", () => ({
  spinFrame: vi.fn((style: string, tick: number) => {
    const c = 0x2800 + ((tick % 8) + (style.length % 4));
    return String.fromCharCode(c) + "⣷⣾⣽";
  }),
}));

// No ANSI from the theme: the assertions below index the drawn row by column, so
// a styled row would need stripping first (it is stripped anyway — see `cell`).
const theme = { fg: (_token: string, text: string) => text };

// The plugin row is `"<cursor> <marker> <label:16><description>"` inside the
// content cell: 5 columns of chrome, a 16-column label field at [5..20], and the
// description from column 21.
const PLUGIN_ROW = /^(?:[> ] ) [✓·] /;
const LABEL_FIELD_END = 20;
const DESC_START = 21;

/**
 * A fixture, not the real plugin list, for the same reason the frame audit uses
 * one: the capture has to be the shape the assertion is about. `over` is the one
 * real label wider than the 15-column cap (`Footer status bar`, 17 columns) and
 * is the row that collides; `exact` sits exactly on the cap, where the padding
 * call is most likely to under-add; `short` exercises the padded side. The
 * descriptions are long enough to fill the budget at every frame audited, so the
 * budget assertion below can never pass vacuously.
 */
const LONG_DESCRIPTION = "d".repeat(200);
const PLUGINS = [
  { id: "over", label: "Footer status bar", description: LONG_DESCRIPTION, selected: true },
  { id: "exact", label: "UI Enhancements", description: LONG_DESCRIPTION, selected: true },
  { id: "short", label: "Web", description: "Web search", selected: false },
];

/** The content cell of a bordered row: border glyphs and the 1-space padding removed. */
function cell(line: string): string {
  return stripTerminalSequences(line).replace(/^│/, "").replace(/│$/, "").slice(1, -1);
}

/** The plugin step's content cells, in order, at `frame`. */
function pluginRows(frame: number): string[] {
  const comp = createOnboardingOverlay({
    theme,
    thinkingDefault: "Full",
    toolDefault: "Minimal",
    plugins: PLUGINS,
    spinners: ["typing"],
    spinnerDefault: "typing",
    onDone: () => {},
  });
  comp.handleInput("\r"); // step 0 → 1
  comp.handleInput("\r"); // step 1 → 2 (plugins)
  return comp.render(frame).map(cell).filter((line) => PLUGIN_ROW.test(line));
}

const FRAMES = [40, 60, 84, 100];

describe("onboarding plugin row layout", () => {
  for (const frame of FRAMES) {
    it(`draws one row per plugin at frame ${frame}`, () => {
      expect(pluginRows(frame)).toHaveLength(PLUGINS.length);
    });

    it(`keeps a blank separator column between label and description at frame ${frame}`, () => {
      const collided = pluginRows(frame).filter((line) => line[LABEL_FIELD_END] !== " ");
      expect(
        collided,
        `frame ${frame}: the label field does not end on a blank column, so the description is drawn flush against the label: ${JSON.stringify(collided)}`,
      ).toEqual([]);
    });
  }
});
