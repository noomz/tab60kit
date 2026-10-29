/** The keymap editor's document edits and the words it lists, DOM-free so they are testable. app.ts draws them. */
import { type FactoryKey, type KeyCap, type KeyId, type KeymapDoc, LAYER_KEY_MARKERS, type Layer, type OsKeyMode, type OverrideEntry, type StoreReading, TAB60_KEYS, type Usage, factoryKey, fnCode, usage } from "@tab60kit/core";
import { usageName } from "./usages";

/**
 * Layers 1 and 2 are held with the keys whose active usage is the marker 0xD8 or 0xD9. The firmware writes each marker
 * into a cell LAYER_KEY_MARKERS names, so each layer is named after the cap in that cell.
 */
const MARKER: Readonly<Record<1 | 2, number>> = { 1: 0xd8, 2: 0xd9 };

function layerName(layer: 1 | 2): string {
	const marker = LAYER_KEY_MARKERS.find((m) => m.usage === MARKER[layer]);
	const cap = TAB60_KEYS.find((c) => c.id === marker?.cell);
	return cap === undefined ? `Layer ${layer} (no key on this board selects it)` : `Layer ${layer} (hold ${cap.legend})`;
}

export const LAYER_NAME: Readonly<Record<Layer, string>> = {
	0: "Layer 0 (base)",
	1: layerName(1),
	2: layerName(2),
};

const hex3 = (n: number) => `0x${n.toString(16).padStart(3, "0")}`;

/** The warning for an override over a factory function, or null when the key has none on `layer`. */
export function factoryNote(layer: Layer, key: KeyId, mode: OsKeyMode | null): string | null {
	const factory = factoryKey(layer, key);
	if (factory === null) return null;
	if (factory.kind === "fn") return `On ${LAYER_NAME[layer]} this key sends ${factoryName(factory, mode)} from the firmware's Fn table. An override replaces it, and removing the override brings it back.`;
	return `This key holds factory function ${hex3(factory.code)} (${functionName(factory.code)}) on ${LAYER_NAME[layer]}. An override replaces it, and removing the override later leaves the key with no override, so the function stays gone until the board loses power.`;
}

/** `to` null removes the override. A layer left with no override is dropped, so the stored document stays minimal. */
export function withOverride(doc: KeymapDoc, layer: Layer, key: KeyId, to: Usage | null): KeymapDoc {
	const keys = new Map(doc.overrides.get(layer));
	if (to === null) keys.delete(key);
	else keys.set(key, to);
	const overrides = new Map(doc.overrides);
	if (keys.size === 0) overrides.delete(layer);
	else overrides.set(layer, keys);
	return { ...doc, overrides };
}

export interface OverrideRow {
	readonly layer: Layer;
	readonly key: KeyId;
	readonly text: string;
}

const legendOf = (key: KeyId) => TAB60_KEYS.find((cap) => cap.id === key)?.legend ?? `key ${key}`;

/** One row per override, by layer and then by the cap's place on the board. */
export function overrideRows(doc: KeymapDoc): readonly OverrideRow[] {
	const place = new Map(TAB60_KEYS.map((cap, i) => [cap.id as number, i]));
	return [...doc.overrides.keys()].sort().flatMap((layer) =>
		[...doc.overrides.get(layer)!]
			.sort(([a], [b]) => (place.get(a) ?? a) - (place.get(b) ?? b))
			.map(([key, to]) => {
				const factory = factoryKey(layer, key);
				return { layer, key, text: `${LAYER_NAME[layer]}: ${legendOf(key)} sends ${usageName(to)}${factory?.kind === "function" ? `, replacing factory function ${hex3(factory.code)}` : ""}` };
			}),
	);
}

/**
 * Names for the factory Pn function codes (flags 1, run by sub_5674 on press), from docs/app-firmware.md "Pn
 * functions". The TAB 60 has no backlight, only indicator LEDs, so every lighting code gets one plain name. 0x15F's
 * "remap recording" and the speed codes being lighting speed are INFERRED there.
 */
const LIGHTING = "Lighting (no backlight)";
const FUNCTION_NAME: ReadonlyMap<number, string> = new Map([
	...[0, 1, 2, 3].map((n): [number, string] => [0x110 + n, `Profile ${n}`]),
	[0x130, "Nothing"],
	...[1, 2, 3, 4].map((n): [number, string] => [0x130 + n, `Bluetooth slot ${n}`]),
	[0x135, "USB"],
	[0x136, "Bluetooth"],
	[0x13d, "Windows mode"],
	[0x13e, "Mac mode"],
	[0x13f, "Caps/Ctrl swap mode"],
	[0x15f, "Key remap recording"],
	[0x160, "Win lock"],
	[0x168, "Layout cycle"],
	...[0x170, 0x180, 0x181, 0x182, 0x183, 0x190, 0x191, 0x192, 0x193, 0x1a0, 0x1a1, 0x1a2, 0x1a8, 0x1a9, 0x1ac, 0x1ad].map((code): [number, string] => [code, LIGHTING]),
]);

