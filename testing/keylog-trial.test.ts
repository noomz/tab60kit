import { expect, test } from "bun:test";
import { type KeyEvent, PHRASE, editCounts, parseKeylogTrial, perfectTrial, summarizeTrial } from "../lab/keylog-trial";

test("editCounts aligns as the harness does: a dropped, an added, and a swapped character", () => {
	expect(editCounts("abc", "abc")).toEqual({ missing: 0, extra: 0 });
	expect(editCounts("abc", "ac")).toEqual({ missing: 1, extra: 0 });
	expect(editCounts("abc", "abxc")).toEqual({ missing: 0, extra: 1 });
	expect(editCounts("abc", "axc")).toEqual({ missing: 1, extra: 1 });
	expect(editCounts(PHRASE, "")).toEqual({ missing: PHRASE.length, extra: 0 });
});

test("a perfect trial has no autorepeat, no lost key-up, nothing missing, and its first key first", () => {
	expect(summarizeTrial(perfectTrial())).toEqual({ downs: PHRASE.length, repeats: 0, lostUps: 0, missing: 0, extra: 0, firstKeyDelivered: true });
});

test("an autorepeat, a key-down with no key-up, and a lost first key each count", () => {
	const { events } = perfectTrial();
	const t = (events[0] as KeyEvent).t;
	const repeat: KeyEvent = { t, ty: "d", c: "KeyT", k: "t", r: true };
	expect(summarizeTrial({ typed: PHRASE, events: [events[0]!, repeat, ...events.slice(1)] }).repeats).toBe(1);
	expect(summarizeTrial({ typed: PHRASE, events: events.filter((_, i) => i !== 1) }).lostUps).toBe(1);
	expect(summarizeTrial({ typed: PHRASE.slice(1), events: events.slice(2) })).toMatchObject({ missing: 1, firstKeyDelivered: false });
});

test("parseKeylogTrial reads back what the page stores and refuses anything else", () => {
	const trial = perfectTrial(5);
	expect(parseKeylogTrial(JSON.stringify(trial))).toEqual(trial);
	expect(() => parseKeylogTrial(JSON.stringify({ typed: "x", events: [{ t: 0, ty: "x", c: "KeyX", k: "x", r: false }] }))).toThrow("not a key event");
	expect(() => parseKeylogTrial("[]")).toThrow("not a keylog trial");
});
