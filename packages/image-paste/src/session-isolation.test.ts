import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── #156: one module instance, two sessions, no shared queue ────────────────
//
// pi caches an extension MODULE per process but re-invokes its factory with a
// fresh `pi` per session, so a subordinate in-process session (a third-party
// subagent child) shares the module with the main session. When that child ran
// its `session_shutdown`, the package's module-level `shutdownImagePaste()`
// nulled the MAIN session's queue and the paste handler returned at
// `if (!queue || !ctx.hasUI) return;` before touching the clipboard — silently.
// Reproduced live against pi 1.5.0 with a control: `alt+v` attached `[Image #1]`
// before the child's shutdown and produced literally nothing after it.
//
// The fix is a handle: `registerImagePaste` creates its state per factory run
// and hands back `{ initSession, shutdown }`, so a session can only ever drop
// its own state. This file drives TWO sessions through ONE module instance —
// which is exactly how pi runs it — and asserts the main session survives both
// foreign lifecycle events. Assertions come from the `input` handler's return
// value, so no pi internals are involved.
//
// Settings: `core/settings-io` captures `join(getAgentDir(), "settings.json")`
// at module load, hence one scratch dir for the whole file (absent settings =
// the defaults: shortcuts claimed, preview on). Clipboard: the readers are
// mocked so a paste yields image bytes without shelling out.

const { tempDir, fs, join, mockReadClipboardImage } = vi.hoisted(() => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const dir = join(tmpdir(), `image-paste-session-isolation-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { tempDir: dir, fs, join, mockReadClipboardImage: vi.fn() };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tempDir,
  convertToPng: () => undefined,
}));

vi.mock("./clipboard.js", () => ({
  readClipboardImage: mockReadClipboardImage,
  readClipboardFilePaths: vi.fn(async () => null),
  readClipboardText: vi.fn(async () => null),
  buildPathInsertion: vi.fn(),
  clipboardTextForEditor: vi.fn(),
}));

const { registerImagePaste } = await import("./index.js");

type Handler = (...args: unknown[]) => unknown;

interface SubmitResult {
  action: string;
  images?: unknown[];
}

/**
 * One session, exactly as pi builds one: a fresh `pi` handle through the same
 * module instance. `initSession()` / `shutdown()` are the handle's lifecycle
 * methods (the session's `session_start` / `session_shutdown`); `paste` and
 * `input` drive the handlers registration handed to pi.
 */
function makeSession() {
  const pi = {
    on: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  };
  const inserted: string[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  // A partial ctx, cast the way paste-mutex.test.ts casts its harness ctx: the
  // package only ever reads `hasUI` and `ui` from it.
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push([message, type]);
      },
      pasteToEditor: (text: string) => {
        inserted.push(text);
      },
      getEditorText: () => "",
    },
  } as unknown as ExtensionContext;

  const session = registerImagePaste(pi as never);

  const pasteHandler = pi.registerShortcut.mock.calls[0]![1].handler as Handler;
  const inputHandler = pi.on.mock.calls.find((call) => call[0] === "input")![1] as Handler;

  return {
    ...session,
    pi,
    ctx,
    inserted,
    notifications,
    /** Press the package's paste shortcut for this session. */
    paste: async (context = ctx) => {
      await pasteHandler(context);
    },
    /** Submit an event through this session's `input` handler. */
    input: async (event: { text: string; source: string }): Promise<SubmitResult> =>
      (await inputHandler(event)) as SubmitResult,
  };
}

beforeEach(() => {
  fs.rmSync(join(tempDir, "settings.json"), { force: true });
  mockReadClipboardImage.mockReset();
  mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
});

describe("#156 image-paste session isolation", () => {
  it("a foreign session's shutdown does not stop the main session's paste", async () => {
    const main = makeSession(); // registerImagePaste(mainPi) + main.initSession(mainCtx)
    main.initSession(main.ctx); // main session_start

    const child = makeSession(); // second factory run, same module — pi does this per session
    child.initSession(child.ctx); // child session_start
    child.shutdown(); // child session_shutdown (reason: "quit")

    // 1. main's shortcut still reaches the clipboard. Pre-fix this returned at
    //    the `!queue` guard and the reader never ran — no notify, no marker, no
    //    message: a dead key.
    await main.paste(main.ctx);

    expect(mockReadClipboardImage, "the reader never ran for the main session").toHaveBeenCalledTimes(1);
    expect(main.inserted).toEqual(["[Image #1] "]);
    expect(main.notifications).toEqual([["Image attached from clipboard.", "info"]]);
  });

  it("a foreign session_start does not orphan the main session's queued image", async () => {
    const main = makeSession();
    main.initSession(main.ctx);
    await main.paste(main.ctx); // the marker "[Image #1]" is in the editor
    expect(main.inserted).toEqual(["[Image #1] "]);

    const child = makeSession();
    child.initSession(child.ctx); // child session_start only — no shutdown

    // 2. main's queued image still attaches on submit. Pre-fix `_queue` was
    //    reassigned by the child's session_start, so main's marker matched
    //    nothing and the submit silently dropped the attached image.
    const result = await main.input({ text: "[Image #1] look", source: "interactive" });

    expect(result.action).toBe("transform");
    expect(result.images).toHaveLength(1);
  });
});
