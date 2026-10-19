// Plan U9: the key table, the keymap diff, and the document parse. The table's ROM bytes are checked locally by
// testing/real-image.ts (CI has no vendor bytes); these tests check its shape. The generators are seeded, as in
// egress-property.test.ts, so a failure names a case that repeats.
import { expect, test } from "bun:test";
import { type KeyId, type KeymapDoc, type Layer, TAB60_KEYS, type Usage, activeKeymap, keyId, parseKeymapDoc, parseOverrideEntry, planKeymap, predictCleanLayer, romKeymap, serializeKeymapDoc, usage } from "../core/keymap";

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
const LAYERS: readonly Layer[] = [0, 1, 2];
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

const canonical = (overrides: Record<string, Record<string, unknown>> = { "0": { "41": 41 } }, osMode: unknown = null) => ({
	format: "tab60kit-keymap",
	version: 1,
	osMode,
	overrides,
});

test("parseKeymapDoc reads the canonical shape", () => {
	const doc = parseKeymapDoc(canonical({ "0": { "41": 41, "4": 0xe0 }, "2": {} }, 2));
	expect(doc).toEqual({
		overrides: new Map<Layer, Map<KeyId, Usage>>([
			[0, new Map([[keyId(4), usage(0xe0)], [keyId(41), usage(41)]])],
			[2, new Map()],
		]),
		osMode: 2,
	});
});

test("parseKeymapDoc rejects each malformed field with its path", () => {
	const cases: readonly [unknown, string][] = [
		[null, "$: "],
		[[], "$: "],
		["{}", "$: "],
		[{ ...canonical(), extra: 1 }, "$.extra: "],
		[{ version: 1, osMode: null, overrides: {} }, "$.format: is missing"],
		[{ ...canonical(), format: "via" }, "$.format: "],
		[{ ...canonical(), version: 2 }, "$.version: "],
		[{ ...canonical(), version: "1" }, "$.version: "],
		[canonical(undefined, 5), "$.osMode: "],
		[canonical(undefined, 1.5), "$.osMode: "],
		[canonical(undefined, "1"), "$.osMode: "],
		[{ ...canonical(), overrides: [] }, "$.overrides: "],
		[{ ...canonical(), overrides: null }, "$.overrides: "],
		[canonical({ "3": {} }), "$.overrides.3: is not a layer from 0 to 2"],
		[canonical({ "4": {} }), "$.overrides.4: "],
		[canonical({ "-1": {} }), "$.overrides.-1: "],
		[canonical({ "00": {} }), "$.overrides.00: "],
		[canonical({ base: {} }), "$.overrides.base: "],
		[canonical({ "0": [] as unknown as Record<string, unknown> }), "$.overrides.0: "],
		[canonical({ "1": 5 as unknown as Record<string, unknown> }), "$.overrides.1: "],
		...[53, 57, 71, 79, 55, 80, 255].map((cell): [unknown, string] => [canonical({ "0": { [cell]: 4 } }), `$.overrides.0.${cell}: `]),
		[canonical({ "0": { "041": 4 } }), "$.overrides.0.041: "],
		[canonical({ "0": { "4.0": 4 } }), "$.overrides.0.4.0: "],
		[canonical({ "0": { esc: 4 } }), "$.overrides.0.esc: "],
		[canonical({ "2": { "4": 0xe8 } }), "$.overrides.2.4: "],
		[canonical({ "2": { "4": -1 } }), "$.overrides.2.4: "],
		[canonical({ "2": { "4": 4.5 } }), "$.overrides.2.4: "],
		[canonical({ "2": { "4": "4" } }), "$.overrides.2.4: "],
		[canonical({ "2": { "4": null } }), "$.overrides.2.4: "],
	];
	for (const [json, prefix] of cases) {
		const got = parseKeymapDoc(json);
		if (!("error" in got)) throw new Error(`accepted ${JSON.stringify(json)}`);
		expect(got.error.startsWith(prefix)).toBe(true);
	}
});

test("1,000 random documents round-trip through serialize and parse, and serialize is canonical", () => {
	const r = random(0x0955_0003);
	for (let i = 0; i < 1_000; i++) {
		const doc = r.doc();
		const text = serializeKeymapDoc(doc);
		const back = parseKeymapDoc(JSON.parse(text));
		expect(back).toEqual(doc);
		expect(serializeKeymapDoc(back as KeymapDoc)).toBe(text);
	}
});

test("serialize of a parsed canonical string returns the same string, sorted", () => {
	const text = '{\n\t"format": "tab60kit-keymap",\n\t"version": 1,\n\t"osMode": null,\n\t"overrides": {\n\t\t"0": {\n\t\t\t"41": 41\n\t\t},\n\t\t"2": {}\n\t}\n}\n';
	expect(serializeKeymapDoc(parseKeymapDoc(JSON.parse(text)) as KeymapDoc)).toBe(text);
	const unsorted: KeymapDoc = {
		overrides: new Map<Layer, Map<KeyId, Usage>>([[2, new Map([[keyId(41), usage(1)], [keyId(4), usage(2)]])], [1, new Map()]]),
		osMode: 4,
	};
	expect(serializeKeymapDoc(unsorted)).toBe(
		'{\n\t"format": "tab60kit-keymap",\n\t"version": 1,\n\t"osMode": 4,\n\t"overrides": {\n\t\t"1": {},\n\t\t"2": {\n\t\t\t"4": 2,\n\t\t\t"41": 1\n\t\t}\n\t}\n}\n',
	);
});

test("parseOverrideEntry reads absent, default, and flags << 8 | usage", () => {
	expect([0x0003, 0x00ff, 0x0004, 0x0204, 0x03e7, 0x0103].map(parseOverrideEntry)).toEqual([
		{ kind: "absent" },
		{ kind: "default" },
		{ kind: "override", usage: usage(0x04), flags: 0 },
		{ kind: "override", usage: usage(0x04), flags: 2 },
		{ kind: "override", usage: usage(0xe7), flags: 3 },
		{ kind: "override", usage: usage(0x03), flags: 1 },
	]);
});

test("parseOverrideEntry throws on a word that fits no entry", () => {
	for (const word of [0x0400, 0x0404, 0xff04, 0x01ff, 0x03ff, 0x00e8, 0x10000, -1, 1.5]) {
		expect(() => parseOverrideEntry(word)).toThrow(RangeError);
	}
});

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** docs/app-firmware.md "OS key mode", from predict.py over the V1.01.13 image. */
const CLEAN_PRESENT = [0x00, ...range(0x04, 0x39), 0x64, 0xc9, 0xd8, 0xd9, ...range(0xe0, 0xe6)];

test("a clean store predicts 0x00FF for exactly the usages predict.py finds in the active keymap, and 0x0003 for the rest", () => {
	const predicted = predictCleanLayer(activeKeymap());
	expect([...predicted.keys()]).toEqual(range(0, 255));
	expect([...predicted].filter(([, entry]) => entry.kind === "default").map(([k]) => k)).toEqual(CLEAN_PRESENT);
	expect([...predicted].filter(([, entry]) => entry.kind !== "default").every(([, entry]) => entry.kind === "absent")).toBe(true);
});

test("the active keymap is the ROM keymap with Fn (cell 60) and Pn (cell 54) replaced by the markers 0xD8 and 0xD9", () => {
	const rom = romKeymap();
	const active = activeKeymap();
	expect([rom.length, rom[60], rom[54], active[60], active[54]]).toEqual([80, 0xe7, 0x65, 0xd8, 0xd9]);
	expect(active.filter((cell, at) => cell !== rom[at])).toEqual([0xd9, 0xd8]);
});
