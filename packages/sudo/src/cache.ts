/**
 * In-memory credential cache for sudo_exec (ADR 0010).
 *
 * A single credential at a time, kept ONLY in memory for the process — never
 * written to disk or the OS keyring. pi caches an extension module per process
 * and re-invokes the factory per session, so the one thing separating two
 * sessions in a process is the unconditional session_start/session_shutdown
 * clears in index.ts (ADR 0033's Consequences spell out what that means for a
 * subordinate in-process session). Expired entries return null from
 * get() (triggering a re-prompt) but are not auto-cleared; clear() is called
 * on session_shutdown, /sudo forget, and auth failure to drop the password
 * from memory entirely. No host/user keying in v1.
 */
export interface CachedCredential {
	password: string;
	expiresAt: number;
	/**
	 * Consecutive ambiguous command failures (non-terminal credential probe
	 * after an unrecognized-signature failure) under THIS entry. The tool's
	 * two-strike rule bumps/resets it; a fresh set() restarts it at 0.
	 */
	failStreak: number;
}

export class CredentialCache {
	private entry: CachedCredential | null = null;

	/** Set (or replace) the cached credential with a fresh TTL (and a zeroed fail streak). */
	set(password: string, ttlMs: number): void {
		this.entry = { password, expiresAt: Date.now() + ttlMs, failStreak: 0 };
	}

	/** Return the cached credential, or null if unset or expired. */
	get(): CachedCredential | null {
		if (this.entry === null) return null;
		if (Date.now() >= this.entry.expiresAt) return null;
		return this.entry;
	}

	/** Drop the credential from memory entirely. */
	clear(): void {
		this.entry = null;
	}

	/** Bump the current entry's failStreak (no-op when the cache is empty). */
	bumpFailStreak(): void {
		if (this.entry !== null) this.entry.failStreak += 1;
	}

	/** Reset the current entry's failStreak (no-op when the cache is empty). */
	resetFailStreak(): void {
		if (this.entry !== null) this.entry.failStreak = 0;
	}

	/** True when an entry is present but past its expiry. */
	get isExpired(): boolean {
		return this.entry !== null && Date.now() >= this.entry.expiresAt;
	}
}

/**
 * Module-level singleton, process-scoped: pi caches an extension module per
 * process, so this object outlives a session and is shared by any session in
 * the same process. It is cleared — never recreated — by the `session_start` /
 * `session_shutdown` handlers in index.ts (every session's, not just the one
 * that filled it), plus `/sudo forget` and auth failure. See ADR 0033.
 */
export const credentialCache = new CredentialCache();
