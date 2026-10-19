/**
 * Live keymap editing on stock firmware.
 *
 * The board rebuilds its active keymap from ROM at every boot and applies a per-key override store on top. R4 said
 * the app has no flash-write path; the U10 static read found a serial-flash save of the block that holds the store,
 * so whether overrides survive a battery pull is open for U11. The host document is the user's intent, and applying
 * it is another convergence: read what the board holds, write the difference, read back.
 *
 * Under G1 the two override reads are reviewed and the config writes unreviewed. `capabilities(clearance)` derives
 * what is unlocked from COMMANDS and the same `clears` the egress audit uses, so the editor's locks and the wire gate
 * cannot disagree.
 */
import type { Job } from "./job";
import { COMMANDS, COMMAND_NAMES, type Clearance, type CommandName, type CommandSpec, clears, gateMessage } from "./protocol";
import { type Brand, notImplemented } from "./units";

/**
 * A key layer of the override store. sub_5E98 bounds its index at 0x2FF (layer << 8 | usage), and the reset clears
 * 3 x (80 + 20) bytes, so there are three (U10 research, VERIFIED). Layer 0 is the base layer, INFERRED.
 */
export type Layer = 0 | 1 | 2;

/** Index into the 80-byte matrix keymap the firmware copies from ROM 0xB205 at boot. Built only by `keyId`. */
export type KeyId = Brand<number, "KeyId">;

/** HID keyboard-page usage, 0x00..0xE7. Built only by `usage`. */
export type Usage = Brand<number, "Usage">;

/** R4: cmd 0x51/0x00 accepts values below 5. */
export type OsMode = 0 | 1 | 2 | 3 | 4;

export function keyId(n: number): KeyId {
	if (!Number.isInteger(n) || n < 0 || n >= 80) throw new RangeError(`key index ${n} is outside the 80-entry matrix`);
	return n as KeyId;
}

export function usage(n: number): Usage {
	if (!Number.isInteger(n) || n < 0 || n > 0xe7) throw new RangeError(`usage 0x${n.toString(16)} is outside the keyboard page`);
	return n as Usage;
}

/** The two flag bits the store keeps per cell. Their meaning is OPEN (U11). */
export type OverrideFlags = 0 | 1 | 2 | 3;

/**
 * One entry of the per-key override store, addressed by an active usage, as cmd 0x52 returns it. "absent": no key in
 * the active keymap has that usage. "default": the key has no override and types its active usage. "override": the
 * key types `usage` instead.
 */
export type OverrideEntry =
	| { readonly kind: "absent" }
	| { readonly kind: "default" }
	| { readonly kind: "override"; readonly usage: Usage; readonly flags: OverrideFlags };

const ABSENT_WORD = 0x0003;
const DEFAULT_WORD = 0x00ff;

/**
 * Decodes one u16 the board returns for an entry (U10 research, 0x807C..0x80DE and sub_5E98 mode 3 at 0x5F0E):
 * 0x0003 absent, 0x00FF default, otherwise flags << 8 | usage. Throws RangeError on a word that fits none of them,
 * such as flags above 3 or a usage past the keyboard page.
 */
export function parseOverrideEntry(word: number): OverrideEntry {
	if (word === ABSENT_WORD) return { kind: "absent" };
	if (word === DEFAULT_WORD) return { kind: "default" };
	const flags = word >>> 8;
	const low = word & 0xff;
	if (!Number.isInteger(word) || word < 0 || flags > 3 || low > 0xe7) {
		throw new RangeError(`override word ${word < 0 || !Number.isInteger(word) ? word : `0x${word.toString(16).padStart(4, "0")}`} is not absent, default, or flags 0..3 with a keyboard usage`);
	}
	return { kind: "override", usage: usage(low), flags: flags as OverrideFlags };
}

export interface KeyWrite {
	readonly layer: Layer;
	readonly key: KeyId;
	readonly usage: Usage;
}

/** The user's intent: overrides on top of the ROM defaults, per layer. Stored by the page, exported as JSON. */
export interface KeymapDoc {
	readonly overrides: ReadonlyMap<Layer, ReadonlyMap<KeyId, Usage>>;
	readonly osMode: OsMode | null;
}

/** One physical key: where it is drawn and what the ROM maps it to. */
export interface KeyCap {
	readonly id: KeyId;
	readonly row: 0 | 1 | 2 | 3 | 4;
	/** In key units from the left edge. */
	readonly x: number;
	readonly width: number;
	readonly defaultUsage: Usage;
	readonly legend: string;
}

