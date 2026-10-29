// Unit U9: the key table, the keymap diff, and the document parse. The table's ROM bytes are checked locally by
// testing/real-image.ts (CI has no vendor bytes); these tests check its shape. The generators are seeded, as in
// egress-property.test.ts, so a failure names a case that repeats.
import { expect, test } from "bun:test";
import type { OverrideEntry } from "../core/protocol";
import { FACTORY_LAYER2, type KeyId, type KeyWrite, type KeymapDoc, type Layer, type OsKeyMode, TAB60_KEYS, type Usage, FN_LAYER, FN_LAYER_MAC, activeKeymap, canRemap, factoryKey, fnCode, keyId, parseKeymapDoc, planKeymap, predictLayers, presentUsages, romKeymap, serializeKeymapDoc, usage } from "../core/keymap";

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
type Board = Map<Layer, Map<KeyId, OverrideEntry>>;
const LAYERS: readonly Layer[] = [0, 1, 2];
const CAPS = TAB60_KEYS.flatMap((cap) => (canRemap(cap.id) ? [cap.id] : []));

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
	const anyUsage = () => usage(chance(0.7) ? pick([0x00, 0x04, 0x29, 0xe0, 0xe7]) : pick([0x00, 0x01, 0x02, ...Array.from({ length: 0xe4 }, (_, i) => i + 4)]));
	/** Random cells on random layers; a layer may be present and empty. */
	const layered = <V>(cells: readonly KeyId[], fill: number, value: () => V): Map<Layer, Map<KeyId, V>> => {
		const out = new Map<Layer, Map<KeyId, V>>();
		for (const layer of LAYERS) {
			if (!chance(0.7)) continue;
			const keys = new Map<KeyId, V>();
			for (const key of cells) if (chance(fill)) keys.set(key, value());
			out.set(layer, keys);
		}
		return out;
	};
	/** What a read returns: often a plain override that collides with the document, sometimes a function code. */
	const anyEntry = (): OverrideEntry =>
		pick<() => OverrideEntry>([
			() => ({ kind: "default" }),
			() => ({ kind: "absent" }),
			() => ({ kind: "override", code: anyUsage(), flags: 0 }),
			() => ({ kind: "override", code: anyUsage(), flags: 0 }),
			() => ({ kind: "override", code: below(0xff), flags: pick([1, 2, 3] as const) }),
		])();
	const grid = (cells: readonly KeyId[], fill: number): Grid => layered(cells, fill, anyUsage);
	const board = (cells: readonly KeyId[], fill: number): Board => layered(cells, fill, anyEntry);
	const doc = (): KeymapDoc => ({ overrides: grid(CAPS, pick([0, 0.05, 0.3, 1])), osMode: chance(0.5) ? null : pick([0, 1, 2, 3, 4] as const) });
	return { below, chance, pick, grid, board, doc };
}

const entryOf = (value: KeyWrite["value"]): OverrideEntry => (value.kind === "default" ? value : { kind: "override", code: value.code, flags: 0 });
const isPlain = (entry: OverrideEntry | undefined) => entry?.kind === "override" && entry.flags === 0;

test("planKeymap writes nothing when the board holds every override and no plain override the document lacks", () => {
	const r = random(0x0955_0001);
	for (let i = 0; i < 1_000; i++) {
		const doc = r.doc();
		const observed = r.board(CAPS, 0.5);
		for (const [layer, keys] of observed) for (const [key, entry] of keys) if (isPlain(entry) && doc.overrides.get(layer)?.get(key) === undefined) keys.set(key, { kind: "default" });
		for (const [layer, keys] of doc.overrides) {
			const held = observed.get(layer) ?? new Map<KeyId, OverrideEntry>();
			for (const [key, code] of keys) held.set(key, { kind: "override", code, flags: 0 });
			observed.set(layer, held);
		}
		expect(planKeymap(doc, observed)).toEqual([]);
	}
});

