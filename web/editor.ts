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

/** The warning for an override over a factory key, or null when the key has none on `layer`. */
export function factoryNote(layer: Layer, key: KeyId, mode: OsKeyMode | null): string | null {
	const factory = factoryKey(layer, key);
	if (factory === null) return null;
	if (factory.kind === "fn") return `On ${LAYER_NAME[layer]} this key sends ${fnSentence(factory, mode)}, from the firmware's Fn table. Changing it replaces that; removing the change brings it back.`;
	return `Changing this key replaces its factory function (${functionWords(factory.code).full}) until the board loses power.`;
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
				return { layer, key, text: `${LAYER_NAME[layer]}: ${legendOf(key)} sends ${usageName(to)}${factory?.kind === "function" ? `, replacing ${functionWords(factory.code).full}` : ""}` };
			}),
	);
}

/**
 * How a code reads: `cap` fits on a keycap (CAP_MAX characters at most, never a raw code), `full` is for selects and
 * notes, and `detail` holds the raw code where the code's meaning is unknown, for a disclosure only.
 */
export interface CodeWords {
	readonly cap: string;
	readonly full: string;
	readonly detail: string | null;
}

export const CAP_MAX = 6;
const words = (cap: string, full = cap, detail: string | null = null): CodeWords => ({ cap, full, detail });
const NOTHING = words("—", "nothing");

/**
 * The factory Pn function codes (flags 1, run by sub_5674 on press), from docs/app-firmware.md "Pn functions". The
 * page numbers the profile keys 1 to 4 (codes 0x110..0x113, firmware profiles 0..3), as it does the Bluetooth slots.
 * The TAB 60 has no backlight, only indicator LEDs, so every lighting code gets one plain name. 0x15F's "remap
 * recording" and the speed codes being lighting are INFERRED there.
 */
const LIGHTING = words("Light", "Lighting (no backlight on TAB 60)");
const FUNCTION_WORDS: ReadonlyMap<number, CodeWords> = new Map([
	...[1, 2, 3, 4].map((n): [number, CodeWords] => [0x10f + n, words(`Prof ${n}`, `Profile ${n}`)]),
	[0x130, words("—", "does nothing")],
	...[1, 2, 3, 4].map((n): [number, CodeWords] => [0x130 + n, words(`BT ${n}`, `Bluetooth slot ${n}`)]),
	[0x135, words("USB")],
	[0x136, words("BT", "Bluetooth")],
	[0x13d, words("Win", "Windows mode")],
	[0x13e, words("Mac", "Mac mode")],
	[0x13f, words("Ctrl", "Caps/Ctrl swap mode")],
	[0x15f, words("Rec", "Key remap recording")],
	[0x160, words("WinLk", "Win lock")],
	[0x168, words("Layout", "Layout cycle")],
	...[0x170, 0x180, 0x181, 0x182, 0x183, 0x190, 0x191, 0x192, 0x193, 0x1a0, 0x1a1, 0x1a2, 0x1a8, 0x1a9, 0x1ac, 0x1ad].map((code): [number, CodeWords] => [code, LIGHTING]),
]);

const unknown = (what: string) => words("?", "unknown function", what);

export const functionWords = (code: number): CodeWords => FUNCTION_WORDS.get(code) ?? unknown(`Pn function code 0x${code.toString(16)}, not traced.`);

/**
 * The Fn table's codes: consumer-report bits (0xEC + n), 0xCA, which sends nothing, and 0xCC/0xCD, which go out as
 * keyboard usages no host function is known for. Others are keyboard usages, with short caps for the long names.
 */
const FN_WORDS: ReadonlyMap<number, CodeWords> = new Map([
	[0xca, NOTHING],
	[0xcc, unknown("Sends keyboard usage 0xCC; no function is known for it.")],
	[0xcd, unknown("Sends keyboard usage 0xCD; no function is known for it.")],
	[0xf0, words("Play", "Play/Pause")],
	[0xf2, words("Prev", "Previous track")],
	[0xf3, words("Next", "Next track")],
	[0xf4, words("Mute")],
	[0xf5, words("Vol-")],
	[0xf6, words("Vol+")],
	[0x46, words("PrtSc", "Print Screen")],
	[0x47, words("ScrLk", "Scroll Lock")],
	[0x4b, words("PgUp", "Page Up")],
	[0x4e, words("PgDn", "Page Down")],
	[0x49, words("Ins", "Insert")],
	[0x4c, words("Del", "Delete")],
	[0x50, words("Left")],
	[0x4f, words("Right")],
]);

export const fnWords = (code: number): CodeWords => FN_WORDS.get(code) ?? words(usageName(usage(code)));