/**
 * The TAB 60's 61 caps, by row and then x. A KeyId indexes the 80-byte ROM matrix at flash 0xB205 (image offset
 * 0x8005). Cells 0..55 are matrix columns 0..13 of rows 0..3, stored in column pairs (r0 c, r0 c+1, r1 c, r1 c+1,
 * ... r3 c+1); cells 56..63 are columns 14 and 15 of rows 0..3; cells 64..79 are row 4. VERIFIED: every
 * `defaultUsage` equals its ROM byte in the decoded V1.01.13 image (`bun run real-image`, which checks the user's own
 * exe through `readUpdater`).
 *
 * Bottom-row roles are INFERRED from a static read of the image. Arrow mode at 0x5FA4 writes cell 47 (RShift) = Up,
 * 60 = Left, 54 = Down, 63 = Right, and normal mode at 0x5F82 restores 60 = 0xE7 and 54 = 0x65, so 60 is Fn and 54
 * is Pn. At runtime the firmware overwrites those two cells with the markers 0xD8 and 0xD9 (it writes them to the
 * cells SRAM 0x20000E50/51 index, whose defaults in the record at 0xAA14 are 0x3C and 0x36); `defaultUsage` is the
 * ROM byte.
 *
 * Cells with a usage that are not caps on this ANSI board: 53 (0x32, ISO #), 57 (0x35, Grave), 71 (0x64, ISO \), and
 * 79 (0xC9). The firmware rewrites 0xC9 to Space at 0x5AB4, so cell 79 is a second Space switch position. OPEN: the
 * physical Space switch is on cell 72 or on cell 79. The override read cannot tell, because both usages read "default".
 */
