import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { credentialCache } from "./cache.js";
import { splitCommandIntoArgv } from "./argv-split.js";
import { DEFAULT_SUDO_CONFIG, loadSudoConfig, saveSudoConfig, type SudoConfig } from "./config.js";
import { formatDuration, parseDuration } from "./duration.js";
import { handleBashToolCall, isInteractiveSudoAttempt, type GuardResult } from "./guard.js";
import { confirmCommand, maskLine, promptForPassword } from "./prompt.js";
import { buildSudoArgv, createSudoExecTool, defaultSpawner, probeSudoPasswordStrict, registerSudoTool, AUTH_PROBE_TIMEOUT_MS, scrubSecret, type SudoSpawner } from "./tool.js";

/** Presets offered by the second-level completions and the interactive TTL picker. */
const TTL_PRESETS = ["15m", "30m", "1h", "4h", "8h"] as const;

/**
 * Registers `sudo_exec` (Task 1), the bash-sudo guard (Task 2) — a
 * `pi.on("tool_call")` veto that blocks interactive `sudo` issued through
 * the built-in bash tool — and the session lifecycle + `/sudo` command
 * (Task 3). ALL registrations happen at the top level of this function,
 * never inside a session handler (nested registration accumulates on
 * `/reload`).
 */
export function registerSudo(pi: ExtensionAPI, options?: { spawner?: SudoSpawner }): void {
	// One spawner for the whole registration: the tool seam is the same seam the
	// `/sudo auth` probe goes through, so tests (and any embedder) inject one
	// fake and it reaches every privileged call this extension makes.
	const spawner = options?.spawner ?? defaultSpawner;
	registerSudoTool(pi, options);
	// Active veto: the guard is pure (isInteractiveSudoAttempt) and exported for
	// direct testing; handleBashToolCall only vets — it never mutates event.input.
	pi.on("tool_call", (event) => handleBashToolCall(event));

	// Session lifecycle: the credential is a module singleton, so any session
	// boundary clears it (ADR 0010) — every session's handlers, not just the one
	// that filled it, which is what keeps an in-process subordinate session from
	// inheriting it indefinitely (ADR 0033, Consequences).
	pi.on("session_start", () => {
		credentialCache.clear();
	});
	pi.on("session_shutdown", () => {
		credentialCache.clear();
	});

	/** Human-readable state line shared by bare `/sudo` and the subcommands. */
	const stateLine = (): string => {
		const entry = credentialCache.get();
		if (entry === null) {
			const stale = credentialCache.isExpired ? " (expired — re-prompts on next use)" : "";
			return `No valid sudo credential cached${stale}. Default TTL: ${formatDuration(loadSudoConfig().ttlMs)} (\`/sudo auth\` to pre-authorize).`;
		}
		return `Sudo credential cached — ${formatDuration(entry.expiresAt - Date.now())} remaining. Default TTL: ${formatDuration(loadSudoConfig().ttlMs)}.`;
	};

	/**
	 * `/sudo ttl [duration|default]` — show, set (persistently), or reset the
	 * default TTL, and re-time a live cached entry to match. A bare `/sudo ttl`
	 * opens the interactive picker; a duration argument sets directly.
	 */
	const runTtl = async (arg: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (arg === "") {
			// Interactive picker — the TUI path for feature 2. Persisted via
			// saveSudoConfig; the same result is reachable non-interactively via
			// `/sudo ttl <duration>` (headless-safe).
			const choice = await ctx.ui.select("Sudo credential default TTL", [...TTL_PRESETS, "cancel"]);
			if (choice === undefined || choice === "cancel") return;
			await runTtl(choice, ctx);
			return;
		}
		if (arg === "default") {
			const config = loadSudoConfig();
			saveSudoConfig({ ...config, ttlMs: DEFAULT_SUDO_CONFIG.ttlMs });
			if (credentialCache.rettl(DEFAULT_SUDO_CONFIG.ttlMs)) {
				ctx.ui.notify(`TTL reset to the default ${formatDuration(DEFAULT_SUDO_CONFIG.ttlMs)}; the cached credential was re-timed to match.`, "info");
			} else {
				ctx.ui.notify(`TTL reset to the default ${formatDuration(DEFAULT_SUDO_CONFIG.ttlMs)}.`, "info");
			}
			return;
		}
		const ttlMs = parseDuration(arg);
		if (ttlMs === null) {
			ctx.ui.notify(`Not a duration: "${arg}". Use e.g. 15m, 2h30m, 1d, or "default" to reset. A bare number means milliseconds.`, "error");
			return;
		}
		saveSudoConfig({ ...loadSudoConfig(), ttlMs });
		if (credentialCache.rettl(ttlMs)) {
			ctx.ui.notify(`Default TTL set to ${formatDuration(ttlMs)}; the cached credential was re-timed to match.`, "info");
		} else {
			ctx.ui.notify(`Default TTL set to ${formatDuration(ttlMs)}.`, "info");
		}
	};

	/**
	 * `/sudo auth [duration]` — pre-authorize NOW: masked prompt, the password
	 * validated with the same no-program `sudo -S -v` probe the tool uses, then
	 * cached with an optional one-off TTL. This is the user acting, not the
	 * model: the credential and its window are created exactly as if the user
	 * had typed the password into the first `sudo_exec` prompt, just earlier
	 * and with an explicit duration (ADR 0034).
	 */
	const runAuth = async (arg: string, ctx: ExtensionCommandContext): Promise<void> => {
		let ttlMs = loadSudoConfig().ttlMs;
		if (arg !== "") {
			const parsed = parseDuration(arg);
			if (parsed === null) {
				ctx.ui.notify(`Not a duration: "${arg}". Use e.g. /sudo auth 2h30m, or /sudo auth for the default TTL. A bare number means milliseconds.`, "error");
				return;
			}
			ttlMs = parsed;
		}
		// promptForPassword REJECTS outside a TUI (and outside bridge mode). Left
		// uncaught this escapes the handler and pi reports it as an extension error
		// on `command:sudo` quoting sudo_exec — the wrong command, on a channel the
		// user reading `/sudo auth` cannot act on. Turn it into a notify instead.
		const password = await promptForPassword(
			ctx,
			"",
			"pre-authorization — the password is validated and cached; it never enters the conversation",
		).catch(() => {
			ctx.ui.notify("/sudo auth needs an interactive session — there is no masked password prompt here, so nothing was validated or cached.", "error");
			return "";
		});
		if (!password) {
			ctx.ui.notify("Cancelled — nothing was validated or cached.", "info");
			return;
		}
		const ok = await probeSudoPasswordStrict(password, AUTH_PROBE_TIMEOUT_MS, undefined, spawner);
		if (!ok) {
			ctx.ui.notify("Sudo rejected that password — nothing was cached.", "error");
			return;
		}
		credentialCache.set(password, ttlMs);
		// "verified" is only true when sudo read the password. Under a NOPASSWD
		// policy `sudo -k -S -v` exits 0 without reading stdin, so a typo reaches
		// this line — say what was established instead of what was assumed.
		ctx.ui.notify(
			`Sudo credential cached — ${formatDuration(ttlMs)} from now. sudo accepted it (a NOPASSWD policy accepts without reading a password, so on such a host this says nothing about the typed value). /sudo forget expires it immediately.`,
			"info",
		);
	};

	// /sudo — credential cache management. Bare: state. Subcommands: auth
	// (pre-authorize, optional one-off TTL), ttl (show/set/reset the default,
	// re-timing a live entry), forget (expire immediately). Second-level
	// completions make the subcommands discoverable from the TUI — without
	// them, `/sudo ` shows no candidates and the subcommands stay invisible.
	pi.registerCommand("sudo", {
		description: "Manage the sudo credential cache (auth | ttl | forget)",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			const head = parts[0] ?? "";
			const tail = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
			if (head === "auth" || head === "ttl") {
				// Second level ("auth ", "auth 1"): TTL presets, filtered by what's
				// typed. A second word fully typed ("auth 2h") or a third word is
				// deep enough — let the handler speak.
				if (tail === undefined || parts.length > 2) return null;
				// `default` is a `ttl` word only: `auth default` is not a duration.
				const choices = head === "ttl" ? [...TTL_PRESETS, "default"] : [...TTL_PRESETS];
				const items = choices
					.filter((v) => v.startsWith(tail))
					// pi REPLACES the whole argument string with the chosen `value`,
					// so the subcommand has to be part of it — a bare "1h" would
					// produce `/sudo 1h` and the handler rejects the unknown word.
					.map((value) => ({
						value: `${head} ${value}`,
						label: value,
						description:
							value === "default"
								? "reset to the package default (15m)"
								: `TTL preset — ${formatDuration(parseDuration(value) ?? 0)}`,
					}));
				return items.length > 0 ? items : null;
			}
			const items = [
				{ value: "auth", label: "auth", description: "pre-authorize now — validate and cache the password (optional TTL, e.g. auth 2h)" },
				{ value: "ttl", label: "ttl", description: "show/set/reset the default TTL (e.g. ttl 1h, ttl default)" },
				{ value: "forget", label: "forget", description: "expire the cached credential immediately" },
			].filter((i) => i.value.startsWith(head));
			return items.length > 0 ? items : null;
		},
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const args = _args.trim();
			const space = args.indexOf(" ");
			const sub = space === -1 ? args : args.slice(0, space);
			const rest = space === -1 ? "" : args.slice(space + 1).trim();
			switch (sub) {
				case "":
					// Bare: report state. get() is expiry-aware, so a stale entry reads
					// as "not cached" (it re-prompts on next use) without being dropped.
					ctx.ui.notify(stateLine(), "info");
					return;
				case "auth":
					await runAuth(rest, ctx);
					return;
				case "ttl":
					await runTtl(rest, ctx);
					return;
				case "forget":
					// Immediate expiry (ADR 0034): the cached password is dropped from
					// memory entirely — the existing semantics, unchanged.
					credentialCache.clear();
					ctx.ui.notify("Sudo credential cleared — expired immediately.", "info");
					return;
				default:
					ctx.ui.notify(`Unknown /sudo subcommand "${sub}". Usage: /sudo [auth [ttl] | ttl [duration|default] | forget]`, "error");
					return;
			}
		},
	});
}

// Exports for Tasks 2–3 (guard wiring, /sudo command + session lifecycle)
export {
	credentialCache,
	splitCommandIntoArgv,
	buildSudoArgv,
	scrubSecret,
	confirmCommand,
	promptForPassword,
	maskLine,
	loadSudoConfig,
	saveSudoConfig,
	DEFAULT_SUDO_CONFIG,
	createSudoExecTool,
	handleBashToolCall,
	isInteractiveSudoAttempt,
};
export type { SudoConfig, SudoSpawner, GuardResult };

// Standalone entry — pi's loader requires a default export (see the
// image-paste fix precedent). Under meta, the named exports are used.
export default function (pi: ExtensionAPI): void {
	registerSudo(pi);
}
