/**
 * The keylog typing harness as a pure module, so the U7 page records its trials in the
 * transcript and tools/u7-verdict.ts recounts them from the raw events. The phrase, the edit counts, and the per-trial
 * summary are the harness's, line for line; only the pass bar is new, from unit U7.
 */

/** The harness's phrase: 54 characters, so three trials type 162. */
export const PHRASE = "the quick brown fox jumps over the lazy dog 1234567890";
export const TRIALS = 3;
/** Plan U7: at most 1 of 162 characters missing, 0 autorepeats, 0 lost key-ups, and the first key delivered every trial. */
export const MAX_MISSING = 1;

/** One keyboard event, as the harness logs it: page time in ms, down or up, `code`, `key`, and `repeat`. */
export interface KeyEvent {
	readonly t: number;
	readonly ty: "d" | "u";
	readonly c: string;
	readonly k: string;
	readonly r: boolean;
}

export interface KeylogTrial {
	readonly typed: string;
	readonly events: readonly KeyEvent[];
}

export interface TrialSummary {
	readonly downs: number;
	readonly repeats: number;
	readonly lostUps: number;
	readonly missing: number;
	readonly extra: number;
	readonly firstKeyDelivered: boolean;
}

/** Levenshtein alignment of the phrase against what was typed: characters missing from it and characters added. */
export function editCounts(a: string, b: string): { readonly missing: number; readonly extra: number } {
	const n = a.length;
	const m = b.length;
	const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	const at = (i: number, j: number) => d[i]![j]!;
	for (let i = 0; i <= n; i++) d[i]![0] = i;
	for (let j = 0; j <= m; j++) d[0]![j] = j;
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) d[i]![j] = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1));
	}
	let i = n;
	let j = m;
	let missing = 0;
	let extra = 0;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && at(i, j) === at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1)) {
			if (a[i - 1] !== b[j - 1]) {
				missing++;
				extra++;
			}
			i--;
			j--;
		} else if (i > 0 && at(i, j) === at(i - 1, j) + 1) {
			missing++;
			i--;
		} else {
			extra++;
			j--;
		}
	}
	return { missing, extra };
}

/** The harness's `summarize`, without hold times, plus whether the phrase's first character arrived first. */
export function summarizeTrial({ typed, events }: KeylogTrial): TrialSummary {
	const keys = events.filter((event) => event.c !== "Enter");
	const open = new Set<string>();
	let downs = 0;
	let repeats = 0;
	let lostUps = 0;
	for (const event of keys) {
		if (event.ty === "d" && !event.r) {
			downs++;
			if (open.has(event.c)) lostUps++;
			open.add(event.c);
		} else if (event.ty === "d") repeats++;
		else open.delete(event.c);
	}
	lostUps += open.size;
	const first = keys.find((event) => event.ty === "d" && !event.r);
	return { downs, repeats, lostUps, ...editCounts(PHRASE, typed), firstKeyDelivered: typed.startsWith(PHRASE[0]!) && first?.k === PHRASE[0] };
}

/** The events a keyboard that drops nothing sends for the phrase and Enter. The fake board's page and the tests type with it. */
export function perfectTrial(start = 0): KeylogTrial {
	const events: KeyEvent[] = [];
	let t = start;
	for (const k of [...PHRASE, "Enter"]) {
		const c = k === "Enter" ? "Enter" : k === " " ? "Space" : /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`;
		events.push({ t: (t += 80), ty: "d", c, k, r: false }, { t: (t += 40), ty: "u", c, k, r: false });
	}
	return { typed: PHRASE, events };
}

/** Parses a trial the page stored as a mark's text. Throws TypeError on anything else. */
export function parseKeylogTrial(text: string): KeylogTrial {
	const json: unknown = JSON.parse(text);
	const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
	if (!isRecord(json) || typeof json.typed !== "string" || !Array.isArray(json.events)) throw new TypeError("not a keylog trial");
	const events = json.events.map((event: unknown): KeyEvent => {
		if (!isRecord(event) || typeof event.t !== "number" || (event.ty !== "d" && event.ty !== "u") || typeof event.c !== "string" || typeof event.k !== "string" || typeof event.r !== "boolean") {
			throw new TypeError("not a key event");
		}
		return { t: event.t, ty: event.ty, c: event.c, k: event.k, r: event.r };
	});
	return { typed: json.typed, events };
}
