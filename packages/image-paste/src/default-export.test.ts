import { describe, expect, it, vi, beforeEach } from "vitest";

// The standalone session_start handler drives the native-paste restore, so the
// wiring test mocks that module (hermetic: nothing may touch the real
// ~/.pi/agent/keybindings.json from a unit test) and asserts the call. The
// shortcut gate lives in the same module and is mocked to "suite keeps the key"
// here so this file tests wiring only; the gate itself is tested, against real
// settings, in shortcut-gate.test.ts.
vi.mock("./keybinding-offer.js", () => ({
  runNativePasteRestore: vi.fn(async () => ({ kind: "suppressed" })),
  suiteMayClaimPasteKey: vi.fn(() => true),
}));

// The isolation case below drives a real paste through the standalone handlers,
// so the clipboard readers are mocked (no shelling out) and the settings read is
// pointed at a scratch dir — `core/settings-io` captures
// `join(getAgentDir(), "settings.json")` at module load.
const { tempDir, fs, join, mockReadClipboardImage } = vi.hoisted(() => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const dir = join(tmpdir(), `image-paste-default-export-${randomUUID()}`);
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

const { runNativePasteRestore } = await import("./keybinding-offer.js");
const defaultExport = (await import("./index.js")).default;

type Handler = (...args: unknown[]) => unknown;

interface SubmitResult {
	action: string;
	images?: unknown[];
}

/**
 * One standalone session: a factory run of its own, with the handlers that run
 * handed to pi. pi caches the extension MODULE and re-invokes the factory per
 * session, so two of these are two sessions in one process (#156).
 */
function standaloneSession() {
	const inserted: string[] = [];
	const on = vi.fn();
	const registerShortcut = vi.fn();
	const pi = {
		on,
		registerShortcut,
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
	} as any;
	defaultExport(pi);

	const ctx = {
		hasUI: true,
		ui: { notify: vi.fn(), pasteToEditor: (text: string) => inserted.push(text), getEditorText: () => "" },
	};
	const start = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as Handler;
	const shutdown = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_shutdown")?.[1] as Handler;
	const input = on.mock.calls.find((c: Array<unknown>) => c[0] === "input")?.[1] as Handler;
	const press = registerShortcut.mock.calls[0]![1].handler as Handler;

	return {
		inserted,
		/** Fire this session's `session_start`. */
		start: () => start({}, ctx),
		/** Fire this session's `session_shutdown`. */
		shutdown: () => shutdown({}, ctx),
		/** Press this session's paste shortcut. */
		press: () => press(ctx),
		/** Submit `text` through this session's `input` handler. */
		submit: (text: string) => input({ text, source: "interactive" }) as Promise<SubmitResult>,
	};
}

describe("image-paste default export (standalone factory)", () => {
	beforeEach(() => {
		fs.rmSync(join(tempDir, "settings.json"), { force: true });
		mockReadClipboardImage.mockReset();
		mockReadClipboardImage.mockResolvedValue({
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
		});
	});

	it("is a function that registers paste + per-session lifecycle on the pi extension", () => {
		expect(typeof defaultExport).toBe("function");

		const on = vi.fn();
		const registerShortcut = vi.fn();
		const registerMessageRenderer = vi.fn();

		const pi = { on, registerShortcut, registerMessageRenderer } as any;

		defaultExport(pi);

		// registerImagePaste wires the preview renderer + shortcuts
		expect(registerMessageRenderer).toHaveBeenCalled();
		expect(registerShortcut).toHaveBeenCalled();

		// input handler (from registerImagePaste) + session lifecycle handlers
		const events = on.mock.calls.map((c: Array<unknown>) => c[0]);
		expect(events).toEqual(
			expect.arrayContaining(["input", "session_start", "session_shutdown"]),
		);
	});

	it("a session's shutdown clears its OWN queue and leaves another session's intact", async () => {
		// #156: pi caches the module and re-runs the factory per session, so the
		// lifecycle handlers of two sessions coexist in one process. The old
		// module-level state meant a child's `session_shutdown` cleared the MAIN
		// session's queue (dead paste key, silently) and a child's
		// `session_start` replaced it (the queued image never attached). Both
		// halves are asserted here through the standalone wiring; the same
		// guarantee through the named export is in session-isolation.test.ts.
		const main = standaloneSession();
		await main.start();
		await main.press(); // main's queue now holds "[Image #1]"
		expect(main.inserted).toEqual(["[Image #1] "]);

		const child = standaloneSession();
		await child.start();
		await child.shutdown();

		// The main session's queue survived the child's teardown: its shortcut
		// reaches the clipboard again rather than returning at the `!queue` guard.
		await main.press();
		expect(mockReadClipboardImage).toHaveBeenCalledTimes(2);
		expect(main.inserted).toEqual(["[Image #1] ", "[Image #2] "]);

		// …and both queued images still attach on the main session's submit — the
		// child's session_start did not orphan the first one.
		const result = await main.submit("[Image #1] and [Image #2] look");
		expect(result.action).toBe("transform");
		expect(result.images).toHaveLength(2);
	});
});

// ── the standalone call site for restoreNativePaste (ADR 0030 amendment) ───
//
// A standalone install has no meta factory, so image-paste's OWN
// session_start registration is what hands ctrl+v back when
// archimedes.imagePaste.suppressNativePaste is false. The handler must be
// registered at the top level of the factory — a handler nested inside another
// session_start accumulates on /reload (AGENTS.md).
describe("image-paste default export — native-paste restore call site", () => {
	beforeEach(() => {
		vi.mocked(runNativePasteRestore).mockClear();
	});

	it("registers its session_start handler at the top level of the factory (never nested)", async () => {
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		// Registered during the factory call itself — before any session ran.
		const countStarts = () =>
			on.mock.calls.filter((c: Array<unknown>) => c[0] === "session_start").length;
		const registeredByFactory = countStarts();
		expect(registeredByFactory).toBeGreaterThanOrEqual(1);

		// …and running sessions must not register MORE of them. A `pi.on`
		// nested inside a session_start handler adds one handler per session on
		// every /reload (AGENTS.md), which a plain "was it registered" check
		// cannot see — the nested version registers exactly one at factory time
		// too. This is the half of the claim that has teeth.
		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		await startHandler({}, { hasUI: true });
		await startHandler({}, { hasUI: true });
		expect(countStarts(), "a session_start handler registered another one (nested)").toBe(
			registeredByFactory,
		);
		// One call per session is the other half of the same promise.
		expect(runNativePasteRestore).toHaveBeenCalledTimes(2);
	});

	it("runs the restore once per session_start with that session's ctx", async () => {
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		const ctx = { hasUI: true, mode: "tui" };
		await startHandler({}, ctx);

		expect(runNativePasteRestore).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runNativePasteRestore).mock.calls[0]?.[0]).toBe(ctx);
	});

	it("session_start still resolves when the restore rejects (a broken keybindings.json must not kill the session)", async () => {
		vi.mocked(runNativePasteRestore).mockRejectedValueOnce(new Error("boom"));
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>;

		let thrown: unknown = null;
		try {
			await startHandler({}, { hasUI: true });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeNull();
	});
});