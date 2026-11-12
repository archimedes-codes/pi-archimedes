/**
 * Frame-width audit for the `/archimedes` settings overlay, the `/plugins`
 * overlay (same manager, different items) and the onboarding overlay.
 *
 * Automated stand-in for a `PI_TUI_WRITE_LOG` capture: render each surface
 * through its real entry point at several frame widths, measure **every produced
 * line** with pi-tui's own `visibleWidth` (what the terminal draws), and require
 * it to land on the frame. These are the surfaces `OVERLAY_CHROME` feeds, and
 * the cursor marker they emit is the shape the old `.length`-based width maths
 * measured far too wide — see Task 4 of the pi 1.x alignment plan.
 *
 * This audit measures bleed only: `wrapWithBorder` pads short rows up and
 * truncates long ones (`packages/core/src/overlay.ts:94`), so every produced
 * line lands on the frame whatever width the caller sized its rows to — an
 * under-sized row is invisible here by construction. Row *layout* (does a field
 * get the columns it asked for) is asserted in
 * `onboarding/overlay-layout.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth as tuiVisibleWidth,
} from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";
import { createSettingsManager, type PromptDescriptor } from "./settings-manager.js";
import { createOnboardingOverlay } from "./onboarding/overlay.js";
import type { OverlayTheme } from "@pi-archimedes/core/overlay";

// The onboarding overlay's live spinner previews come from @pi-archimedes/ui;
// the audit only needs a deterministic 4-cell string per (style, tick).
vi.mock("@pi-archimedes/ui/editor", () => ({
  spinFrame: vi.fn((style: string, tick: number) => {
    const c = 0x2800 + ((tick % 8) + (style.length % 4));
    return String.fromCharCode(c) + "⣷⣾⣽";
  }),
}));

// One entry per failure mode of the deleted width maths.
const URL = `https://example.com/${"segment/".repeat(12)}`;

/** A theme that actually colourises, so SGR sequences are in the measured lines. */
const theme = {
  fg: (token: string, text: string) =>
    token === "accent"
      ? `\x1b[38;2;80;120;255m${text}\x1b[0m`
      : token === "error"
        ? `\x1b[38;2;255;90;90m${text}\x1b[0m`
        : `\x1b[38;2;120;160;200m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  muted: (text: string) => `\x1b[38;2;100;100;100m${text}\x1b[0m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
} as unknown as OverlayTheme & Record<string, (...args: never[]) => unknown>;

const plainTheme: OverlayTheme = { fg: (token: string, text: string) => String(theme.fg(token, text)) };

/**
 * The free-text "model" row's seeded value, and the wide value the audit types
 * on top of it (37 drawn columns in total — more than the narrowest frame hands
 * the field, which is what makes the prompt capture a crowded row).
 */
const SEEDED_VALUE = "anthropic/claude-opus-4.5";
const TYPED_VALUE = "検証モデル名";
/**
 * The head of the seeded value — its first path segment, derived so a fixture
 * that renames the value cannot leave the crowding check below pointing at a
 * string nothing draws any more. A horizontally scrolled field drops these
 * columns first, which is what the check reads them for.
 *
 * The `/` is asserted rather than assumed: `slice(0, -1)` — what `indexOf` returns
 * when it finds nothing — would silently cut only the last character, so the head
 * would still be found on screen and the crowding tripwire below would weaken
 * instead of failing. A leading `/` is refused for the same reason: it makes the
 * head empty, and an empty string is found in every frame.
 */
const SEPARATOR = SEEDED_VALUE.indexOf("/");
if (SEPARATOR <= 0) {
  throw new Error("`SEEDED_VALUE` needs a non-empty first path segment — the head below is it");
}
const SEEDED_HEAD = SEEDED_VALUE.slice(0, SEPARATOR);

const ITEMS: SettingItem[] = [
  {
    id: "wide",
    label: "界面表示の幅",
    currentValue: "既定",
    description: "この設定はオーバーレイの幅を検証するための日本語の説明です。".repeat(3),
  },
  {
    id: "linked",
    label: `docs\x1b]8;;${URL}\x07link\x1b]8;;\x07`,
    currentValue: `see \x1b]8;;${URL}\x07this\x1b]8;;\x07`,
    description: `reference: \x1b]8;;${URL}\x07manual\x1b]8;;\x07`,
  },
  { id: "coloured", label: "\x1b[33mtinted\x1b[0m label", currentValue: "\x1b[32mon\x1b[0m", values: ["on", "off"] },
  {
    id: "model",
    label: "モデル スコープ モデル",
    currentValue: SEEDED_VALUE,
    description: `${"説明文".repeat(60)}`,
  },
];

const PROMPTS: Record<string, PromptDescriptor> = {
  model: { kind: "text", label: "モデル スコープ モデル" },
};

interface Violation {
  surface: string;
  frameWidth: number;
  row: number;
  measured: number;
}

/** Every produced line of a bordered overlay must land on the frame exactly. */
function audit(surface: string, frameWidth: number, lines: string[]): Violation[] {
  const bad: Violation[] = [];
  lines.forEach((line, row) => {
    const measured = tuiVisibleWidth(line);
    if (measured !== frameWidth) bad.push({ surface, frameWidth, row, measured });
  });
  return bad;
}

// ── Capture content checks ───────────────────────────────────────────────────
//
// A width audit only proves something if the captured frame is the frame it means
// to measure. List search accepts printable ASCII only (`isAsciiPrintable` in
// settings-manager.ts: `data.length === 1 && data >= " " && data <= "~"`), while
// the free-text prompt field is pi-tui's `Input`, which takes any non-control
// input including wide characters — so a wide-character prompt is real content
// and a wide-character search query is not reachable at all. Each capture
// therefore declares the content it expects and is checked before the frame is
// measured.

/** Drawn text of the search row, border and padding removed, or undefined. */
function searchRow(raw: string[]): string | undefined {
  return raw
    .map((l) => stripTerminalSequences(l).replace(/[│┌└┐┘─]/g, "").trim())
    .find((l) => l.includes("Search:"));
}

function drawnIncludes(raw: string[], needle: string): boolean {
  return raw.some((l) => stripTerminalSequences(l).includes(needle));
}

/**
 * What `drawnRow()` found. `line` is present ONLY in the unambiguous case — one
 * row drew the needle — so a caller that wants it has to handle the case where
 * zero or several did, and `matches`/`rows` say which. Under
 * `exactOptionalPropertyTypes` `line?: string` means "absent", never
 * "explicitly undefined", so the two failures cannot be conflated by a caller
 * that reads the line without asking how many rows matched.
 */
interface DrawnRow {
  /** How many rows drew the needle; 1 is the only unambiguous answer. */
  readonly matches: number;
  /** Every matched row, sequences and border glyphs stripped, for the message. */
  readonly rows: readonly string[];
  /** The untouched line of the matched row — only when exactly one matched. */
  readonly line?: string;
}

/**
 * The row that draws `needle`, plus the evidence to report when there is not
 * exactly one such row. Strips terminal sequences and the border glyphs the way
 * `searchRow()` does to *locate* the row, then hands back the untouched line so
 * a caller can still look inside it for the zero-width `CURSOR_MARKER` — which
 * the strip would remove.
 *
 * The match count is part of the result, not just the line: "the needle is not
 * drawn" and "the needle is drawn on four rows" are different failures with the
 * same return value, and reporting the first when the second happened sends the
 * reader to the wrong code.
 */
function drawnRow(raw: string[], needle: string): DrawnRow {
  const hits = raw
    .map((line) => ({ line, bare: stripTerminalSequences(line).replace(/[│┌└┐┘─]/g, "").trim() }))
    .filter((hit) => hit.bare.includes(needle));
  const rows = hits.map((h) => h.bare);
  const only = hits.length === 1 ? hits[0] : undefined;
  return only ? { line: only.line, matches: 1, rows } : { matches: hits.length, rows };
}

function makeManager() {
  return createSettingsManager({
    items: ITEMS.map((i) => ({ ...i })),
    prompts: PROMPTS,
    theme: theme as never,
    onChange: () => {},
    onSave: () => {},
    onClose: () => {},
  });
}

function makeOnboarding() {
  return createOnboardingOverlay({
    theme: plainTheme,
    thinkingDefault: "Full",
    toolDefault: "Minimal",
    plugins: [
      { id: "ui", label: "界面表示", description: "TUI 拡張機能".repeat(6), selected: true },
      { id: "linked", label: `plugin\x1b]8;;${URL}\x07link\x1b]8;;\x07`, description: `see \x1b]8;;${URL}\x07docs\x1b]8;;\x07`, selected: false },
      { id: "diff", label: "\x1b[35mdiff\x1b[0m", description: "Shiki diff rendering", selected: true },
    ],
    spinners: ["typing", "pulse", "rain"],
    spinnerDefault: "pulse",
    onDone: () => {},
  });
}

describe("overlay surfaces frame-width audit", () => {
  // `NARROWEST_FRAME` is derived rather than written twice: the prompt row's
  // crowding check below has to fire on the frame where crowding is guaranteed,
  // and a list that grows by a narrower entry must move that target with it.
  const FRAME_WIDTHS = [40, 60, 84, 100];
  const NARROWEST_FRAME = Math.min(...FRAME_WIDTHS);

  it("keeps every produced line on the frame, on every surface and mode", () => {
    const violations: Violation[] = [];
    const over: Violation[] = [];

    for (const frameWidth of FRAME_WIDTHS) {
      const capture = (
        surface: string,
        lines: string[],
        expectContent?: (raw: string[]) => string | null,
      ) => {
        // Check the capture is what the audit thinks it is *before* measuring it.
        const problem = expectContent?.(lines);
        expect(problem ?? null, `${surface}@${frameWidth} is not the capture this audit measures`).toBeNull();
        const bad = audit(surface, frameWidth, lines);
        violations.push(...bad);
        over.push(...bad.filter((v) => v.measured > frameWidth));
      };

      // /archimedes settings — list, search (emits CURSOR_MARKER), prompt mode
      capture("settings:list", makeManager().render(frameWidth), (raw) =>
        drawnIncludes(raw, "界面表示の幅") ? null : "list rows not rendered",
      );

      // The search row with an empty query — the shape that carries the cursor
      // marker. The wide keystrokes after `/` are dropped by the ASCII gate.
      const searchingEmpty = makeManager();
      searchingEmpty.handleInput("/");
      for (const ch of "界面") searchingEmpty.handleInput(ch);
      capture("settings:search-empty", searchingEmpty.render(frameWidth), (raw) => {
        // Tripwire for that gate: if search ever accepts wide input, this capture
        // has to feed the wide query — otherwise a CJK search row goes unmeasured
        // and the frame-width claim quietly goes stale.
        if (!raw.some((l) => l.includes(CURSOR_MARKER))) return "cursor marker not rendered";
        const row = searchRow(raw);
        if (row?.trim() !== "Search:")
          return `search row is not the empty query: ${JSON.stringify(row?.trim())}`;
        return null;
      });

      // A populated search row: `link` is accepted by the ASCII gate and matches
      // exactly one fixture, so the filter result is checked, not assumed.
      const searching = makeManager();
      searching.handleInput("/");
      for (const ch of "link") searching.handleInput(ch);
      capture("settings:search", searching.render(frameWidth), (raw) => {
        const row = searchRow(raw);
        if (row?.trim() !== "Search: link")
          return `search row does not show the query: ${JSON.stringify(row?.trim())}`;
        if (!raw.some((l) => l.includes(CURSOR_MARKER))) return "cursor marker missing from the search row";
        if (!drawnIncludes(raw, "docs")) return "filtered list lost the OSC 8 fixture row";
        if (drawnIncludes(raw, "tinted")) return "search did not narrow the list";
        return null;
      });

      // Prompt mode takes wide input (its field is pi-tui's `Input`), so the
      // value the audit types really does land in the drawn frame. On the
      // narrowest frame the value fills the row, so its tail — and the zero-width
      // cursor behind it — are cut onto the frame instead of overflowing it.
      const prompting = makeManager();
      prompting.handleInput("\x1b[B"); // down to the free-text "model" row
      prompting.handleInput("\x1b[B");
      prompting.handleInput("\x1b[B");
      prompting.handleInput("\r");
      for (const ch of TYPED_VALUE) prompting.handleInput(ch);
      capture("settings:prompt", prompting.render(frameWidth), (raw) => {
        // #100: the cursor marker survives a full prompt row. `CURSOR_MARKER` is
        // zero width, so on a row whose value already fills the frame it is the
        // one thing that costs nothing to keep and everything to lose — the old
        // `.length`-based padding counted it as drawn columns and the truncation
        // that followed cut it off the tail, leaving the user a value, no cursor
        // and no clue why. The search rows above already carry the sibling
        // assertion; this is the prompt row's.
        //
        // It is bound to the row that draws the value, not to the frame: while a
        // field is open the search row is not drawn, but a whole-frame `.some()`
        // would still be satisfied by a marker that migrated onto any other row,
        // which is exactly the regression shape this guards. `drawnRow()` refuses
        // an ambiguous match for the same reason.
        //
        // The locator is the whole typed value, not a prefix of it: a prefix
        // would still match a row whose tail had been cut, which is the very
        // regression the marker check below is watching for. It also subsumes the
        // `drawnIncludes` this guard used to lead with, and it is deliberately the
        // full value rather than the shorter `検証` — the `wide` fixture's
        // description carries `検証` three times over, so the moment `listBody()`
        // stops returning early behind an open field (`settings-manager.ts:526`)
        // the short needle would match several rows and the guard would lose its
        // anchor. Matching the full value keeps it anchored on the field's row.
        const valueRow = drawnRow(raw, TYPED_VALUE);
        if (valueRow.line === undefined) {
          const sample = valueRow.rows.map((r) => JSON.stringify(r)).join(" | ");
          return `the typed value is not on exactly one row (${valueRow.matches} matched): ${sample || "(nothing drew it)"}`;
        }
        const row = valueRow.line;
        if (!row.includes(CURSOR_MARKER)) return "cursor marker missing from the prompt value row";
        // Tripwire against a decorative guard: crowding is what the assertion
        // above is *for*, and crowding has a chrome-independent signature. The
        // value is 37 columns; on the narrowest frame audited pi-tui's `Input` is
        // handed 34, so it scrolls the row and the HEAD of the value is not drawn
        // at all while the typed tail is. That is what "over-full" means to the
        // component doing the drawing. Unlike the measured column count this
        // replaces, it names no border, no padding and no fake-cursor cell, so a
        // chrome change cannot outlive it, and it cannot go green on a row that
        // stopped being crowded. The head is looked for across the whole frame on
        // purpose: absent everywhere is the claim, so a field that wrapped the
        // value onto a second row instead of scrolling it is reported rather than
        // mistaken for a row that merely moved. And it is keyed to the *narrowest*
        // audited frame, not to slot 0 of the list: scrolling only gets harder as
        // the frame shrinks, so a width added to the audit can only tighten this.
        if (frameWidth === NARROWEST_FRAME && drawnIncludes(raw, SEEDED_HEAD)) {
          return `prompt row is not crowded on the narrowest frame: the head of the value (${SEEDED_HEAD}) is still drawn`;
        }
        return null;
      });

      // An empty filter result exercises the "no matching settings" row too.
      const noMatches = makeManager();
      noMatches.handleInput("/");
      for (const ch of "zzzz") noMatches.handleInput(ch);
      capture("settings:no-matches", noMatches.render(frameWidth), (raw) => {
        if (searchRow(raw)?.trim() !== "Search: zzzz") return "search row does not show the query";
        if (!drawnIncludes(raw, "No matching settings")) return "empty-filter row not rendered";
        return null;
      });

      // Onboarding — four steps, each with its own row shapes.
      const intro = makeOnboarding();
      capture("onboarding:thinking", intro.render(frameWidth), (raw) =>
        drawnIncludes(raw, "Thinking style") ? null : "thinking step not rendered",
      );
      intro.handleInput("\r");
      capture("onboarding:tool", intro.render(frameWidth), (raw) =>
        drawnIncludes(raw, "Tool output style") ? null : "tool step not rendered",
      );
      intro.handleInput("\r");
      capture("onboarding:plugins", intro.render(frameWidth), (raw) =>
        drawnIncludes(raw, "Which plugins")
          ? drawnIncludes(raw, "pluginlink")
            ? null
            : "plugin row carrying the OSC 8 label not rendered"
          : "plugin step not rendered",
      );
      intro.handleInput("\r");
      capture("onboarding:spinner", intro.render(frameWidth), (raw) =>
        drawnIncludes(raw, "Which spinner") ? null : "spinner step not rendered",
      );
    }

    // Guard the fixtures: the marker is the shape that used to measure far too
    // wide, so a green audit that never emitted one would prove nothing.
    const probe = makeManager();
    probe.handleInput("/");
    expect(probe.render(84).some((line) => line.includes(CURSOR_MARKER))).toBe(true);

    const summary = (list: Violation[]) =>
      list.slice(0, 6).map((v) => `${v.surface}@${v.frameWidth}:row${v.row}=${v.measured}`).join(", ");
    expect(
      over,
      `${over.length}/${violations.length} off-frame line(s) [wider than the frame]: ${summary(over)}`,
    ).toEqual([]);
    expect(violations, `${violations.length} off-frame line(s) total: ${summary(violations)}`).toEqual([]);
  });
});
