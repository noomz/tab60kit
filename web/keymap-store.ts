/**
 * The page keeps the keymap document and the board's OS key mode in browser storage, because the board forgets every
 * Apply on a power loss. Storage is a boundary: it can be missing, throw on access, or hold anything, so every read
 * goes through parseKeymapDoc and every failure becomes a problem line while the page goes on with an empty document.
 */
import { type KeymapDoc, type OsKeyMode, parseKeymapDoc, serializeKeymapDoc } from "@tab60kit/core";

export const KEYMAP_KEY = "tab60kit-keymap";
export const MODE_KEY = "tab60kit-os-key-mode";

export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export const EMPTY_KEYMAP: KeymapDoc = { overrides: new Map(), osMode: null };

const MODES: readonly string[] = ["windows", "mac", "caps-ctrl"] satisfies readonly OsKeyMode[];
const isOsKeyMode = (value: string): value is OsKeyMode => MODES.includes(value);

export interface Stored {
	readonly doc: KeymapDoc;
	readonly mode: OsKeyMode | null;
	/** Why storage gave nothing usable, or null. */
	readonly problem: string | null;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `storage` is a thunk because reading `localStorage` itself throws when site data is blocked. */
export function loadKeymap(storage: () => KeyValueStore): Stored {
	let text: string | null;
	let mode: string | null;
	try {
		const store = storage();
		text = store.getItem(KEYMAP_KEY);
		mode = store.getItem(MODE_KEY);
	} catch (error) {
		return { doc: EMPTY_KEYMAP, mode: null, problem: `This browser keeps nothing for this page (${describe(error)}), so the keymap lasts until you close it.` };
	}
	const chosen = mode !== null && isOsKeyMode(mode) ? mode : null;
	if (text === null) return { doc: EMPTY_KEYMAP, mode: chosen, problem: null };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { doc: EMPTY_KEYMAP, mode: chosen, problem: `The saved keymap is not JSON (${describe(error)}). Starting empty.` };
	}
	const doc = parseKeymapDoc(json);
	if ("error" in doc) return { doc: EMPTY_KEYMAP, mode: chosen, problem: `The saved keymap is not one this page reads (${doc.error}). Starting empty.` };
	return { doc, mode: chosen, problem: null };
}

/** Returns why the save failed, or null. */
export function saveKeymap(storage: () => KeyValueStore, doc: KeymapDoc, mode: OsKeyMode | null): string | null {
	try {
		const store = storage();
		store.setItem(KEYMAP_KEY, serializeKeymapDoc(doc));
		if (mode !== null) store.setItem(MODE_KEY, mode);
		return null;
	} catch (error) {
		return `This browser did not keep the keymap (${describe(error)}). It lasts until you close the page.`;
	}
}