test("10,000 random documents: the writes give back every override, clear each plain override the document lacks, and touch nothing else", () => {
	const r = random(0x0955_0002);
	const MATRIX = Array.from({ length: 80 }, (_, i) => keyId(i));
	for (let i = 0; i < 10_000; i++) {
		const doc = r.doc();
		const observed = r.board(r.chance(0.5) ? CAPS : MATRIX, r.pick([0, 0.2, 0.9]));
		const writes = planKeymap(doc, observed);
		const where = `case ${i}`;
		const board: Board = new Map([...observed].map(([layer, keys]) => [layer, new Map(keys)]));
		for (const w of writes) {
			const keys = board.get(w.layer) ?? new Map<KeyId, OverrideEntry>();
			if (JSON.stringify(keys.get(w.key)) === JSON.stringify(entryOf(w.value))) throw new Error(`${where}: a write to layer ${w.layer} key ${w.key} changes nothing`);
			if (w.value.kind === "override" && w.value.code !== doc.overrides.get(w.layer)?.get(w.key)) throw new Error(`${where}: layer ${w.layer} key ${w.key} gets a usage the document does not name`);
			keys.set(w.key, entryOf(w.value));
			board.set(w.layer, keys);
		}
		for (const [layer, keys] of doc.overrides) {
			for (const [key, want] of keys) {
				const held = board.get(layer)?.get(key);
				if (!(held?.kind === "override" && held.flags === 0 && held.code === want)) throw new Error(`${where}: layer ${layer} key ${key} reads back wrong`);
			}
		}
		for (const [layer, keys] of board) {
			for (const [key, held] of keys) {
				if (doc.overrides.get(layer)?.get(key) !== undefined) continue;
				const before = observed.get(layer)?.get(key);
				const want = isPlain(before) ? { kind: "default" } : before;
				if (JSON.stringify(held) !== JSON.stringify(want)) throw new Error(`${where}: layer ${layer} key ${key} without an override reads ${JSON.stringify(held)}`);
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
		...[53, 57, 71, 79, 55, 80, 255, 60, 54].map((cell): [unknown, string] => [canonical({ "0": { [cell]: 4 } }), `$.overrides.0.${cell}: `]),
		[canonical({ "0": { "041": 4 } }), "$.overrides.0.041: "],
		[canonical({ "0": { "4.0": 4 } }), "$.overrides.0.4.0: "],
		[canonical({ "0": { esc: 4 } }), "$.overrides.0.esc: "],
		[canonical({ "2": { "4": 0xe8 } }), "$.overrides.2.4: "],
		[canonical({ "2": { "4": 3 } }), "$.overrides.2.4: "],
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

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The usages present in each OS key mode's active keymap, computed from the V1.01.13 image (docs/app-firmware.md "OS key mode"). */
const WINDOWS_PRESENT = [0x00, ...range(0x04, 0x39), 0x64, 0xc9, 0xd8, 0xd9, ...range(0xe0, 0xe6)];
const entriesOf = (layer: ReadonlyMap<number, OverrideEntry> | undefined) => [...(layer ?? new Map<number, OverrideEntry>())];
const kinds = (layer: ReadonlyMap<number, OverrideEntry> | undefined, kind: OverrideEntry["kind"]) => entriesOf(layer).filter(([, entry]) => entry.kind === kind).map(([k]) => k);
const overridesOf = (layer: ReadonlyMap<number, OverrideEntry> | undefined) =>
	Object.fromEntries(entriesOf(layer).flatMap(([k, entry]) => (entry.kind === "override" ? [[k, (entry.flags << 8) | entry.code]] : [])));

/** The first U10 board run (2026-10-19, Mac mode, `testing/fixtures/tab60kit-u10-2026-10-19T07-42-46-288Z.json`): the 30 layer 2 overrides it read, as flags << 8 | code by active usage. Esc is the 31st factory pair and read default. */
const RUN1_LAYER2: Readonly<Record<number, number>> = {
	0x04: 0x192, 0x08: 0x13f, 0x0d: 0x131, 0x0e: 0x132, 0x0f: 0x133, 0x10: 0x111, 0x11: 0x110, 0x14: 0x13d, 0x16: 0x193, 0x1a: 0x13e,
	0x1b: 0x191, 0x1d: 0x190, 0x1e: 0x1a0, 0x1f: 0x1a1, 0x20: 0x1a2, 0x21: 0x182, 0x22: 0x183, 0x26: 0x1ac, 0x27: 0x1ad, 0x2b: 0x135,
	0x2d: 0x1a8, 0x2e: 0x1a9, 0x31: 0x136, 0x33: 0x134, 0x36: 0x112, 0x37: 0x113, 0xe0: 0x15f, 0xe2: 0x160, 0xe3: 0x130, 0xe5: 0x168,
};

test("in Windows mode every layer reads default for exactly the usages predict.py finds, absent for the rest, and layer 2 holds the factory pairs", () => {
	const layers = predictLayers("windows");
	expect([...layers.keys()]).toEqual([0, 1, 2]);
	for (const layer of [0, 1, 2] as const) {
		expect([...(layers.get(layer)?.keys() ?? [])]).toEqual(range(0, 255));
		expect(kinds(layers.get(layer), "absent")).toEqual(range(0, 255).filter((k) => !WINDOWS_PRESENT.includes(k)));
	}
	expect(kinds(layers.get(0), "default")).toEqual(WINDOWS_PRESENT);
	expect(kinds(layers.get(1), "default")).toEqual(WINDOWS_PRESENT);
	expect(overridesOf(layers.get(2))).toEqual(Object.fromEntries(FACTORY_LAYER2.map(({ usage: k, code }) => [k, 0x100 | code])));
	expect(presentUsages("windows")).toEqual(WINDOWS_PRESENT);
});

test("in Mac mode 0xE6 is gone and 0xE7 is present, and layer 2 reads what the first U10 board run read, plus the Esc pair", () => {
	const layers = predictLayers("mac");
	const macPresent = [...WINDOWS_PRESENT.filter((k) => k !== 0xe6), 0xe7];
	expect(presentUsages("mac")).toEqual(macPresent);
	expect(kinds(layers.get(0), "default")).toEqual(macPresent);
	expect(kinds(layers.get(1), "default")).toEqual(macPresent);
	expect(overridesOf(layers.get(2))).toEqual({ ...RUN1_LAYER2, 0x29: 0x170 });
});

test("Caps/Ctrl mode swaps where Caps Lock and Left Ctrl read their factory layer 2 entries", () => {
	const layer2 = predictLayers("caps-ctrl").get(2);
	expect(presentUsages("caps-ctrl")).toEqual(WINDOWS_PRESENT);
	expect(overridesOf(layer2)[0x39]).toBe(0x15f);
	expect(layer2?.get(0xe0)).toEqual({ kind: "default" });
});

test("the active keymap is the ROM keymap with each mode's swaps, then Fn (cell 60) and Pn (cell 54) replaced by the markers 0xD8 and 0xD9", () => {
	const rom = romKeymap();
	const changed = (mode: OsKeyMode) => activeKeymap(mode).flatMap((cell, at) => (cell === rom[at] ? [] : [[at, cell]]));
	expect([rom.length, rom[60], rom[54]]).toEqual([80, 0xe7, 0x65]);
	expect(changed("windows")).toEqual([[54, 0xd9], [60, 0xd8]]);
	expect(changed("mac")).toEqual([[54, 0xd9], [60, 0xd8], [74, 0xe2], [76, 0xe3], [78, 0xe7]]);
	expect(changed("caps-ctrl")).toEqual([[4, 0xe0], [54, 0xd9], [60, 0xd8], [75, 0x39]]);
});

test("factoryKey names the Pn function the reset writes on each layer 2 cell, by the Windows keymap, and nothing on layer 0", () => {
	const cells = TAB60_KEYS.flatMap((cap) => (factoryKey(2, cap.id) === null ? [] : [cap.id]));
	expect(cells).toHaveLength(FACTORY_LAYER2.length);
	expect(factoryKey(2, keyId(3))).toEqual({ kind: "function", code: 0x13d });
	expect(factoryKey(2, keyId(75))).toEqual({ kind: "function", code: 0x15f });
	expect(TAB60_KEYS.every((cap) => factoryKey(0, cap.id) === null)).toBe(true);
});

test("the Fn table gives what the board sent in the 2026-10-29 Mac-mode tests, and Windows mode keeps the F-keys", () => {
	const fn = (legend: string) => {
		const cap = TAB60_KEYS.find((c) => c.legend === legend)!;
		const key = factoryKey(1, cap.id);
		if (key?.kind !== "fn") throw new Error(`${legend} has no Fn key`);
		return key;
	};
	const VOL_UP = 0xf6;
	const PLAY = 0xf0;
	expect(fnCode(fn("="), "mac", false)).toBe(VOL_UP);
	expect(fnCode(fn("="), "mac", true)).toBe(0x45);
	expect(fnCode(fn("="), "windows", false)).toBe(0x45);
	expect(fnCode(fn("D"), "mac", false)).toBe(VOL_UP);
	expect(fnCode(fn("D"), "windows", false)).toBe(VOL_UP);
	expect(fnCode(fn("I"), "mac", false)).toBe(0x52);
	expect(fnCode(fn("8"), "mac", false)).toBe(PLAY);
	expect(fnCode(fn("8"), "caps-ctrl", false)).toBe(0x41);
	expect(FN_LAYER).toHaveLength(33);
	expect(FN_LAYER_MAC.every(({ key }) => FN_LAYER.some((pair) => pair.key === key))).toBe(true);
	expect(factoryKey(1, TAB60_KEYS.find((c) => c.legend === "A")!.id)).toBeNull();
});
