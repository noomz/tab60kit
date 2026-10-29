import { expect, test } from "bun:test";
import { type KeyId, type Layer, type OverrideEntry, TAB60_KEYS, keyId, usage } from "@tab60kit/core";
import { LAYER_NAME, entryName, factoryNote, keyFace, layerNote, overrideRows, withOverride } from "./editor";
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

test("a layer 2 key with a factory function warns that an override removes it until a power loss; other keys do not", () => {
	expect(factoryNote(2, keyId(3))).toStartWith("This key holds factory function 0x13d (Windows mode) on Layer 2 (hold Pn).");
	expect(factoryNote(2, keyId(3))).toContain("stays gone until the board loses power");
	expect(factoryNote(0, keyId(3))).toBeNull();
	expect(factoryNote(2, keyId(46))).toBeNull();
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

test("a key's face: this page's change first, then a board override, then the factory Pn function, then the cap", () => {
	const q = capOf("Q");
	expect(keyFace(q, 2, EMPTY_KEYMAP, null)).toEqual({ kind: "factory", main: "Windows mode", sub: "Q" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "override", code: 0x3d, flags: 1 }]]))).toEqual({ kind: "factory", main: "Windows mode", sub: "Q" });
	expect(keyFace(q, 2, EMPTY_KEYMAP, storeOf([[2, "Q", { kind: "default" }]]))).toEqual({ kind: "base", main: "Q", sub: null });
	expect(keyFace(q, 1, EMPTY_KEYMAP, storeOf([[1, "Q", { kind: "override", code: 0x29, flags: 0 }]]))).toEqual({ kind: "board", main: "Esc", sub: "was Q" });
	expect(keyFace(q, 1, withOverride(EMPTY_KEYMAP, 1, q.id, usage(0x05)), null)).toEqual({ kind: "pending", main: "Q", sub: "→ B" });
	expect(keyFace(q, 0, EMPTY_KEYMAP, null)).toEqual({ kind: "base", main: "Q", sub: null });
});

test("store entries and layers are named in words, and the Fn layer says its factory functions are unknown", () => {
	expect(entryName({ kind: "override", code: 0x35, flags: 1 })).toBe("USB");
	expect(entryName({ kind: "override", code: 0x70, flags: 1 })).toBe("Function 0x170");
	expect(entryName({ kind: "override", code: 0x52, flags: 0 })).toBe("Up");
	expect(layerNote(1, null)).toBe("Read keymap to see what the board holds now. Factory Fn functions are unknown: this layer shows only overrides.");
	expect(layerNote(1, storeOf([]))).toBe("Factory Fn functions are unknown: this layer shows only overrides.");
	expect(layerNote(0, storeOf([]))).toBeNull();
});
