import { loadConfig, saveConfig } from "@pi-archimedes/core/settings-io";

export interface SudoConfig {
	/**
	 * Suite-managed by meta's plugin gate (archimedes.sudo.enabled, ADR 0012).
	 * sudo NEVER reads this key — when off, meta skips registerSudo entirely.
	 * Declared here only so settings editors see the shape.
	 */
	enabled?: boolean;
	/** Password cache TTL in ms. Default 15 min. */
	ttlMs: number;
	/** sudo_exec default command timeout in ms. Default 120 s. */
	defaultTimeoutMs: number;
	/**
	 * Ask for confirmation before every `sudo_exec`, even when a credential is
	 * already cached. Default `true` — the confirmation is the last human gate
	 * once the password is cached (ADR 0010, ADR 0033). Set it to `false` to
	 * confirm only on the runs that will ask for a password, i.e. the first one
	 * per session, and to accept that the agent can then run privileged commands
	 * unattended for the rest of the cache TTL.
	 */
	confirmWhenCached: boolean;
}

export const DEFAULT_SUDO_CONFIG: SudoConfig = {
	ttlMs: 900_000,
	defaultTimeoutMs: 120_000,
	confirmWhenCached: true,
};

export function loadSudoConfig(): SudoConfig {
	return loadConfig("archimedes.sudo", DEFAULT_SUDO_CONFIG);
}

export function saveSudoConfig(config: SudoConfig): void {
	saveConfig("archimedes.sudo", config);
}