export const TAB60_KEYS: readonly KeyCap[] = [
	{ id: keyId(0), row: 0, x: 0, width: 1, defaultUsage: usage(0x29), legend: "Esc" },
	{ id: keyId(1), row: 0, x: 1, width: 1, defaultUsage: usage(0x1e), legend: "1" },
	{ id: keyId(8), row: 0, x: 2, width: 1, defaultUsage: usage(0x1f), legend: "2" },
	{ id: keyId(9), row: 0, x: 3, width: 1, defaultUsage: usage(0x20), legend: "3" },
	{ id: keyId(16), row: 0, x: 4, width: 1, defaultUsage: usage(0x21), legend: "4" },
	{ id: keyId(17), row: 0, x: 5, width: 1, defaultUsage: usage(0x22), legend: "5" },
	{ id: keyId(24), row: 0, x: 6, width: 1, defaultUsage: usage(0x23), legend: "6" },
	{ id: keyId(25), row: 0, x: 7, width: 1, defaultUsage: usage(0x24), legend: "7" },
	{ id: keyId(32), row: 0, x: 8, width: 1, defaultUsage: usage(0x25), legend: "8" },
	{ id: keyId(33), row: 0, x: 9, width: 1, defaultUsage: usage(0x26), legend: "9" },
	{ id: keyId(40), row: 0, x: 10, width: 1, defaultUsage: usage(0x27), legend: "0" },
	{ id: keyId(41), row: 0, x: 11, width: 1, defaultUsage: usage(0x2d), legend: "-" },
	{ id: keyId(48), row: 0, x: 12, width: 1, defaultUsage: usage(0x2e), legend: "=" },
	{ id: keyId(49), row: 0, x: 13, width: 2, defaultUsage: usage(0x2a), legend: "Backspace" },
	{ id: keyId(2), row: 1, x: 0, width: 1.5, defaultUsage: usage(0x2b), legend: "Tab" },
	{ id: keyId(3), row: 1, x: 1.5, width: 1, defaultUsage: usage(0x14), legend: "Q" },
	{ id: keyId(10), row: 1, x: 2.5, width: 1, defaultUsage: usage(0x1a), legend: "W" },
	{ id: keyId(11), row: 1, x: 3.5, width: 1, defaultUsage: usage(0x08), legend: "E" },
	{ id: keyId(18), row: 1, x: 4.5, width: 1, defaultUsage: usage(0x15), legend: "R" },
	{ id: keyId(19), row: 1, x: 5.5, width: 1, defaultUsage: usage(0x17), legend: "T" },
	{ id: keyId(26), row: 1, x: 6.5, width: 1, defaultUsage: usage(0x1c), legend: "Y" },
	{ id: keyId(27), row: 1, x: 7.5, width: 1, defaultUsage: usage(0x18), legend: "U" },
	{ id: keyId(34), row: 1, x: 8.5, width: 1, defaultUsage: usage(0x0c), legend: "I" },
	{ id: keyId(35), row: 1, x: 9.5, width: 1, defaultUsage: usage(0x12), legend: "O" },
	{ id: keyId(42), row: 1, x: 10.5, width: 1, defaultUsage: usage(0x13), legend: "P" },
	{ id: keyId(43), row: 1, x: 11.5, width: 1, defaultUsage: usage(0x2f), legend: "[" },
	{ id: keyId(50), row: 1, x: 12.5, width: 1, defaultUsage: usage(0x30), legend: "]" },
	{ id: keyId(51), row: 1, x: 13.5, width: 1.5, defaultUsage: usage(0x31), legend: "\\" },
	{ id: keyId(4), row: 2, x: 0, width: 1.75, defaultUsage: usage(0x39), legend: "Caps" },
	{ id: keyId(5), row: 2, x: 1.75, width: 1, defaultUsage: usage(0x04), legend: "A" },
	{ id: keyId(12), row: 2, x: 2.75, width: 1, defaultUsage: usage(0x16), legend: "S" },
	{ id: keyId(13), row: 2, x: 3.75, width: 1, defaultUsage: usage(0x07), legend: "D" },
	{ id: keyId(20), row: 2, x: 4.75, width: 1, defaultUsage: usage(0x09), legend: "F" },
	{ id: keyId(21), row: 2, x: 5.75, width: 1, defaultUsage: usage(0x0a), legend: "G" },
	{ id: keyId(28), row: 2, x: 6.75, width: 1, defaultUsage: usage(0x0b), legend: "H" },
	{ id: keyId(29), row: 2, x: 7.75, width: 1, defaultUsage: usage(0x0d), legend: "J" },
	{ id: keyId(36), row: 2, x: 8.75, width: 1, defaultUsage: usage(0x0e), legend: "K" },
	{ id: keyId(37), row: 2, x: 9.75, width: 1, defaultUsage: usage(0x0f), legend: "L" },
	{ id: keyId(44), row: 2, x: 10.75, width: 1, defaultUsage: usage(0x33), legend: ";" },
	{ id: keyId(45), row: 2, x: 11.75, width: 1, defaultUsage: usage(0x34), legend: "'" },
	{ id: keyId(52), row: 2, x: 12.75, width: 2.25, defaultUsage: usage(0x28), legend: "Enter" },
	{ id: keyId(6), row: 3, x: 0, width: 2.25, defaultUsage: usage(0xe1), legend: "Shift" },
	{ id: keyId(7), row: 3, x: 2.25, width: 1, defaultUsage: usage(0x1d), legend: "Z" },
	{ id: keyId(14), row: 3, x: 3.25, width: 1, defaultUsage: usage(0x1b), legend: "X" },
	{ id: keyId(15), row: 3, x: 4.25, width: 1, defaultUsage: usage(0x06), legend: "C" },
	{ id: keyId(22), row: 3, x: 5.25, width: 1, defaultUsage: usage(0x19), legend: "V" },
	{ id: keyId(23), row: 3, x: 6.25, width: 1, defaultUsage: usage(0x05), legend: "B" },
	{ id: keyId(30), row: 3, x: 7.25, width: 1, defaultUsage: usage(0x11), legend: "N" },
	{ id: keyId(31), row: 3, x: 8.25, width: 1, defaultUsage: usage(0x10), legend: "M" },
	{ id: keyId(38), row: 3, x: 9.25, width: 1, defaultUsage: usage(0x36), legend: "," },
	{ id: keyId(39), row: 3, x: 10.25, width: 1, defaultUsage: usage(0x37), legend: "." },
	{ id: keyId(46), row: 3, x: 11.25, width: 1, defaultUsage: usage(0x38), legend: "/" },
	{ id: keyId(47), row: 3, x: 12.25, width: 2.75, defaultUsage: usage(0xe5), legend: "Shift" },
	{ id: keyId(75), row: 4, x: 0, width: 1.25, defaultUsage: usage(0xe0), legend: "Ctrl" },
	{ id: keyId(74), row: 4, x: 1.25, width: 1.25, defaultUsage: usage(0xe3), legend: "Win" },
	{ id: keyId(76), row: 4, x: 2.5, width: 1.25, defaultUsage: usage(0xe2), legend: "Alt" },
	{ id: keyId(72), row: 4, x: 3.75, width: 6.25, defaultUsage: usage(0x2c), legend: "Space" },
	{ id: keyId(78), row: 4, x: 10, width: 1.25, defaultUsage: usage(0xe6), legend: "Alt" },
	{ id: keyId(60), row: 4, x: 11.25, width: 1.25, defaultUsage: usage(0xe7), legend: "Fn" },
	{ id: keyId(54), row: 4, x: 12.5, width: 1.25, defaultUsage: usage(0x65), legend: "Pn" },
	{ id: keyId(63), row: 4, x: 13.75, width: 1.25, defaultUsage: usage(0xe4), legend: "Ctrl" },
];

