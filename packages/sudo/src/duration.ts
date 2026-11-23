/**
 * Duration parsing for the `/sudo` subcommands (`auth <ttl>`, `ttl <ttl>`).
 *
 * Accepts a plain millisecond count (`900000`) or a compound unit string
 * (`15m`, `2h30m`, `1d12h`, `500ms`, `90s`) — the same shapes a user types
 * at the command line. Pure and unit-testable; the command layer turns a
 * null result into a usage hint rather than an error.
 */

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** Upper bound for a parsed duration: 30 days. Beyond this a typo is the likely cause. */
export const MAX_DURATION_MS = 30 * 86_400_000;

/**
 * Parse a duration string into milliseconds, or null when it is not a
 * recognizable duration. `null` (not an error) keeps the caller's UX branch
 * trivial. Rejects zero and anything above MAX_DURATION_MS.
 */
export function parseDuration(input: string): number | null {
	const text = input.trim().toLowerCase();
	if (text === "") return null;

	// Plain integer: milliseconds.
	if (/^\d+$/.test(text)) return bounded(Number(text));

	// Compound unit string: one or more <number><unit> groups, nothing else.
	// `2h30m`, `1d`, `500ms`, `90s` — but not `2x30m`, `m30`, or `-1h`.
	let total = 0;
	let consumed = 0;
	for (const match of text.matchAll(/(\d+)(ms|[smhd])/g)) {
		total += Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0);
		consumed += match[0].length;
	}
	if (consumed !== text.length) return null; // stray characters — not a duration
	return bounded(total);
}

function bounded(ms: number): number | null {
	if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_DURATION_MS) return null;
	return ms;
}

/** Human-readable short form for notify lines: `15m`, `2h30m`, `1d`. */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0ms";
	const parts: string[] = [];
	let rest = ms;
	for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) {
		if (rest >= size) {
			const n = Math.floor(rest / size);
			parts.push(`${n}${unit}`);
			rest -= n * size;
		}
	}
	if (rest > 0) parts.push(`${rest}ms`);
	return parts.join("") || `${ms}ms`;
}
