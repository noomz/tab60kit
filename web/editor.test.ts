import { expect, test } from "bun:test";
import { type KeyId, type Layer, type OverrideEntry, TAB60_KEYS, keyId, usage } from "@tab60kit/core";
import { CAP_MAX, LAYER_NAME, entryWords, factoryDetail, factoryNote, keyFace, layerNote, noOverrideLabel, overrideRows, withOverride } from "./editor";
import { EMPTY_KEYMAP } from "./keymap-store";
import { TARGETS, usageName } from "./usages";

test("an override replaces the key's earlier one, and removing the last one on a layer drops the layer", () => {
	const once = withOverride(EMPTY_KEYMAP, 1, keyId(4), usage(0xe0));
	const twice = withOverride(once, 1, keyId(4), usage(0x29));
	expect([...twice.overrides.get(1)!]).toEqual([[keyId(4), usage(0x29)]]);
	expect(withOverride(twice, 1, keyId(4), null).overrides.size).toBe(0);
	expect(EMPTY_KEYMAP.overrides.size).toBe(0);
});

test("the list names each override by layer, cap, and target, in the board's order", () => {
	let doc = withOverride(EMPTY_KEYMAP, 2, keyId(0), usage(0x35));
	doc = withOverride(doc, 0, keyId(63), usage(0x4f));
	doc = withOverride(doc, 0, keyId(0), usage(0x35));
	expect(overrideRows(doc).map((row) => row.text)).toEqual([
		"Layer 0 (base): Esc sends Grave",
		"Layer 0 (base): Ctrl sends Right",
		"Layer 2 (hold Pn): Esc sends Grave, replacing Lighting (no backlight on TAB 60)",
	]);
});

test("the target table lists each usage once with a distinct KeyboardEvent code, and names an unlisted usage in hex", () => {
	expect(new Set(TARGETS.map((t) => t.usage)).size).toBe(TARGETS.length);
	expect(new Set(TARGETS.map((t) => t.code)).size).toBe(TARGETS.length);
	expect(TARGETS.find((t) => t.usage === 0x1e)?.code).toBe("Digit1");
	expect(TARGETS.find((t) => t.usage === 0x27)?.code).toBe("Digit0");
	expect(TARGETS.find((t) => t.usage === 0x62)?.code).toBe("Numpad0");
	expect(TARGETS.find((t) => t.usage === 0x73)?.name).toBe("F24");
	expect(usageName(usage(0x66))).toBe("usage 0x66");
});

test("a Pn factory key says changing it replaces the function until a power loss; an Fn key says removing the change brings it back; no raw codes", () => {
	expect(factoryNote(2, keyId(3), null)).toBe("Changing this key replaces its factory function (Windows mode) until the board loses power.");
	expect(factoryNote(1, keyId(48), "mac")).toBe("On Layer 1 (hold Fn) this key sends Vol+ (F12 with Shift), from the firmware's Fn table. Changing it replaces that; removing the change brings it back.");
	expect(factoryNote(1, keyId(9), "mac")).toContain("sends nothing (F3 with Shift)");
	expect(factoryNote(0, keyId(3), null)).toBeNull();
	expect(factoryNote(2, keyId(46), null)).toBeNull();
});

test("each layer is named after the cap the firmware puts its layer marker on", () => {
	expect(LAYER_NAME).toEqual({ 0: "Layer 0 (base)", 1: "Layer 1 (hold Fn)", 2: "Layer 2 (hold Pn)" });
});

const capOf = (legend: string) => TAB60_KEYS.find((cap) => cap.legend === legend)!;
const storeOf = (entries: readonly (readonly [Layer, string, OverrideEntry])[]) => {
	const store = new Map<Layer, Map<KeyId, OverrideEntry>>([[0, new Map()], [1, new Map()], [2, new Map()]]);
	for (const [layer, legend, entry] of entries) store.get(layer)!.set(capOf(legend).id, entry);
	return store;
};

test("a key's face: this page's change first, then a board override, then the factory key, then the cap", () => {
	const q = capOf("Q");
	expect(keyFace(q, 2, EMPTY_KEYMAP, null, null)).toMatchObject({ kind: "factory", main: "Win", sub: "Q", title: "Q: Windows mode" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "override", code: 0x3d, flags: 1 }]]), null)).toMatchObject({ kind: "factory", main: "Win" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "default" }]]), null)).toMatchObject({ kind: "base", main: "Q", sub: null });
	expect(keyFace(q, 1, EMPTY_KEYMAP, storeOf([[1, "Q", { kind: "override", code: 0x29, flags: 0 }]]), null)).toMatchObject({ kind: "board", main: "Esc", sub: "was Q" });
	expect(keyFace(q, 1, withOverride(EMPTY_KEYMAP, 1, q.id, usage(0x05)), null, null)).toMatchObject({ kind: "pending", main: "Q", sub: "→ B" });
	expect(keyFace(q, 0, EMPTY_KEYMAP, null, null)).toMatchObject({ kind: "base", main: "Q", sub: null });
});

