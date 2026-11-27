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

// prompt mock: the test drives WHAT the user types via `typedPassword`, and
// `reject` models the non-TUI session where the masked prompt does not exist.
const promptState = vi.hoisted(() => ({ typedPassword: "" as string, prompted: 0, reject: false }));
vi.mock("./prompt.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./prompt.js")>()),
	promptForPassword: vi.fn(async () => {
		promptState.prompted += 1;
		if (promptState.reject) throw new Error("the masked prompt needs a TUI session");
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
	const kinds: Array<string | undefined> = [];
	const ctx = {
		mode: "tui",
		ui: {
			notify(message: string, kind?: string) {
				notified.push(message);
				kinds.push(kind);
			},
			select: overrides?.select ?? (async () => undefined),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notified, kinds };
}

describe("/sudo subcommands (ADR 0034)", () => {
	let def: { handler: Function; getArgumentCompletions?: Function };

	beforeEach(() => {
		for (const key of Object.keys(settingsStore.settings)) delete settingsStore.settings[key];
		settingsStore.saved.length = 0;
		promptState.typedPassword = "";
		promptState.prompted = 0;
		promptState.reject = false;
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
		expect(notified[0]).toContain("cached — 15m from now"); // default TTL
		// `verified` is a claim sudo did not make on a NOPASSWD host, where
		// `sudo -k -S -v` exits 0 without ever reading a password.
		expect(notified[0]).not.toContain("verified");
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
		const before = Date.now();
		await def.handler("ttl 1h", ctx);
		const after = Date.now();

		expect(settingsStore.saved).toEqual([{ namespace: "archimedes.sudo", config: { ...DEFAULT_SUDO_CONFIG, ttlMs: 3_600_000 } }]);
		// `expiresAt` is written DURING the await, between these two clock reads, so
		// the window is exact and needs no tolerance — a `Date.now()` read after the
		// await plus a small slack is what flakes on a loaded runner.
		const entry = credentialCache.get();
		expect(entry).not.toBeNull();
		expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(entry!.expiresAt).toBeLessThanOrEqual(after + 3_600_000);
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
		const before = Date.now();
		await def.handler("ttl default", ctx);
		const after = Date.now();

		expect(settingsStore.saved[0]?.config).toMatchObject({ ttlMs: DEFAULT_SUDO_CONFIG.ttlMs });
		expect(notified[0]).toContain("TTL reset to the default 15m");
		// Bracket the write with two clock reads instead of racing one: the entry is
		// re-timed DURING the await, so `expiresAt - ttl` lands in [before, after].
		const entry = credentialCache.get();
		expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_SUDO_CONFIG.ttlMs);
		expect(entry?.expiresAt).toBeLessThanOrEqual(after + DEFAULT_SUDO_CONFIG.ttlMs);
	});

	it("ttl with an unparseable argument is a usage error — nothing saved, cache untouched", async () => {
		credentialCache.set("hunter2", 60_000);
		// Read the deadline BEFORE the await: the handler awaits, so a millisecond may
		// tick between set() and a Date.now() read here, and an exact post-await
		// comparison then fails at random (2 of 10 runs). The claim under test is
		// "not re-timed", and re-timing moves this by orders of magnitude.
		const expiresAt = credentialCache.get()?.expiresAt;
		const { ctx, notified } = fakeCtx();
		await def.handler("ttl banana", ctx);

		expect(settingsStore.saved).toHaveLength(0);
		expect(credentialCache.get()?.expiresAt).toBe(expiresAt);
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

	// ── the password's path: prompt → probe → cache, and nowhere else ─────────

	it("never puts the typed password into a notify message or a saved setting", async () => {
		// The package's central promise (README: "never in argv, environment
		// variables, command logs, or the LLM context") is pinned for argv and stdin;
		// notify is the channel that reaches a transcript in bridge/RPC mode.
		promptState.typedPassword = "hunter2";
		for (const probeResult of [true, false]) {
			toolState.probeResult = probeResult;
			const { ctx, notified } = fakeCtx();
			await def.handler("auth 2h", ctx);
			expect(notified.join("\n")).not.toContain("hunter2");
		}
		// `auth` never writes settings — `ttl` does — so the settings assertion has to
		// walk the arm that actually persists, or it cannot fail.
		const { ctx } = fakeCtx();
		await def.handler("ttl 2h", ctx);
		expect(settingsStore.saved).toHaveLength(1);
		expect(JSON.stringify(settingsStore.saved)).not.toContain("hunter2");
	});

	it("passes the typed password and the probe timeout to the strict probe", async () => {
		promptState.typedPassword = "hunter2";
		const { ctx } = fakeCtx();
		await def.handler("auth", ctx);
		expect(probeSudoPasswordStrict).toHaveBeenCalledWith("hunter2", 5_000, undefined, expect.anything());
	});

	it("the spawner registered through registerSudo is the one the strict probe gets", async () => {
		const fake = fakePi();
		const spawner = vi.fn();
		registerSudo(fake.pi, { spawner: spawner as never });
		promptState.typedPassword = "hunter2";
		const { ctx } = fakeCtx();
		await fake.commands.get("sudo")!.handler("auth", ctx);
		expect(probeSudoPasswordStrict).toHaveBeenLastCalledWith("hunter2", 5_000, undefined, spawner);
	});

	it("auth in a session without a masked prompt notifies instead of throwing", async () => {
		// promptForPassword rejects outside TUI/bridge; uncaught, pi reports it as an
		// extension error on `command:sudo` quoting sudo_exec — the wrong command.
		promptState.reject = true;
		const { ctx, notified, kinds } = fakeCtx();
		await expect(def.handler("auth", ctx)).resolves.toBeUndefined();

		expect(credentialCache.get()).toBeNull();
		// Exactly one notify: `""` is promptForPassword's CANCELLATION sentinel, so
		// returning it made the cancellation branch fire a second time and tell the
		// user they cancelled a prompt they were never shown.
		expect(notified).toHaveLength(1);
		expect(kinds[0]).toBe("error");
		expect(notified[0]).toContain("needs an interactive session");
		expect(notified.join("\n")).not.toContain("Cancelled");
		expect(notified.join("\n")).not.toContain("sudo_exec");
	});

	// ── ttl never re-opens a closed window ───────────────────────────────────

	it("ttl <duration> does NOT revive an expired entry — expiry is final until /sudo auth", async () => {
		// Reviving would reopen the ADR 0033 gate without re-validating anything.
		credentialCache.set("hunter2", 1);
		await new Promise((r) => setTimeout(r, 5));
		const { ctx, notified, kinds } = fakeCtx();
		await def.handler("ttl 8h", ctx);

		expect(settingsStore.saved).toHaveLength(1); // the default still persists
		expect(credentialCache.get()).toBeNull(); // the window does not reopen
		// ...and the user is told so: an expired entry and an empty cache must not
		// print the same sentence, or `/sudo ttl 8h` after a lapse reads as success.
		expect(notified[0]).toContain("Default TTL set to 8h");
		expect(notified[0]).toContain("had expired");
		expect(notified[0]).toContain("/sudo auth");
		expect(kinds[0]).toBe("warning");
	});

	it("ttl default does not revive an expired entry either", async () => {
		credentialCache.set("hunter2", 1);
		await new Promise((r) => setTimeout(r, 5));
		const { ctx, notified, kinds } = fakeCtx();
		await def.handler("ttl default", ctx);

		expect(credentialCache.get()).toBeNull();
		expect(notified[0]).toContain("had expired");
		expect(kinds[0]).toBe("warning");
	});

	it("an expired entry and an empty cache do not print the same ttl message", async () => {
		// The distinction the previous wording lost: both used to end at the bare
		// "Default TTL set to 8h.", so a lapsed window looked like a fresh one.
		const empty = fakeCtx();
		await def.handler("ttl 8h", empty.ctx);
		expect(empty.kinds[0]).toBe("info");
		expect(empty.notified[0]).toBe("Default TTL set to 8h.");

		credentialCache.set("hunter2", 1);
		await new Promise((r) => setTimeout(r, 5));
		const expired = fakeCtx();
		await def.handler("ttl 8h", expired.ctx);
		expect(expired.notified[0]).not.toBe(empty.notified[0]);
	});
});
