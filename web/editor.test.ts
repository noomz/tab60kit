import { expect, test } from "bun:test";
import { type KeyId, type Layer, type OverrideEntry, TAB60_KEYS, keyId, usage } from "@tab60kit/core";
import { LAYER_NAME, entryName, factoryNote, keyFace, layerNote, noOverrideLabel, overrideRows, withOverride } from "./editor";
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
		"Layer 2 (hold Pn): Esc sends Grave, replacing factory function 0x170",
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

test("a Pn factory key warns that an override removes it until a power loss; an Fn key says removing brings it back; other keys say nothing", () => {
	expect(factoryNote(2, keyId(3), null)).toStartWith("This key holds factory function 0x13d (Windows mode) on Layer 2 (hold Pn).");
	expect(factoryNote(2, keyId(3), null)).toContain("stays gone until the board loses power");
	expect(factoryNote(1, keyId(48), "mac")).toBe("On Layer 1 (hold Fn) this key sends Vol+ from the firmware's Fn table. An override replaces it, and removing the override brings it back.");
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
	expect(keyFace(q, 2, EMPTY_KEYMAP, null, null)).toEqual({ kind: "factory", main: "Windows mode", sub: "Q" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "override", code: 0x3d, flags: 1 }]]), null)).toEqual({ kind: "factory", main: "Windows mode", sub: "Q" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "default" }]]), null)).toEqual({ kind: "base", main: "Q", sub: null });
	expect(keyFace(q, 1, EMPTY_KEYMAP, storeOf([[1, "Q", { kind: "override", code: 0x29, flags: 0 }]]), null)).toEqual({ kind: "board", main: "Esc", sub: "was Q" });
	expect(keyFace(q, 1, withOverride(EMPTY_KEYMAP, 1, q.id, usage(0x05)), null, null)).toEqual({ kind: "pending", main: "Q", sub: "→ B" });
	expect(keyFace(q, 0, EMPTY_KEYMAP, null, null)).toEqual({ kind: "base", main: "Q", sub: null });
});

test("Fn keys show the firmware's Fn table: both names until the OS key mode is chosen, then the one that mode sends", () => {
	const equal = capOf("=");
	expect(keyFace(equal, 1, EMPTY_KEYMAP, null, null)).toEqual({ kind: "factory", main: "F12 / Vol+", sub: "=" });
	expect(keyFace(equal, 1, EMPTY_KEYMAP, null, "mac")).toEqual({ kind: "factory", main: "Vol+", sub: "=" });
	expect(keyFace(equal, 1, EMPTY_KEYMAP, storeOf([[1, "=", { kind: "default" }]]), "windows")).toEqual({ kind: "factory", main: "F12", sub: "=" });
	expect(keyFace(capOf("D"), 1, EMPTY_KEYMAP, null, "windows")).toEqual({ kind: "factory", main: "Vol+", sub: "D" });
	expect(keyFace(capOf("A"), 1, EMPTY_KEYMAP, null, null)).toEqual({ kind: "base", main: "A", sub: null });
	expect(noOverrideLabel(equal, 1, null)).toBe("= key on Layer 1 (hold Fn): F12, or Vol+ in Mac mode without Shift, no override");
	expect(noOverrideLabel(equal, 1, "mac")).toBe("= key on Layer 1 (hold Fn): Vol+ (F12 with Shift), no override");
	expect(noOverrideLabel(capOf("I"), 1, "mac")).toBe("I key on Layer 1 (hold Fn): Up, no override");
	expect(noOverrideLabel(capOf("Q"), 2, null)).toBe("Q key on Layer 2 (hold Pn): factory Windows mode, no override");
	expect(noOverrideLabel(equal, 0, null)).toBe("= (no override)");
});

test("store entries and Pn functions are named in words; lighting has one plain name, since the TAB 60 has no backlight", () => {
	expect(entryName({ kind: "override", code: 0x35, flags: 1 })).toBe("USB");
	expect(entryName({ kind: "override", code: 0x70, flags: 1 })).toBe("Lighting (no backlight)");
	expect(entryName({ kind: "override", code: 0x52, flags: 0 })).toBe("Up");
	expect(entryName({ kind: "override", code: 0x5f, flags: 1 })).toBe("Key remap recording");
	expect(layerNote(1, null, null)).toBe("Read keymap to see what the board holds now. Fn keys show the firmware's Fn table. Where two names show, the second is what Mac mode sends; choose the OS key mode to see one.");
	expect(layerNote(1, storeOf([]), "windows")).toBe("Fn keys show the firmware's Fn table.");
	expect(layerNote(0, storeOf([]), null)).toBeNull();
});