export const functionName = (code: number): string => FUNCTION_NAME.get(code) ?? `Function ${hex3(code)}`;

/** The Fn table's consumer codes (0xEC + bit of the consumer report) and its one code that sends nothing. */
const FN_CODE_NAME: ReadonlyMap<number, string> = new Map([
	[0xca, "Nothing"],
	[0xf0, "Play/Pause"],
	[0xf2, "Prev track"],
	[0xf3, "Next track"],
	[0xf4, "Mute"],
	[0xf5, "Vol-"],
	[0xf6, "Vol+"],
]);

const fnCodeName = (code: number): string => FN_CODE_NAME.get(code) ?? usageName(usage(code));

/**
 * A factory key in words. An Fn key whose Mac code differs names both while the OS key mode is unknown, and the Mac
 * one in Mac mode (Shift gives back the other, fnCode).
 */
export function factoryName(factory: FactoryKey, mode: OsKeyMode | null): string {
	if (factory.kind === "function") return functionName(factory.code);
	if (mode === null && factory.mac !== null) return `${fnCodeName(factory.code)} / ${fnCodeName(factory.mac)}`;
	return fnCodeName(fnCode(factory, mode ?? "windows", false));
}

/** What a store entry makes the key send, in words. */
export function entryName(entry: Extract<OverrideEntry, { kind: "override" }>): string {
	if (entry.flags === 0) return usageName(usage(entry.code));
	if (entry.flags === 1) return functionName(0x100 | entry.code);
	return `Entry 0x${((entry.flags << 8) | entry.code).toString(16).padStart(4, "0")}`;
}

/**
 * A key's face in the editor, on one layer. `pending`: this page's document changes it (Apply sends it). `board`: the
 * board's store holds an override that is not the factory one. `factory`: the Fn table's key, or the store reset's
 * Pn function, which the board was read to hold or which the page assumes before a read. `base`: what the cap says.
 */
export interface KeyFace {
	readonly kind: "pending" | "board" | "factory" | "base";
	readonly main: string;
	readonly sub: string | null;
}

export function keyFace(cap: KeyCap, layer: Layer, doc: KeymapDoc, store: StoreReading | null, mode: OsKeyMode | null): KeyFace {
	const pending = doc.overrides.get(layer)?.get(cap.id);
	if (pending !== undefined) return { kind: "pending", main: cap.legend, sub: `→ ${usageName(pending)}` };
	const factory = factoryKey(layer, cap.id);
	const entry = store?.get(layer)?.get(cap.id);
	const isFactoryEntry = entry?.kind === "override" && factory?.kind === "function" && ((entry.flags << 8) | entry.code) === factory.code;
	if (entry?.kind === "override" && !isFactoryEntry) return { kind: "board", main: entryName(entry), sub: `was ${cap.legend}` };
	// The Fn table is ROM, not the store, so a read cannot remove it; a Pn function is gone once a read finds no entry.
	if (factory !== null && (factory.kind === "fn" || store === null || isFactoryEntry)) return { kind: "factory", main: factoryName(factory, mode), sub: cap.legend };
	return { kind: "base", main: cap.legend, sub: null };
}

/** The key select's "no override" choice: what the key sends without one. */
export function noOverrideLabel(cap: KeyCap, layer: Layer, mode: OsKeyMode | null): string {
	const factory = factoryKey(layer, cap.id);
	if (factory === null) return `${cap.legend} (no override)`;
	const on = `${cap.legend} key on ${LAYER_NAME[layer]}`;
	if (factory.kind === "function") return `${on}: factory ${functionName(factory.code)}, no override`;
	if (factory.mac === null) return `${on}: ${fnCodeName(factory.code)}, no override`;
	if (mode === "mac") return `${on}: ${fnCodeName(factory.mac)} (${fnCodeName(factory.code)} with Shift), no override`;
	if (mode === null) return `${on}: ${fnCodeName(factory.code)}, or ${fnCodeName(factory.mac)} in Mac mode without Shift, no override`;
	return `${on}: ${fnCodeName(factory.code)}, no override`;
}

/** What the editor says about the layer it shows: where its faces come from. */
export function layerNote(layer: Layer, store: StoreReading | null, mode: OsKeyMode | null): string | null {
	const read = store === null ? "Read keymap to see what the board holds now. " : "";
	if (layer === 1) {
		const mac = mode === null ? " Where two names show, the second is what Mac mode sends; choose the OS key mode to see one." : mode === "mac" ? " In Mac mode the number row sends media keys; with Shift it sends F-keys." : "";
		return `${read}Fn keys show the firmware's Fn table.${mac}`;
	}
	if (layer === 2) return `${read}${store === null ? "Pn keys show the factory functions a reset writes; the board may differ." : "Pn keys show what the board holds."}`;
	return read === "" ? null : read.trim();
}
