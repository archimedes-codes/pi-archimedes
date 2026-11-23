import { describe, expect, it } from "vitest";
import { MAX_DURATION_MS, formatDuration, parseDuration } from "./duration.js";

describe("parseDuration", () => {
	it("parses a plain millisecond count", () => {
		expect(parseDuration("900000")).toBe(900_000);
	});

	it("parses single units", () => {
		expect(parseDuration("15m")).toBe(900_000);
		expect(parseDuration("1h")).toBe(3_600_000);
		expect(parseDuration("90s")).toBe(90_000);
		expect(parseDuration("1d")).toBe(86_400_000);
		expect(parseDuration("500ms")).toBe(500);
	});

	it("parses compound units", () => {
		expect(parseDuration("2h30m")).toBe(9_000_000);
		expect(parseDuration("1d12h")).toBe(129_600_000);
		expect(parseDuration("1h0m")).toBe(3_600_000);
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseDuration(" 15M ")).toBe(900_000);
	});

	it("rejects non-durations", () => {
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("m30")).toBeNull();
		expect(parseDuration("2x30m")).toBeNull();
		expect(parseDuration("-1h")).toBeNull();
		expect(parseDuration("session")).toBeNull();
		expect(parseDuration("15 m")).toBeNull();
	});

	it("rejects zero and negatives-as-strings", () => {
		expect(parseDuration("0")).toBeNull();
		expect(parseDuration("0m")).toBeNull();
	});

	it("rejects values above the 30-day cap", () => {
		expect(parseDuration(String(MAX_DURATION_MS + 1))).toBeNull();
		expect(parseDuration("31d")).toBeNull();
		expect(parseDuration(String(MAX_DURATION_MS))).toBe(MAX_DURATION_MS);
	});
});

describe("formatDuration", () => {
	it("renders the largest units first and skips zero units", () => {
		expect(formatDuration(900_000)).toBe("15m");
		expect(formatDuration(7_800_000)).toBe("2h10m");
		expect(formatDuration(86_400_000)).toBe("1d");
		expect(formatDuration(500)).toBe("500ms");
	});

	it("round-trips through parseDuration", () => {
		for (const ms of [500, 90_000, 900_000, 7_800_000, MAX_DURATION_MS]) {
			expect(parseDuration(formatDuration(ms))).toBe(ms);
		}
	});
});
