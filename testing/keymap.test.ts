// Plan U9: the key table. Its ROM bytes are checked locally by testing/real-image.ts (CI has no vendor bytes); these
// tests check its shape.
import { expect, test } from "bun:test";
import { TAB60_KEYS } from "../core/keymap";

/** The cells that hold a usage in ROM but are not caps on the ANSI board: ISO #, Grave, ISO \, and 0xC9. */
const NOT_CAPS = [53, 57, 71, 79];

test("TAB60_KEYS has 61 caps with unique ids, none of them a non-cap cell", () => {
	const ids = TAB60_KEYS.map((cap) => Number(cap.id));
	expect(ids).toHaveLength(61);
	expect(new Set(ids).size).toBe(61);
	for (const cell of NOT_CAPS) expect(ids).not.toContain(cell);
});

test("each row is 15 units wide, its caps contiguous from x 0, in order of x", () => {
	for (const row of [0, 1, 2, 3, 4]) {
		const caps = TAB60_KEYS.filter((cap) => cap.row === row);
		let x = 0;
		for (const cap of caps) {
			expect(cap.x).toBe(x);
			x += cap.width;
		}
		expect(x).toBe(15);
	}
	expect(TAB60_KEYS.map((cap) => cap.row)).toEqual(TAB60_KEYS.map((cap) => cap.row).sort());
});

test("the bottom row reads Ctrl Win Alt Space Alt Fn Pn Ctrl", () => {
	expect(TAB60_KEYS.filter((cap) => cap.row === 4).map((cap) => cap.legend)).toEqual(["Ctrl", "Win", "Alt", "Space", "Alt", "Fn", "Pn", "Ctrl"]);
});
