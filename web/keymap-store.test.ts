import { expect, test } from "bun:test";
import { type KeymapDoc, keyId, serializeKeymapDoc, usage } from "@tab60kit/core";
import { withOverride } from "./editor";
import { EMPTY_KEYMAP, KEYMAP_KEY, type KeyValueStore, MODE_KEY, loadKeymap, saveKeymap } from "./keymap-store";

function memory(seed: Record<string, string> = {}): KeyValueStore & { readonly items: Map<string, string> } {
	const items = new Map(Object.entries(seed));
	return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

const FIVE: KeymapDoc = [
	[0, 0x35],
	[7, 0x1c],
	[46, 0x52],
	[51, 0x2a],
	[63, 0x4f],
].reduce((doc, [key, to]) => withOverride(doc, 0, keyId(key!), usage(to!)), EMPTY_KEYMAP);

test("a saved document and mode come back from a fresh load, as after a page reload", () => {
	const store = memory();
	expect(saveKeymap(() => store, FIVE, "mac")).toBeNull();
	expect(store.items.get(KEYMAP_KEY)).toBe(serializeKeymapDoc(FIVE));
	const back = loadKeymap(() => store);
	expect(back).toEqual({ doc: FIVE, mode: "mac", problem: null });
});

test("empty storage gives the empty document with no problem", () => {
	expect(loadKeymap(() => memory())).toEqual({ doc: EMPTY_KEYMAP, mode: null, problem: null });
});

test("storage that throws gives the empty document and a problem line, and a failed save says so", () => {
	const blocked = () => {
		throw new DOMException("The operation is insecure.", "SecurityError");
	};
	const loaded = loadKeymap(blocked);
	expect(loaded.doc).toEqual(EMPTY_KEYMAP);
	expect(loaded.problem).toContain("The operation is insecure.");
	const full: KeyValueStore = {
		getItem: () => null,
		setItem: () => {
			throw new DOMException("quota", "QuotaExceededError");
		},
	};
	expect(saveKeymap(() => full, FIVE, null)).toContain("did not keep the keymap (quota)");
});

test("stored text that is not JSON, or not a keymap the parse accepts, starts empty and keeps the mode", () => {
	const notJson = loadKeymap(() => memory({ [KEYMAP_KEY]: "{", [MODE_KEY]: "windows" }));
	expect({ doc: notJson.doc, mode: notJson.mode }).toEqual({ doc: EMPTY_KEYMAP, mode: "windows" });
	expect(notJson.problem).toStartWith("The saved keymap is not JSON");
	const fnKey = JSON.stringify({ format: "tab60kit-keymap", version: 1, osMode: null, overrides: { "0": { "60": 4 } } });
	const refused = loadKeymap(() => memory({ [KEYMAP_KEY]: fnKey }));
	expect(refused.doc).toEqual(EMPTY_KEYMAP);
	expect(refused.problem).toContain("$.overrides.0.60:");
});

test("an unknown stored mode reads as not chosen", () => {
	expect(loadKeymap(() => memory({ [MODE_KEY]: "linux" })).mode).toBeNull();
});
