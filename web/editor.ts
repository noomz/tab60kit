/** The keymap editor's document edits and the words it lists, DOM-free so they are testable. app.ts draws them. */
import { type KeyCap, type KeyId, type KeymapDoc, LAYER_KEY_MARKERS, type Layer, type OverrideEntry, type StoreReading, TAB60_KEYS, type Usage, factoryFunction, usage } from "@tab60kit/core";
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

/** The warning for an override over a factory function, or null when the reset leaves none on that key. */
export function factoryNote(layer: Layer, key: KeyId): string | null {
	const code = factoryFunction(layer, key);
	if (code === null) return null;
	const name = FUNCTION_NAME.get(code);
	return `This key holds factory function ${name === undefined ? hex3(code) : `${hex3(code)} (${name})`} on ${LAYER_NAME[layer]}. An override replaces it, and removing the override later leaves the key with no override, so the function stays gone until the board loses power.`;
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
				const code = factoryFunction(layer, key);
				return { layer, key, text: `${LAYER_NAME[layer]}: ${legendOf(key)} sends ${usageName(to)}${code === null ? "" : `, replacing factory function ${hex3(code)}`}` };
			}),
	);
}

/**
 * Names for the factory function codes (flags 1) that docs/app-firmware.md identifies. Any other code shows as its
 * number: the firmware runs it, but nobody has traced what it does.
 */
const FUNCTION_NAME: ReadonlyMap<number, string> = new Map([
	...[0, 1, 2, 3].map((n): [number, string] => [0x110 + n, `Profile ${n}`]),
	...[1, 2, 3, 4].map((n): [number, string] => [0x130 + n, `Bluetooth slot ${n}`]),
	[0x135, "USB"],
	[0x136, "Bluetooth"],
	[0x13d, "Windows mode"],
	[0x13e, "Mac mode"],
	[0x13f, "Caps/Ctrl swap mode"],
	[0x160, "Win lock"],
	[0x168, "Layout cycle"],
	...[0x180, 0x181, 0x182, 0x183, 0x190, 0x191, 0x1a0, 0x1a1, 0x1a2].map((code): [number, string] => [code, `Lighting 0x${code.toString(16)}`]),
]);

export const functionName = (code: number): string => FUNCTION_NAME.get(code) ?? `Function ${hex3(code)}`;

/** What a store entry makes the key send, in words. */
export function entryName(entry: Extract<OverrideEntry, { kind: "override" }>): string {
	if (entry.flags === 0) return usageName(usage(entry.code));
	if (entry.flags === 1) return functionName(0x100 | entry.code);
	return `Entry 0x${((entry.flags << 8) | entry.code).toString(16).padStart(4, "0")}`;
}

/**
 * A key's face in the editor, on one layer. `pending`: this page's document changes it (Apply sends it). `board`: the
 * board's store holds an override that is not the factory one. `factory`: the store reset's layer 2 function, which
 * the board was read to hold, or which the page assumes before a read. `base`: what the cap says.
 */
export interface KeyFace {
	readonly kind: "pending" | "board" | "factory" | "base";
	readonly main: string;
	readonly sub: string | null;
}

export function keyFace(cap: KeyCap, layer: Layer, doc: KeymapDoc, store: StoreReading | null): KeyFace {
	const pending = doc.overrides.get(layer)?.get(cap.id);
	if (pending !== undefined) return { kind: "pending", main: cap.legend, sub: `→ ${usageName(pending)}` };
	const factory = factoryFunction(layer, cap.id);
	const entry = store?.get(layer)?.get(cap.id);
	if (entry?.kind === "override" && (factory === null || ((entry.flags << 8) | entry.code) !== factory)) return { kind: "board", main: entryName(entry), sub: `was ${cap.legend}` };
	if (factory !== null && (store === null || entry?.kind === "override")) return { kind: "factory", main: functionName(factory), sub: cap.legend };
	return { kind: "base", main: cap.legend, sub: null };
}

/** What the editor says about the layer it shows: where its faces come from, and what it cannot know. */
export function layerNote(layer: Layer, store: StoreReading | null): string | null {
	const read = store === null ? "Read keymap to see what the board holds now. " : "";
	if (layer === 1) return `${read}Factory Fn functions are unknown: this layer shows only overrides.`;
	if (layer === 2) return `${read}${store === null ? "Pn keys show the factory functions a reset writes; the board may differ." : "Pn keys show what the board holds."}`;
	return read === "" ? null : read.trim();
}