/** Matrix cells that hold a usage in ROM but are not caps on the ANSI board (see TAB60_KEYS). Every other non-cap cell holds 0x00. */
export const NON_CAP_CELLS: readonly { readonly cell: KeyId; readonly usage: Usage; readonly what: string }[] = [
	{ cell: keyId(53), usage: usage(0x32), what: "ISO #" },
	{ cell: keyId(57), usage: usage(0x35), what: "Grave" },
	{ cell: keyId(71), usage: usage(0x64), what: "ISO \\" },
	{ cell: keyId(79), usage: usage(0xc9), what: "second Space position" },
];

/** The markers sub_5F4C writes at boot into the cells SRAM 0x20000E50/51 name, whose defaults are Fn and Pn. */
export const LAYER_KEY_MARKERS: readonly { readonly cell: KeyId; readonly usage: Usage; readonly what: string }[] = [
	{ cell: keyId(60), usage: usage(0xd8), what: "Fn" },
	{ cell: keyId(54), usage: usage(0xd9), what: "Pn" },
];

/** The 80-byte ROM keymap at flash 0xB205 as TAB60_KEYS and NON_CAP_CELLS describe it. `bun run real-image` checks it byte for byte. */
export function romKeymap(): readonly Usage[] {
	const cells = Array.from({ length: 80 }, () => usage(0));
	for (const { id, defaultUsage } of TAB60_KEYS) cells[id] = defaultUsage;
	for (const nonCap of NON_CAP_CELLS) cells[nonCap.cell] = nonCap.usage;
	return cells;
}

/** The active keymap boot builds from `rom` in the US layout: the ROM cells, then the Fn and Pn markers. */
export function activeKeymap(rom: readonly number[] = romKeymap()): readonly number[] {
	const cells = [...rom];
	for (const marker of LAYER_KEY_MARKERS) cells[marker.cell] = marker.usage;
	return cells;
}

/**
 * What a read of a layer returns from a store at its reset value (every byte 0xFF), for usages 0..255: "default" for
 * each usage some cell of `active` holds, "absent" for every other. It is the same on all three layers.
 */
export function predictCleanLayer(active: readonly number[]): ReadonlyMap<number, OverrideEntry> {
	const present = new Set(active);
	return new Map(Array.from({ length: 256 }, (_, k): [number, OverrideEntry] => [k, present.has(k) ? { kind: "default" } : { kind: "absent" }]));
}

export interface ConfigCapabilities {
	readonly canRead: boolean;
	readonly canWrite: boolean;
	readonly canSetOsMode: boolean;
	/** One line per config command the clearance does not clear, for the locked editor's explanation. */
	readonly blockedBy: readonly string[];
}

type Unlock = NonNullable<CommandSpec["unlocks"]>;

/** Derived from COMMANDS: a capability is unlocked when `clearance` clears every command that `unlocks` it. */
export function capabilities(clearance: Clearance): ConfigCapabilities {
	const unlocks = (name: CommandName): CommandSpec["unlocks"] => COMMANDS[name].unlocks;
	const ready = (unlock: Unlock) =>
		COMMAND_NAMES.filter((name) => unlocks(name) === unlock).every((name) => clears(clearance, name));
	return {
		canRead: ready("keymap-read"),
		canWrite: ready("keymap-read") && ready("keymap-write"),
		canSetOsMode: ready("os-mode"),
		blockedBy: COMMAND_NAMES.filter((name) => unlocks(name) !== null && !clears(clearance, name)).map((name) =>
			gateMessage(name, clearance),
		),
	};
}

const ascending = (a: number, b: number) => a - b;

/**
 * Pure diff: the overrides whose usage differs from what the board reports, by layer and then key. A cell without an
 * override is left alone, because the defaults above the base layer are unknown. A layer missing from `observed` gets
 * every override written.
 */
export function planKeymap(
	doc: KeymapDoc,
	observed: ReadonlyMap<Layer, ReadonlyMap<KeyId, Usage>>,
): readonly KeyWrite[] {
	const writes: KeyWrite[] = [];
	for (const layer of [...doc.overrides.keys()].sort(ascending)) {
		const keys = doc.overrides.get(layer)!;
		const held = observed.get(layer);
		for (const key of [...keys.keys()].sort(ascending)) {
			const want = keys.get(key)!;
			if (held?.get(key) !== want) writes.push({ layer, key, usage: want });
		}
	}
	return writes;
}

