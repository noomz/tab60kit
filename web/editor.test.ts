import { expect, test } from "bun:test";
import { keyId, usage } from "@tab60kit/core";
import { factoryNote, overrideRows, withOverride } from "./editor";
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
		"Layer 2 (hold the 0xD9 layer key): Esc sends Grave, replacing factory function 0x170",
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
	expect(factoryNote(2, keyId(3))).toStartWith("This key holds factory function 0x13d on Layer 2");
	expect(factoryNote(2, keyId(3))).toContain("stays gone until the board loses power");
	expect(factoryNote(0, keyId(3))).toBeNull();
	expect(factoryNote(2, keyId(46))).toBeNull();
});
