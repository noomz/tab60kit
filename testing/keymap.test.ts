// Plan U9: the key table and the keymap diff. The table's ROM bytes are checked locally by testing/real-image.ts (CI
// has no vendor bytes); these tests check its shape. The generators are seeded, as in egress-property.test.ts, so a
// failure names a case that repeats.
import { expect, test } from "bun:test";
import { type KeyId, type KeymapDoc, type Layer, TAB60_KEYS, type Usage, keyId, planKeymap, usage } from "../core/keymap";

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

type Grid = Map<Layer, Map<KeyId, Usage>>;
const LAYERS: readonly Layer[] = [0, 1, 2, 3];
const CAPS = TAB60_KEYS.map((cap) => cap.id);

/** mulberry32, as in egress-property.test.ts. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
	const below = (n: number) => Math.floor(next() * n);
	const chance = (p: number) => next() < p;
	const pick = <T>(from: readonly T[]): T => from[below(from.length)]!;
	/** Often a small set of usages, so overrides and observed cells collide. */
	const anyUsage = () => usage(chance(0.7) ? pick([0x00, 0x04, 0x29, 0xe0, 0xe7]) : below(0xe8));
	/** Random cells on random layers; a layer may be present and empty. */
	const grid = (cells: readonly KeyId[], fill: number): Grid => {
		const out: Grid = new Map();
		for (const layer of LAYERS) {
			if (!chance(0.7)) continue;
			const keys = new Map<KeyId, Usage>();
			for (const key of cells) if (chance(fill)) keys.set(key, anyUsage());
			out.set(layer, keys);
		}
		return out;
	};
	const doc = (): KeymapDoc => ({ overrides: grid(CAPS, pick([0, 0.05, 0.3, 1])), osMode: chance(0.5) ? null : pick([0, 1, 2, 3, 4] as const) });
	return { below, chance, pick, grid, doc };
}

const copy = (g: ReadonlyMap<Layer, ReadonlyMap<KeyId, Usage>>): Grid => new Map([...g].map(([layer, keys]) => [layer, new Map(keys)]));

test("planKeymap writes nothing when the board already holds every override", () => {
	const r = random(0x0955_0001);
	for (let i = 0; i < 1_000; i++) {
		const doc = r.doc();
		const observed = r.grid(CAPS, 0.5);
		for (const [layer, keys] of doc.overrides) observed.set(layer, new Map([...(observed.get(layer) ?? []), ...keys]));
		expect(planKeymap(doc, observed)).toEqual([]);
	}
});

test("10,000 random documents: applying the writes gives back every override and touches nothing else", () => {
	const r = random(0x0955_0002);
	const MATRIX = Array.from({ length: 80 }, (_, i) => keyId(i));
	for (let i = 0; i < 10_000; i++) {
		const doc = r.doc();
		const observed = r.grid(r.chance(0.5) ? CAPS : MATRIX, r.pick([0, 0.2, 0.9]));
		const writes = planKeymap(doc, observed);
		const where = `case ${i}`;
		const board = copy(observed);
		for (const w of writes) {
			const keys = board.get(w.layer) ?? new Map<KeyId, Usage>();
			if (keys.get(w.key) === w.usage) throw new Error(`${where}: a write to layer ${w.layer} key ${w.key} changes nothing`);
			keys.set(w.key, w.usage);
			board.set(w.layer, keys);
		}
		for (const [layer, keys] of doc.overrides) {
			for (const [key, want] of keys) if (board.get(layer)?.get(key) !== want) throw new Error(`${where}: layer ${layer} key ${key} reads back wrong`);
		}
		for (const [layer, keys] of board) {
			for (const [key, held] of keys) {
				const override = doc.overrides.get(layer)?.get(key);
				if (override === undefined && observed.get(layer)?.get(key) !== held) throw new Error(`${where}: layer ${layer} key ${key} changed without an override`);
			}
		}
		const order = writes.map((w) => w.layer * 80 + w.key);
		for (let j = 1; j < order.length; j++) if (order[j]! <= order[j - 1]!) throw new Error(`${where}: writes are not in layer, key order`);
	}
});
