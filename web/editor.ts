/** The keymap editor's document edits and the words it lists, DOM-free so they are testable. app.ts draws them. */
import { type KeyId, type KeymapDoc, LAYER_KEY_MARKERS, type Layer, TAB60_KEYS, type Usage, factoryFunction } from "@tab60kit/core";
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
	return `This key holds factory function ${hex3(code)} on ${LAYER_NAME[layer]}. An override replaces it, and removing the override later leaves the key with no override, so the function stays gone until the board loses power.`;
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