/**
 * The apply job, a convergence like the flash job but in SRAM.
 * TODO:
 *   session = start, or connect { modes: ["app"], reason: "connect" }    (update mode has no config channel)
 *   for each layer in doc: observed = config.readLayer(layer)
 *   writes = planKeymap(doc, observed)
 *   for each write: config.setKey(write); progress(applying-keymap i of n)
 *   if doc.osMode !== null: config.setOsMode(doc.osMode)
 *   read every touched layer back; a mismatch counts one attempt and loops (at most 3), then stops
 *   NotCleared -> stopped(gate). LinkLost -> reconnect and restart from the read, which is safe because writes are
 *   idempotent; as in flash.ts, a loss resets the attempt count.
 */
export function applyKeymap(doc: KeymapDoc): Job {
	return async (start, ctx) =>
		notImplemented(`applyKeymap(${doc.overrides.size} layers) from ${String(start?.mode)}, aborted=${ctx.signal.aborted}`);
}

const FORMAT = "tab60kit-keymap";
const VERSION = 1;
const FIELDS = ["format", "version", "osMode", "overrides"] as const;
const LAYERS: readonly string[] = ["0", "1", "2"];
const CAP_IDS: ReadonlySet<number> = new Set(TAB60_KEYS.map((cap) => cap.id));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Boundary parse for an imported file or stored JSON, the shape `serializeKeymapDoc` writes. Every field is required,
 * and an unknown field, layer, key, or usage is an error naming its path, never dropped. A key is the decimal id of a
 * cap in TAB60_KEYS. An empty layer object parses to an empty map, so the round trip is exact. Object.keys lists
 * array-index keys ascending, so the maps come out sorted.
 */
export function parseKeymapDoc(json: unknown): KeymapDoc | { readonly error: string } {
	const error = (path: string, why: string) => ({ error: `${path}: ${why}` });
	if (!isObject(json)) return error("$", "is not an object");
	const extra = Object.keys(json).find((field) => !(FIELDS as readonly string[]).includes(field));
	if (extra !== undefined) return error(`$.${extra}`, "is not a keymap field");
	const missing = FIELDS.find((field) => !(field in json));
	if (missing !== undefined) return error(`$.${missing}`, "is missing");
	if (json.format !== FORMAT) return error("$.format", `is ${JSON.stringify(json.format)}, not "${FORMAT}"`);
	if (json.version !== VERSION) return error("$.version", `is ${JSON.stringify(json.version)}, not ${VERSION}`);
	const { osMode } = json;
	if (osMode !== null && !(Number.isInteger(osMode) && (osMode as number) >= 0 && (osMode as number) <= 4)) {
		return error("$.osMode", `is ${JSON.stringify(osMode)}, not null or an integer from 0 to 4`);
	}
	if (!isObject(json.overrides)) return error("$.overrides", "is not an object");

	const overrides = new Map<Layer, ReadonlyMap<KeyId, Usage>>();
	for (const layer of Object.keys(json.overrides)) {
		const path = `$.overrides.${layer}`;
		if (!LAYERS.includes(layer)) return error(path, "is not a layer from 0 to 2");
		const keys = json.overrides[layer];
		if (!isObject(keys)) return error(path, "is not an object");
		const layerMap = new Map<KeyId, Usage>();
		for (const key of Object.keys(keys)) {
			const id = Number(key);
			if (String(id) !== key || !CAP_IDS.has(id)) return error(`${path}.${key}`, "is not the id of a TAB 60 cap");
			const value = keys[key];
			if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xe7) {
				return error(`${path}.${key}`, `is ${JSON.stringify(value)}, not an integer from 0 to 231 (0xE7)`);
			}
			layerMap.set(keyId(id), usage(value as number));
		}
		overrides.set(Number(layer) as Layer, layerMap);
	}
	return { overrides, osMode: osMode as OsMode | null };
}

/** Deterministic: layers and keys ascending, tab-indented, with a final newline. `parseKeymapDoc` reads it back equal. */
export function serializeKeymapDoc(doc: KeymapDoc): string {
	const overrides: Record<string, Record<string, number>> = {};
	for (const layer of [...doc.overrides.keys()].sort(ascending)) {
		const keys = doc.overrides.get(layer)!;
		overrides[layer] = Object.fromEntries([...keys.keys()].sort(ascending).map((key) => [key, keys.get(key)!]));
	}
	return `${JSON.stringify({ format: FORMAT, version: VERSION, osMode: doc.osMode, overrides }, null, "\t")}\n`;
}
