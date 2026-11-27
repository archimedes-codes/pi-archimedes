import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialCache } from "./cache.js";

const TTL = 60_000;

describe("CredentialCache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is empty before any set: get() null, isExpired false", () => {
		const cache = new CredentialCache();
		expect(cache.get()).toBeNull();
		expect(cache.isExpired).toBe(false);
	});

	it("returns the credential while within the TTL", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		const got = cache.get();
		expect(got).not.toBeNull();
		expect(got?.password).toBe("hunter2");
		expect(got?.expiresAt).toBe(Date.now() + TTL);
		expect(cache.isExpired).toBe(false);
	});

	it("returns null once the TTL has elapsed (does not auto-clear the entry)", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		vi.advanceTimersByTime(TTL + 1);
		expect(cache.get()).toBeNull();
		// still set, just stale — isExpired flags it until clear()
		expect(cache.isExpired).toBe(true);
	});

	it("isExpired is false exactly at set time and true once the deadline passes", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		expect(cache.isExpired).toBe(false);
		vi.advanceTimersByTime(TTL);
		expect(cache.isExpired).toBe(true);
	});

	it("clear() empties the cache and resets isExpired", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		vi.advanceTimersByTime(TTL + 1);
		expect(cache.isExpired).toBe(true);
		cache.clear();
		expect(cache.get()).toBeNull();
		expect(cache.isExpired).toBe(false);
	});

	it("set() replaces the previous entry with a fresh TTL", () => {
		const cache = new CredentialCache();
		cache.set("first", TTL);
		vi.advanceTimersByTime(TTL - 1000);
		cache.set("second", TTL);
		const got = cache.get();
		expect(got?.password).toBe("second");
		// the fresh entry survives the original deadline
		vi.advanceTimersByTime(1000);
		expect(cache.get()).not.toBeNull();
	});

	it("set() initializes failStreak to 0; bumpFailStreak counts on the live entry; resetFailStreak restores 0", () => {
		const cache = new CredentialCache();
		cache.set("pw", TTL);
		expect(cache.get()?.failStreak).toBe(0);
		cache.bumpFailStreak();
		cache.bumpFailStreak();
		expect(cache.get()?.failStreak).toBe(2);
		cache.resetFailStreak();
		expect(cache.get()?.failStreak).toBe(0);
	});

	it("bumpFailStreak/resetFailStreak on an empty cache are no-ops; a fresh set() restarts the streak", () => {
		const cache = new CredentialCache();
		cache.bumpFailStreak();
		cache.resetFailStreak();
		expect(cache.get()).toBeNull();
		cache.set("a", TTL);
		cache.bumpFailStreak();
		expect(cache.get()?.failStreak).toBe(1);
		cache.set("b", TTL); // same cache, new credential — streak belongs to the entry
		expect(cache.get()?.failStreak).toBe(0);
	});
});

describe("CredentialCache.rettl", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-times a live entry from now without touching the password", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		vi.advanceTimersByTime(30_000);
		expect(cache.rettl(120_000)).toBe(true);
		const got = cache.get();
		expect(got?.password).toBe("hunter2");
		expect(got?.expiresAt).toBe(Date.now() + 120_000);
	});

	it("refuses to revive an expired entry — the window is closed, not merely quiet", () => {
		// Reviving here would reopen the ADR 0033 confirmation gate without a human
		// re-authorizing anything (and on `confirmWhenCached: false`, without a
		// dialog at all) for up to the 30-day cap. `/sudo auth` is the way back: it
		// re-validates the password, which is the thing this cannot do.
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		vi.advanceTimersByTime(TTL + 1);
		expect(cache.get()).toBeNull(); // reads as absent
		expect(cache.rettl(60_000)).toBe(false);
		expect(cache.get()).toBeNull(); // still absent — expiry is final until re-auth
	});

	it("is a no-op on an empty cache and returns false", () => {
		const cache = new CredentialCache();
		expect(cache.rettl(60_000)).toBe(false);
		expect(cache.get()).toBeNull();
	});

	it("does not reset the fail streak", () => {
		const cache = new CredentialCache();
		cache.set("hunter2", TTL);
		cache.bumpFailStreak();
		cache.bumpFailStreak();
		cache.rettl(120_000);
		expect(cache.get()?.failStreak).toBe(2);
	});
});
