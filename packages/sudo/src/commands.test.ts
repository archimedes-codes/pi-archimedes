/**
 * /sudo subcommand tests: auth (pre-authorization), ttl (default TTL
 * show/set/reset + live-entry re-timing), and the second-level argument
 * completions (ADR 0034).
 *
 * The command layer is exercised through a fake `pi`/`ctx` like
 * lifecycle.test.ts. The password prompt, the validation probe and the
 * settings store are all mocked: the tests here pin the command logic and
 * its cache/config effects, never real sudo or real settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { credentialCache } from "./cache.js";
import { DEFAULT_SUDO_CONFIG } from "./config.js";
import { registerSudo } from "./index.js";

// Settings store mock (same shape as config.test.ts / lifecycle.test.ts).
const settingsStore = vi.hoisted(() => ({
	settings: {} as Record<string, Record<string, unknown>>,
	saved: [] as Array<{ namespace: string; config: object }>,
}));
vi.mock("@pi-archimedes/core/settings-io", () => ({
	loadConfig: (namespace: string, defaults: Record<string, unknown>) => ({
		...defaults,
		...settingsStore.settings[namespace],
	}),
	saveConfig: (namespace: string, config: Record<string, unknown>) => {
		settingsStore.saved.push({ namespace, config });
		settingsStore.settings[namespace] = config;
	},
}));

// prompt mock: the test drives WHAT the user types via `typedPassword`.
const promptState = vi.hoisted(() => ({ typedPassword: "" as string, prompted: 0 }));
vi.mock("./prompt.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./prompt.js")>()),
	promptForPassword: vi.fn(async () => {
		promptState.prompted += 1;
		return promptState.typedPassword;
	}),
}));

// tool mock: probeSudoPasswordStrict returns `probeResult`; defaultSpawner is
// never actually invoked because the probe is mocked.
const toolState = vi.hoisted(() => ({ probeResult: true }));
vi.mock("./tool.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tool.js")>()),
	probeSudoPasswordStrict: vi.fn(async () => toolState.probeResult),
	defaultSpawner: vi.fn(() => {
		throw new Error("defaultSpawner must not be called — the probe is mocked");
	}),
}));

import { probeSudoPasswordStrict } from "./tool.js";

interface FakePi {
	pi: ExtensionAPI;
	commands: Map<string, { description: string; handler: Function; getArgumentCompletions?: Function }>;
}

function fakePi(): FakePi {
	const commands = new Map<string, { description: string; handler: Function; getArgumentCompletions?: Function }>();
	const pi = {
		on() {},
		registerTool() {},
		registerCommand(name: string, def: { description: string; handler: Function; getArgumentCompletions?: Function }) {
			commands.set(name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function fakeCtx(overrides?: { select?: (title: string, options: string[]) => Promise<string | undefined> }) {
	const notified: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			notify(message: string, _kind?: string) {
				notified.push(message);
			},
			select: overrides?.select ?? (async () => undefined),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notified };
}

describe("/sudo subcommands (ADR 0034)", () => {
	let def: { handler: Function; getArgumentCompletions?: Function };

	beforeEach(() => {
		for (const key of Object.keys(settingsStore.settings)) delete settingsStore.settings[key];
		settingsStore.saved.length = 0;
		promptState.typedPassword = "";
		promptState.prompted = 0;
		toolState.probeResult = true;
		vi.mocked(probeSudoPasswordStrict).mockClear();
		const fake = fakePi();
		registerSudo(fake.pi);
		def = fake.commands.get("sudo") as { handler: Function; getArgumentCompletions?: Function };
		credentialCache.clear();
	});

	// ── /sudo auth — pre-authorization ────────────────────────────────────────

	it("auth validates the typed password and caches it with the default TTL", async () => {
		promptState.typedPassword = "hunter2";
		toolState.probeResult = true;

		const { ctx, notified } = fakeCtx();
		await def.handler("auth", ctx);

		expect(promptState.prompted).toBe(1);
		expect(probeSudoPasswordStrict).toHaveBeenCalledTimes(1);
		const entry = credentialCache.get();
		expect(entry?.password).toBe("hunter2");
		expect(notified[0]).toContain("verified and cached");
		expect(notified[0]).toContain("15m from now"); // default TTL
	});

	it("auth with a duration argument caches with that one-off TTL and does NOT touch the config default", async () => {
		promptState.typedPassword = "hunter2";
		const { ctx, notified } = fakeCtx();
		await def.handler("auth 2h30m", ctx);

		const entry = credentialCache.get();
		expect(entry).not.toBeNull();
		expect(entry!.expiresAt - Date.now()).toBeLessThanOrEqual(9_000_000);
		expect(notified[0]).toContain("2h30m from now");
		expect(settingsStore.saved).toHaveLength(0); // one-off, not persisted
	});

	it("auth with an invalid duration refuses BEFORE prompting", async () => {
		const { ctx, notified } = fakeCtx();
		await def.handler("auth fortnight", ctx);

		expect(promptState.prompted).toBe(0);
		expect(credentialCache.get()).toBeNull();
		expect(notified[0]).toContain("Not a duration");
	});

	it("auth with a cancelled prompt caches nothing", async () => {
		promptState.typedPassword = ""; // promptForPassword's cancellation shape
		const { ctx, notified } = fakeCtx();
		await def.handler("auth", ctx);

		expect(credentialCache.get()).toBeNull();
		expect(notified[0]).toContain("Cancelled");
	});

	it("auth with a REJECTED password caches nothing — validation is the gate", async () => {
		promptState.typedPassword = "wrong";
		toolState.probeResult = false;
		const { ctx, notified } = fakeCtx();
		await def.handler("auth", ctx);

		expect(credentialCache.get()).toBeNull();
		expect(notified[0]).toContain("rejected");
	});

	// ── /sudo ttl — default TTL ───────────────────────────────────────────────

	it("ttl <duration> persists the new default and re-times a live entry to match", async () => {
		credentialCache.set("hunter2", 60_000);
		const { ctx, notified } = fakeCtx();
		await def.handler("ttl 1h", ctx);

		expect(settingsStore.saved).toEqual([{ namespace: "archimedes.sudo", config: { ...DEFAULT_SUDO_CONFIG, ttlMs: 3_600_000 } }]);
		const entry = credentialCache.get();
		expect(entry).not.toBeNull();
		expect(entry!.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
		expect(notified[0]).toContain("re-timed to match");
	});

	it("ttl <duration> without a cached entry only persists the default", async () => {
		const { ctx, notified } = fakeCtx();
		await def.handler("ttl 2h", ctx);

		expect(settingsStore.saved).toHaveLength(1);
		expect(notified[0]).toBe("Default TTL set to 2h.");
	});

	it("ttl default resets the persisted default and re-times a live entry", async () => {
		settingsStore.settings["archimedes.sudo"] = { ttlMs: 7_200_000 };
		credentialCache.set("hunter2", 7_200_000);
		const { ctx, notified } = fakeCtx();
		await def.handler("ttl default", ctx);

		expect(settingsStore.saved[0]?.config).toMatchObject({ ttlMs: DEFAULT_SUDO_CONFIG.ttlMs });
		expect(notified[0]).toContain("TTL reset to the default 15m");
		const entry = credentialCache.get();
		expect(entry?.expiresAt).toBeGreaterThanOrEqual(Date.now() + DEFAULT_SUDO_CONFIG.ttlMs - 5);
		expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_SUDO_CONFIG.ttlMs);
	});

	it("ttl with an unparseable argument is a usage error — nothing saved, cache untouched", async () => {
		credentialCache.set("hunter2", 60_000);
		const { ctx, notified } = fakeCtx();
		await def.handler("ttl banana", ctx);

		expect(settingsStore.saved).toHaveLength(0);
		expect(credentialCache.get()?.expiresAt).toBe(Date.now() + 60_000);
		expect(notified[0]).toContain("Not a duration");
	});

	it("bare ttl opens the interactive picker and applies the choice", async () => {
		const { ctx, notified } = fakeCtx({
			select: async (_title, options) => options.find((o) => o === "1h"),
		});
		await def.handler("ttl", ctx);

		expect(settingsStore.saved).toEqual([{ namespace: "archimedes.sudo", config: { ...DEFAULT_SUDO_CONFIG, ttlMs: 3_600_000 } }]);
		expect(notified[0]).toContain("Default TTL set to 1h.");
	});

	it("bare ttl with a cancelled picker changes nothing", async () => {
		const { ctx } = fakeCtx({ select: async () => undefined });
		await def.handler("ttl", ctx);
		expect(settingsStore.saved).toHaveLength(0);
	});

	// ── second-level completions ──────────────────────────────────────────────

	it("completions expose the subcommands at the first level", () => {
		const items = def.getArgumentCompletions?.("") as Array<{ value: string }>;
		expect(items.map((i) => i.value).sort()).toEqual(["auth", "forget", "ttl"]);
	});

	it("completions carry the subcommand in their VALUE — pi replaces the whole argument string", () => {
		const authItems = def.getArgumentCompletions?.("auth ") as Array<{ value: string; label: string }>;
		expect(authItems.map((i) => i.value)).toContain("auth 1h");
		expect(authItems.find((i) => i.value === "auth 1h")?.label).toBe("1h");
		const ttlItems = def.getArgumentCompletions?.("ttl ") as Array<{ value: string }>;
		expect(ttlItems.map((i) => i.value)).toContain("ttl default");
	});

	it("completions offer `default` for ttl only — it is not a duration", () => {
		const authItems = def.getArgumentCompletions?.("auth ") as Array<{ value: string }>;
		expect(authItems.map((i) => i.value)).not.toContain("auth default");
		const ttlItems = def.getArgumentCompletions?.("ttl ") as Array<{ value: string }>;
		expect(ttlItems.map((i) => i.value)).toContain("ttl default");
	});

	it("completions filter by the typed prefix at both levels", () => {
		const firstLevel = def.getArgumentCompletions?.("f") as Array<{ value: string }>;
		expect(firstLevel.map((i) => i.value)).toEqual(["forget"]);
		const secondLevel = def.getArgumentCompletions?.("ttl 1") as Array<{ value: string }>;
		expect(secondLevel.map((i) => i.value)).toEqual(["ttl 15m", "ttl 1h"]);
	});

	it("completions stop at the second level (deep args belong to the handler)", () => {
		expect(def.getArgumentCompletions?.("auth 2h")).toBeNull();
	});
});