test("Fn keys show the firmware's Fn table: both names until the OS key mode is chosen, then the one that mode sends", () => {
	const equal = capOf("=");
	expect(keyFace(equal, 1, EMPTY_KEYMAP, null, null)).toMatchObject({ kind: "factory", main: "F12 / Vol+", sub: "=" });
	expect(keyFace(equal, 1, EMPTY_KEYMAP, null, "mac")).toMatchObject({ kind: "factory", main: "Vol+", title: "=: Vol+ (F12 with Shift)" });
	expect(keyFace(equal, 1, EMPTY_KEYMAP, storeOf([[1, "=", { kind: "default" }]]), "windows")).toMatchObject({ main: "F12" });
	expect(keyFace(capOf("3"), 1, EMPTY_KEYMAP, null, null)).toMatchObject({ main: "F3 / —" });
	expect(keyFace(capOf("W"), 1, EMPTY_KEYMAP, null, null)).toMatchObject({ main: "Play", title: "W: Play/Pause" });
	expect(keyFace(capOf("A"), 1, EMPTY_KEYMAP, null, null)).toMatchObject({ kind: "base", main: "A" });
	expect(noOverrideLabel(equal, 1, null)).toBe("= key on Layer 1 (hold Fn): F12, or Vol+ in Mac mode without Shift, no override");
	expect(noOverrideLabel(capOf("3"), 1, null)).toBe("3 key on Layer 1 (hold Fn): F3, or nothing in Mac mode without Shift, no override");
	expect(noOverrideLabel(capOf("Q"), 2, null)).toBe("Q key on Layer 2 (hold Pn): factory Windows mode, no override");
	expect(noOverrideLabel(capOf("Alt"), 2, null)).toBe("Alt key on Layer 2 (hold Pn): factory does nothing, no override");
	expect(noOverrideLabel(equal, 2, null)).toBe("= key on Layer 2 (hold Pn): factory Lighting (no backlight on TAB 60), no override");
	expect(noOverrideLabel(equal, 0, null)).toBe("= (no override)");
});

test("a function nobody identified shows ? on its cap and its raw code only in Details", () => {
	const five = capOf("5");
	expect(keyFace(five, 1, EMPTY_KEYMAP, null, "mac")).toMatchObject({ main: "?", title: "5: unknown function (F5 with Shift)" });
	expect(factoryDetail(1, five.id, "mac")).toBe("Sends keyboard usage 0xCC; no function is known for it.");
	expect(factoryDetail(1, five.id, "windows")).toBeNull();
	expect(factoryDetail(2, capOf("Q").id, null)).toBeNull();
});

test("every factory cap label fits a key and shows no raw code, on every layer and OS key mode", () => {
	for (const mode of [null, "windows", "mac", "caps-ctrl"] as const) {
		for (const layer of [1, 2] as const) {
			for (const cap of TAB60_KEYS) {
				const { main } = keyFace(cap, layer, EMPTY_KEYMAP, null, mode);
				for (const word of main.split(" / ")) expect(word.length <= CAP_MAX || word === cap.legend, `${cap.legend} on layer ${layer} (${mode}): "${word}"`).toBe(true);
				expect(main).not.toContain("0x");
			}
		}
	}
});

test("store entries and Pn functions are named in words; profiles count from 1 like the Bluetooth slots", () => {
	expect(entryWords({ kind: "override", code: 0x35, flags: 1 }).full).toBe("USB");
	expect(entryWords({ kind: "override", code: 0x70, flags: 1 })).toMatchObject({ cap: "Light", full: "Lighting (no backlight on TAB 60)" });
	expect(entryWords({ kind: "override", code: 0x52, flags: 0 }).full).toBe("Up");
	expect(entryWords({ kind: "override", code: 0x10, flags: 1 }).full).toBe("Profile 1");
	expect(entryWords({ kind: "override", code: 0x31, flags: 1 }).full).toBe("Bluetooth slot 1");
	expect(layerNote(0, storeOf([]), null)).toBeNull();
	expect(layerNote(1, storeOf([]), "windows")).toBe('Fn keys show the firmware\'s Fn table. "—" sends nothing, and "?" is a function nobody has identified.');
});