/** An Fn key in words for `mode`: both codes while the mode is unknown and the Mac code differs. */
function fnPair(factory: Extract<FactoryKey, { kind: "fn" }>, mode: OsKeyMode | null): { readonly cap: string; readonly full: string } {
	if (mode === null && factory.mac !== null) {
		const [plain, mac] = [fnWords(factory.code), fnWords(factory.mac)];
		return { cap: `${plain.cap} / ${mac.cap}`, full: `${plain.full}, or ${mac.full} in Mac mode without Shift` };
	}
	const sent = fnWords(fnCode(factory, mode ?? "windows", false));
	return { cap: sent.cap, full: mode === "mac" && factory.mac !== null ? `${sent.full} (${fnWords(factory.code).full} with Shift)` : sent.full };
}

const fnSentence = (factory: Extract<FactoryKey, { kind: "fn" }>, mode: OsKeyMode | null) => fnPair(factory, mode).full;

/** A store entry in words. */
export function entryWords(entry: Extract<OverrideEntry, { kind: "override" }>): CodeWords {
	if (entry.flags === 0) return words(usageName(usage(entry.code)));
	if (entry.flags === 1) return functionWords(0x100 | entry.code);
	return unknown(`Store entry 0x${((entry.flags << 8) | entry.code).toString(16).padStart(4, "0")}.`);
}

/**
 * A key's face in the editor, on one layer. `pending`: this page's document changes it (Apply sends it). `board`: the
 * board's store holds an override that is not the factory one. `factory`: the Fn table's key, or the store reset's
 * Pn function, which the board was read to hold or which the page assumes before a read. `base`: what the cap says.
 * `main` is what fits on the cap; `title` says it in full.
 */
export interface KeyFace {
	readonly kind: "pending" | "board" | "factory" | "base";
	readonly main: string;
	readonly sub: string | null;
	readonly title: string;
}

export function keyFace(cap: KeyCap, layer: Layer, doc: KeymapDoc, store: StoreReading | null, mode: OsKeyMode | null): KeyFace {
	const pending = doc.overrides.get(layer)?.get(cap.id);
	if (pending !== undefined) return { kind: "pending", main: cap.legend, sub: `→ ${usageName(pending)}`, title: `${cap.legend}: changed to ${usageName(pending)}, not applied yet` };
	const factory = factoryKey(layer, cap.id);
	const entry = store?.get(layer)?.get(cap.id);
	const isFactoryEntry = entry?.kind === "override" && factory?.kind === "function" && ((entry.flags << 8) | entry.code) === factory.code;
	if (entry?.kind === "override" && !isFactoryEntry) {
		const held = entryWords(entry);
		return { kind: "board", main: held.cap, sub: `was ${cap.legend}`, title: `${cap.legend}: the board sends ${held.full}` };
	}
	// The Fn table is ROM, not the store, so a read cannot remove it; a Pn function is gone once a read finds no entry.
	if (factory !== null && (factory.kind === "fn" || store === null || isFactoryEntry)) {
		const said = factory.kind === "fn" ? fnPair(factory, mode) : functionWords(factory.code);
		return { kind: "factory", main: said.cap, sub: cap.legend, title: `${cap.legend}: ${said.full}` };
	}
	return { kind: "base", main: cap.legend, sub: null, title: cap.legend };
}

/** The key select's "no override" choice: what the key sends without one. */
export function noOverrideLabel(cap: KeyCap, layer: Layer, mode: OsKeyMode | null): string {
	const factory = factoryKey(layer, cap.id);
	if (factory === null) return `${cap.legend} (no override)`;
	const on = `${cap.legend} key on ${LAYER_NAME[layer]}`;
	if (factory.kind === "function") return `${on}: factory ${functionWords(factory.code).full}, no override`;
	return `${on}: ${fnSentence(factory, mode)}, no override`;
}

/** The raw code behind a key whose meaning is unknown, for a Details disclosure, or null. */
export function factoryDetail(layer: Layer, key: KeyId, mode: OsKeyMode | null): string | null {
	const factory = factoryKey(layer, key);
	if (factory === null) return null;
	if (factory.kind === "function") return functionWords(factory.code).detail;
	const codes = mode === null ? [factory.code, factory.mac] : [fnCode(factory, mode, false)];
	return codes.flatMap((code) => (code === null ? [] : [fnWords(code).detail ?? []].flat())).join(" ") || null;
}

/** What the editor says about the layer it shows: where its faces come from. */
export function layerNote(layer: Layer, store: StoreReading | null, mode: OsKeyMode | null): string | null {
	const read = store === null ? "Read keymap to see what the board holds now. " : "";
	if (layer === 1) {
		const mac = mode === null ? " Where a key shows two names, the second is what Mac mode sends; choose the OS key mode to see one." : mode === "mac" ? " In Mac mode the number row sends media keys; with Shift it sends F-keys." : "";
		return `${read}Fn keys show the firmware's Fn table. "—" sends nothing, and "?" is a function nobody has identified.${mac}`;
	}
	if (layer === 2) return `${read}${store === null ? "Pn keys show the factory functions a reset writes; the board may differ." : "Pn keys show what the board holds."} "Light" is lighting, which the TAB 60 has no backlight to show. "—" does nothing.`;
	return read === "" ? null : read.trim();
}
