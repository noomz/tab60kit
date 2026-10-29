/**
 * Live keymap editing on stock firmware.
 *
 * The board rebuilds its active keymap from ROM at every boot and applies a per-key override store on top. An early read said
 * the app has no flash-write path; the U10 static read found a serial-flash save of the block that holds the store,
 * and the U11 static read found that a host key write lands in RAM only, so a power cycle restores the saved store.
 * The host document is the user's intent, and applying it is another convergence: read what the board holds, write
 * the difference, read back.
 *
 * Under G1 the two override reads, the gate rows, and the key write are confirmed. `capabilities(clearance)` derives
 * what is unlocked from COMMANDS and the same `clears` the egress audit uses, so the editor's locks and the wire gate
 * cannot disagree.
 */
import { MAX_LINK_LOSSES } from "./flash";
import { type Activity, type Job, type JobEnd, type JobResult, type StopReason, isLinkFailure, stopReasonFor } from "./job";
import {
	type AppSession,
	COMMANDS,
	COMMAND_NAMES,
	type Clearance,
	type CommandName,
	type CommandSpec,
	DeviceRefused,
	FLASH_ROWS,
	type OverrideEntry,
	type OverrideValue,
	type Session,
	clears,
	connect,
	gateMessage,
} from "./protocol";
import type { Brand } from "./units";

/**
 * A key layer of the override store. sub_5E98 bounds its index at 0x2FF (layer << 8 | usage), and the reset clears
 * 3 x (80 + 20) bytes, so there are three (docs/app-firmware.md, VERIFIED). Layer 0 is the base layer, INFERRED.
 */
export type Layer = 0 | 1 | 2;

/** Index into the 80-byte matrix keymap the firmware copies from ROM 0xB205 at boot. Built only by `keyId`. */
export type KeyId = Brand<number, "KeyId">;

/** HID keyboard-page usage, 0x00..0xE7. Built only by `usage`. */
export type Usage = Brand<number, "Usage">;

/** docs/app-firmware.md: cmd 0x51/0x00 accepts values below 5. */
export type OsMode = 0 | 1 | 2 | 3 | 4;

export function keyId(n: number): KeyId {
	if (!Number.isInteger(n) || n < 0 || n >= 80) throw new RangeError(`key index ${n} is outside the 80-entry matrix`);
	return n as KeyId;
}

export function usage(n: number): Usage {
	if (!Number.isInteger(n) || n < 0 || n > 0xe7) throw new RangeError(`usage 0x${n.toString(16)} is outside the keyboard page`);
	return n as Usage;
}

/** One cfgWriteKey frame Apply sends: the document's usage for a key, or no override where the document dropped one. */
export interface KeyWrite {
	readonly layer: Layer;
	readonly key: KeyId;
	readonly value: OverrideValue;
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

/**
 * Whether Apply may write `key`. Fn and Pn are not: the store lookup skips their marker usages 0xD8..0xDF (0x51BC), so
 * an override there never takes effect (U11 research, VERIFIED).
 */
export function canRemap(key: KeyId): boolean {
	return LAYER_KEY_MARKERS.every((marker) => marker.cell !== key);
}

/** The 80-byte ROM keymap at flash 0xB205 as TAB60_KEYS and NON_CAP_CELLS describe it. `bun run real-image` checks it byte for byte. */
export function romKeymap(): readonly Usage[] {
	const cells = Array.from({ length: 80 }, () => usage(0));
	for (const { id, defaultUsage } of TAB60_KEYS) cells[id] = defaultUsage;
	for (const nonCap of NON_CAP_CELLS) cells[nonCap.cell] = nonCap.usage;
	return cells;
}

/**
 * The OS key mode, SRAM 0x2000102B, the last byte of the saved config block. Pn+Q, Pn+W, and Pn+E (factory codes
 * 0x13D, 0x13E, 0x13F) set 0x10, 0x20, and 0x40. sub_5F4C swaps usages in the active keymap per mode with the pairs
 * at ROM 0xAA25 (0x20) and 0xAA21 (0x40) before it writes the Fn and Pn markers. Not the OsMode byte 0x2000000F that an early read named: that
 * byte does not touch the keymap. "mac" is INFERRED from the Alt/GUI swap and the maintainer's report.
 */
export type OsKeyMode = "windows" | "mac" | "caps-ctrl";

export const OS_KEY_MODES: Readonly<Record<OsKeyMode, { readonly byte: 0x10 | 0x20 | 0x40; readonly swaps: readonly (readonly [Usage, Usage])[] }>> = {
	windows: { byte: 0x10, swaps: [] },
	mac: { byte: 0x20, swaps: [[usage(0xe2), usage(0xe3)], [usage(0xe3), usage(0xe2)], [usage(0xe6), usage(0xe7)], [usage(0xe7), usage(0xe6)]] },
	"caps-ctrl": { byte: 0x40, swaps: [[usage(0x39), usage(0xe0)], [usage(0xe0), usage(0x39)]] },
};

/**
 * The 31 (usage, code) pairs at ROM 0xB2D6 that sub_4540 writes to layer 2 with flags 1 whenever the store resets
 * (sub_44A4). `bun run real-image` checks them byte for byte, and the 0xD8 after them.
 */
export const FACTORY_LAYER2: readonly { readonly usage: Usage; readonly code: number }[] = (
	[
		[0x29, 0x70], [0x1e, 0xa0], [0x1f, 0xa1], [0x20, 0xa2], [0x21, 0x82], [0x22, 0x83], [0x26, 0xac], [0x27, 0xad],
		[0x2d, 0xa8], [0x2e, 0xa9], [0xe2, 0x30], [0x2b, 0x35], [0x31, 0x36], [0x0d, 0x31], [0x0e, 0x32], [0x0f, 0x33],
		[0x33, 0x34], [0x11, 0x10], [0x10, 0x11], [0x36, 0x12], [0x37, 0x13], [0xe0, 0x5f], [0xe5, 0x68], [0xe3, 0x60],
		[0x14, 0x3d], [0x1a, 0x3e], [0x08, 0x3f], [0x04, 0x92], [0x16, 0x93], [0x1d, 0x90], [0x1b, 0x91],
	] as const
).map(([k, code]) => ({ usage: usage(k), code }));
const FACTORY_FLAGS = 1;

/**
 * The 33 (cell, code) pairs at ROM 0xAAC8 that sub_A364 applies while Fn (marker 0xD8) is held and the layer 1 store
 * lookup missed, so a layer 1 override wins over them (docs/app-firmware.md "Fn layer"). Keyed by cell, so the OS key
 * mode swaps do not move them. A code is a keyboard usage, or 0xEC + n for bit n of the consumer report: 0xF0
 * Play/Pause, 0xF2 previous, 0xF3 next, 0xF4 Mute, 0xF5 Vol-, 0xF6 Vol+. `bun run real-image` checks them byte for byte.
 */
export const FN_LAYER: readonly { readonly key: KeyId; readonly code: number }[] = (
	[
		[0, 0x35], [1, 0x3a], [8, 0x3b], [9, 0x3c], [16, 0x3d], [17, 0x3e], [24, 0x3f], [25, 0x40],
		[32, 0x41], [33, 0x42], [40, 0x43], [41, 0x44], [48, 0x45], [42, 0x46], [43, 0x47], [50, 0x48],
		[44, 0x49], [7, 0x65], [49, 0x4c], [3, 0xf2], [10, 0xf0], [11, 0xf3], [12, 0xf5], [13, 0xf6],
		[20, 0xf4], [34, 0x52], [29, 0x50], [36, 0x51], [37, 0x4f], [28, 0x4a], [30, 0x4d], [27, 0x4b],
		[35, 0x4e],
	] as const
).map(([cell, code]) => ({ key: keyId(cell), code }));

/**
 * sub_A410: in OS key mode 0x20 (Mac), with no Shift held, these Fn cells send another code than FN_LAYER's. Code,
 * not a table; `bun run real-image` checks each `cmp`/`movs` pair. 0x69/0x6A are F14/F15, which macOS takes as
 * brightness (INFERRED); 0xCA sends nothing and sets a flag whose reader is not traced; 0xCC and 0xCD go out as
 * plain keyboard usages.
 */
export const FN_LAYER_MAC: readonly { readonly key: KeyId; readonly code: number }[] = (
	[
		[1, 0x69], [8, 0x6a], [9, 0xca], [17, 0xcc], [24, 0xcd], [25, 0xf2], [32, 0xf0], [33, 0xf3],
		[40, 0xf4], [41, 0xf5], [48, 0xf6],
	] as const
).map(([cell, code]) => ({ key: keyId(cell), code }));

/**
 * What a key with no override does on a factory layer. `function`: a Pn function code (flags << 8 | code) that the
 * store reset writes. `fn`: the Fn layer's code in every OS key mode, and the code it sends instead in Mac mode
 * without Shift (null when Mac mode sends the same).
 */
export type FactoryKey = { readonly kind: "function"; readonly code: number } | { readonly kind: "fn"; readonly code: number; readonly mac: number | null };

/**
 * What `key` does on `layer` with no override, or null when it sends its cap. Layer 0 has no factory functions. On
 * layer 1 a cell that FN_LAYER does not list sends its cap (the store miss clears the layer, docs/app-firmware.md
 * "Fn layer", INFERRED). On layer 2 the store reset writes FACTORY_LAYER2 by cell under the Windows keymap, so the
 * cell does not move with the OS key mode; whether the board still holds it depends on its history (the passing U10
 * board run, `fixtures/u10-macos.json`, found Esc's pair missing), so this is what the reset leaves, not a read.
 */
export function factoryKey(layer: Layer, key: KeyId): FactoryKey | null {
	if (layer === 1) {
		const fn = FN_LAYER.find((pair) => pair.key === key);
		return fn === undefined ? null : { kind: "fn", code: fn.code, mac: FN_LAYER_MAC.find((pair) => pair.key === key)?.code ?? null };
	}
	if (layer !== 2) return null;
	const atReset = reverseMap(activeKeymap("windows"));
	const pair = FACTORY_LAYER2.find(({ usage: k }) => atReset.get(k) === key);
	return pair === undefined ? null : { kind: "function", code: (FACTORY_FLAGS << 8) | pair.code };
}

/** The code an Fn key sends in `mode`: sub_A410 swaps in the Mac code only in Mac mode and only without Shift. */
export const fnCode = (fn: Extract<FactoryKey, { kind: "fn" }>, mode: OsKeyMode, shift: boolean): number =>
	mode === "mac" && !shift && fn.mac !== null ? fn.mac : fn.code;

/** sub_91EC: usage to the cell that holds it, scanning down from cell 79 so the lowest cell wins a duplicate. */
function reverseMap(cells: readonly number[]): ReadonlyMap<number, number> {
	const reverse = new Map<number, number>();
	for (let cell = cells.length - 1; cell >= 0; cell--) reverse.set(cells[cell]!, cell);
	return reverse;
}

/** The active keymap in the US layout: the ROM cells, the mode's swaps (sub_5368), then the Fn and Pn markers. */
export function activeKeymap(mode: OsKeyMode, rom: readonly number[] = romKeymap()): readonly number[] {
	const cells = [...rom];
	const before = reverseMap(rom);
	for (const [from, to] of OS_KEY_MODES[mode].swaps) {
		const cell = before.get(from);
		if (cell !== undefined) cells[cell] = to;
	}
	for (const marker of LAYER_KEY_MARKERS) cells[marker.cell] = marker.usage;
	return cells;
}

/** The usages some cell of the active keymap holds in `mode`, ascending: the ones a read reports present. */
export function presentUsages(mode: OsKeyMode): readonly number[] {
	return [...new Set(activeKeymap(mode))].sort((a, b) => a - b);
}

/**
 * What a read of each layer returns, for usages 0..255, from a store the reset left as it is (the first U10 board run,
 * `testing/fixtures/tab60kit-u10-2026-10-19T07-42-46-288Z.json`). The
 * reset writes FACTORY_LAYER2 by cell under the "windows" keymap; the board now runs in `mode`, and a read finds the
 * cell by its active usage. So in "mac", usage 0xE2 reads the entry written for 0xE3. Layers 0 and 1 hold no overrides.
 */
export function predictLayers(mode: OsKeyMode): ReadonlyMap<Layer, ReadonlyMap<number, OverrideEntry>> {
	const atReset = reverseMap(activeKeymap("windows"));
	const layer2 = new Map<number, OverrideEntry>();
	for (const { usage: k, code } of FACTORY_LAYER2) {
		const cell = atReset.get(k);
		if (cell !== undefined) layer2.set(cell, { kind: "override", code, flags: FACTORY_FLAGS });
	}
	const now = reverseMap(activeKeymap(mode));
	const read = (store: ReadonlyMap<number, OverrideEntry>) =>
		new Map(Array.from({ length: 256 }, (_, k): [number, OverrideEntry] => {
			const cell = now.get(k);
			return [k, cell === undefined ? { kind: "absent" } : (store.get(cell) ?? { kind: "default" })];
		}));
	return new Map<Layer, ReadonlyMap<number, OverrideEntry>>([
		[0, read(new Map())],
		[1, read(new Map())],
		[2, read(layer2)],
	]);
}

export interface ConfigCapabilities {
	readonly canRead: boolean;
	readonly canWrite: boolean;
	readonly canSetOsMode: boolean;
	/** One line per config command the clearance does not clear, for the locked editor's explanation. */
	readonly blockedBy: readonly string[];
	/** One line per flash row (protocol.ts FLASH_ROWS) the clearance does not clear. Empty: Make official may run. */
	readonly flashBlockedBy: readonly string[];
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
		flashBlockedBy: FLASH_ROWS.filter((name) => !clears(clearance, name)).map((name) => gateMessage(name, clearance)),
	};
}

const ascending = (a: number, b: number) => a - b;

const holds = (entry: OverrideEntry | undefined, value: OverrideValue) =>
	entry !== undefined && (value.kind === "default" ? entry.kind === "default" : entry.kind === "override" && entry.flags === 0 && entry.code === value.code);

/**
 * Pure diff, by layer and then key. A key the document overrides gets its usage unless the board already holds it.
 * A key the document does not override but the board holds a flags-0 override for gets 0x00FF, so a key removed
 * from the document loses its override at the next Apply: only a host write or an on-board recording makes a flags-0
 * entry. An entry with flags set (the factory layer 2 function codes) is left alone unless the document overrides
 * that key, because cfgWriteKey cannot write flags back. A layer missing from `observed` gets every override written.
 */
export function planKeymap(doc: KeymapDoc, observed: ReadonlyMap<Layer, ReadonlyMap<KeyId, OverrideEntry>>): readonly KeyWrite[] {
	const writes: KeyWrite[] = [];
	const none = new Map<KeyId, never>();
	for (const layer of [...new Set([...doc.overrides.keys(), ...observed.keys()])].sort(ascending)) {
		const wanted = doc.overrides.get(layer) ?? none;
		const held = observed.get(layer) ?? none;
		for (const key of [...new Set([...wanted.keys(), ...held.keys()])].sort(ascending)) {
			const want = wanted.get(key);
			const entry = held.get(key);
			const value: OverrideValue | null =
				want !== undefined ? { kind: "override", code: want, flags: 0 } : entry?.kind === "override" && entry.flags === 0 ? { kind: "default" } : null;
			if (value !== null && !holds(entry, value)) writes.push({ layer, key, value });
		}
	}
	return writes;
}

/** Why Apply stopped on a board that answered. Nothing past the first refused or mismatched write was sent. */
export type KeymapProblem =
	/** The usages layer 0 reports present differ from `mode`'s active keymap: another OS key mode, or Fn or Pn moved. Nothing was written. */
	| { readonly kind: "mode-disagrees"; readonly mode: OsKeyMode; readonly missing: readonly number[]; readonly unexpected: readonly number[] }
	/** The gate byte read `gate`: before Apply, neither closed nor 0x80 (another tool holds config mode); after the close, not 0. */
	| { readonly kind: "gate"; readonly when: "before" | "after"; readonly gate: number }
	/** The board answered with the error marker, as it does for a closed gate or a usage no key has. */
	| { readonly kind: "refused"; readonly message: string }
	/** A write's reply or the read after the writes did not hold the value written. The gate was closed afterwards. */
	| { readonly kind: "read-back"; readonly layer: Layer; readonly key: KeyId; readonly want: string; readonly got: string };

const LAYERS: readonly Layer[] = [0, 1, 2];
const GATE_CLOSED = COMMANDS.gateClose.sub;
const GATE_OPEN = COMMANDS.gateOpen.sub;

const describeOverride = (entry: OverrideEntry | OverrideValue): string =>
	entry.kind === "override" ? `0x${((entry.flags << 8) | entry.code).toString(16).padStart(4, "0")}` : entry.kind;

/** Whether this job may have left the gate at 0x80. A stop after it opened, or found it open, closes it (timer 0 never expires). */
interface GateHold {
	open: boolean;
}

/** The override store as the board holds it, by layer and remappable cap. */
export type StoreReading = ReadonlyMap<Layer, ReadonlyMap<KeyId, OverrideEntry>>;

/** The active usage each remappable cap is addressed by in `mode`. */
function usageIn(mode: OsKeyMode): (key: KeyId) => Usage {
	const active = activeKeymap(mode);
	return (key) => {
		if (!canRemap(key)) throw new RangeError(`key ${key} is Fn or Pn, which no override changes`);
		return usage(active[key]!);
	};
}

/**
 * Reads layer 0 and checks its presence set against `mode`, then reads layers 1 and 2 for each remappable cap. Reads
 * only: no gate frame, no write. A presence set that disagrees with `mode` stops before the per-key reads.
 */
async function readStore(app: AppSession, mode: OsKeyMode, signal: AbortSignal): Promise<{ readonly store: StoreReading } | { readonly problem: KeymapProblem }> {
	const { config } = app;
	const layer0 = await config.readLayer0(signal);
	const present = new Set([...layer0].flatMap(([k, entry]) => (entry.kind === "absent" ? [] : [k])));
	const want = new Set(presentUsages(mode));
	const missing = [...want].filter((k) => !present.has(k));
	const unexpected = [...present].filter((k) => !want.has(k)).sort(ascending);
	if (missing.length > 0 || unexpected.length > 0) return { problem: { kind: "mode-disagrees", mode, missing, unexpected } };
	const usageOf = usageIn(mode);
	const store = new Map<Layer, ReadonlyMap<KeyId, OverrideEntry>>();
	for (const layer of LAYERS) {
		const keys = new Map<KeyId, OverrideEntry>();
		for (const { id } of TAB60_KEYS) {
			if (!canRemap(id)) continue;
			keys.set(id, layer === 0 ? (layer0.get(usageOf(id)) ?? { kind: "absent" }) : await config.readKey(layer, usageOf(id), signal));
		}
		store.set(layer, keys);
	}
	return { store };
}

/**
 * One pass on an open normal-mode session: query the gate, read layer 0 and check its presence set against `mode`,
 * read layers 1 and 2 for each remappable cap, write the plan with the gate at 0x80, read every write back, close the
 * gate, and query it. A board that already holds the document, with the gate closed, gets no write and no gate frame.
 */
async function converge(
	app: AppSession,
	doc: KeymapDoc,
	mode: OsKeyMode,
	signal: AbortSignal,
	progress: (activity: Activity) => void,
	hold: GateHold,
): Promise<{ readonly writes: number } | { readonly problem: KeymapProblem }> {
	const { config } = app;
	const before = await config.queryGate(signal);
	if (before.gate !== GATE_CLOSED && before.gate !== GATE_OPEN) return { problem: { kind: "gate", when: "before", gate: before.gate } };
	hold.open = before.gate === GATE_OPEN;
	const read = await readStore(app, mode, signal);
	let problem: KeymapProblem | null = "problem" in read ? read.problem : null;
	const observed = "store" in read ? read.store : new Map<Layer, ReadonlyMap<KeyId, OverrideEntry>>();
	const usageOf = usageIn(mode);
	const writes = problem === null ? planKeymap(doc, observed) : [];
	const mismatch = (write: KeyWrite, got: OverrideEntry): KeymapProblem => ({ kind: "read-back", layer: write.layer, key: write.key, want: describeOverride(write.value), got: describeOverride(got) });
	if (writes.length > 0) {
		if (!hold.open) {
			hold.open = true;
			await config.openGate(signal);
		}
		for (const [done, write] of writes.entries()) {
			progress({ kind: "applying-keymap", done, total: writes.length });
			const got = await config.writeKey(write.layer, usageOf(write.key), write.value, signal);
			if (!holds(got, write.value)) {
				problem = mismatch(write, got);
				break;
			}
		}
		for (const write of problem === null ? writes : []) {
			const got = await config.readKey(write.layer, usageOf(write.key), signal);
			if (!holds(got, write.value)) {
				problem = mismatch(write, got);
				break;
			}
		}
	}
	if (hold.open) {
		await config.closeGate(signal);
		hold.open = false;
		const after = await config.queryGate(signal);
		if (problem === null && after.gate !== GATE_CLOSED) problem = { kind: "gate", when: "after", gate: after.gate };
	}
	return problem === null ? { writes: writes.length } : { problem };
}

/** What one pass of a config job does on an open normal-mode session. `hold` tracks the gate for the stop path. */
type ConfigPass = (app: AppSession, signal: AbortSignal, progress: (activity: Activity) => void, hold: GateHold) => Promise<{ readonly result: JobResult } | { readonly problem: KeymapProblem }>;

/**
 * The loop both config jobs share: open a normal-mode session, run one pass, and on a lost link reconnect and run
 * the pass again from the reads. Any other stop after the gate opened sends a close first, on its own signal so a
 * Stop still reaches the board.
 */
function configJob(pass: ConfigPass): Job {
	return async (start, ctx) => {
		const stopped = (reason: StopReason, end: Session | null): JobEnd => ({ kind: "stopped", reason, session: end, board: null });
		let session: Session | null = start;
		let losses = 0;
		let during: Activity | null = null;
		const hold: GateHold = { open: false };
		const progress = (activity: Activity) => {
			during = activity;
			ctx.progress(activity);
		};
		for (;;) {
			try {
				if (session?.mode !== "app") {
					await session?.close();
					session = null;
					progress({ kind: "reading" });
					const opened = await connect(ctx, { modes: ["app"], reason: losses > 0 ? "after-link-loss" : "connect" });
					if ("refusal" in opened) {
						await opened.close();
						return stopped({ kind: "board-refused", refusal: opened.refusal }, null);
					}
					session = opened;
				}
				const outcome = await pass(session, ctx.signal, progress, hold);
				if ("problem" in outcome) return stopped({ kind: "keymap", problem: outcome.problem }, session);
				return { kind: "finished", result: outcome.result, session, board: null };
			} catch (error) {
				if (hold.open && !isLinkFailure(error) && session?.mode === "app") {
					await session.config.closeGate(new AbortController().signal).catch(() => undefined);
					hold.open = false;
				}
				await session?.close().catch(() => undefined);
				session = null;
				if (isLinkFailure(error)) {
					if (++losses > MAX_LINK_LOSSES) return stopped({ kind: "too-many-link-losses", losses }, null);
					progress({ kind: "link-lost", losses });
					continue;
				}
				if (error instanceof DeviceRefused) return stopped({ kind: "keymap", problem: { kind: "refused", message: error.message } }, null);
				const reason = stopReasonFor(error, ctx.signal, during);
				if (reason === null) throw error;
				return stopped(reason, null);
			}
		}
	};
}

/**
 * The apply job, a convergence like the flash job but in SRAM. `mode` is the board's OS key mode, which decides the
 * active usage each cap is addressed by; no command reads it, so the user names it and the presence check refuses a
 * wrong Windows or Mac choice (Windows and the Caps/Ctrl swap have the same presence set). The writes are never saved:
 * the page keeps the document, and Apply sends it again after a power loss. A lost link reconnects and starts over
 * from the reads, which is safe because the writes are idempotent. A document with an OS mode stops before any frame:
 * 0x51/0x00 is a profile switch that writes flash, and G1 never clears it.
 */
export function applyKeymap(doc: KeymapDoc, mode: OsKeyMode): Job {
	const apply = configJob(async (app, signal, progress, hold) => {
		const outcome = await converge(app, doc, mode, signal, progress, hold);
		return "problem" in outcome ? outcome : { result: { kind: "keymap-applied", writes: outcome.writes } };
	});
	return async (start, ctx) =>
		doc.osMode !== null ? { kind: "stopped", reason: { kind: "gate", blocked: gateMessage("cfgSetOsMode", ctx.clearance) }, session: start, board: null } : apply(start, ctx);
}

/**
 * The read job: what the override store holds now, for the editor to show. It sends only the reads Apply sends before
 * it writes (layer 0, then layers 1 and 2 per remappable cap), so it needs no gate and changes nothing.
 */
export function readKeymap(mode: OsKeyMode): Job {
	return configJob(async (app, signal) => {
		const read = await readStore(app, mode, signal);
		return "problem" in read ? read : { result: { kind: "keymap-read", mode, store: read.store } };
	});
}

const FORMAT = "tab60kit-keymap";
const VERSION = 1;
const FIELDS = ["format", "version", "osMode", "overrides"] as const;
const LAYER_NAMES: readonly string[] = ["0", "1", "2"];
const REMAPPABLE_IDS: ReadonlySet<number> = new Set(TAB60_KEYS.flatMap((cap) => (canRemap(cap.id) ? [cap.id] : [])));
/** sub_5E98 refuses a value of 0x0003, which reads back as "absent". */
const ABSENT_CODE = 0x03;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Boundary parse for an imported file or stored JSON, the shape `serializeKeymapDoc` writes. Every field is required,
 * and an unknown field, layer, key, or usage is an error naming its path, never dropped. A key is the decimal id of a
 * cap in TAB60_KEYS that `canRemap`. An empty layer object parses to an empty map, so the round trip is exact. Object.keys lists
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
		if (!LAYER_NAMES.includes(layer)) return error(path, "is not a layer from 0 to 2");
		const keys = json.overrides[layer];
		if (!isObject(keys)) return error(path, "is not an object");
		const layerMap = new Map<KeyId, Usage>();
		for (const key of Object.keys(keys)) {
			const id = Number(key);
			if (String(id) !== key || !REMAPPABLE_IDS.has(id)) return error(`${path}.${key}`, "is not the id of a TAB 60 cap other than Fn and Pn");
			const value = keys[key];
			if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xe7 || value === ABSENT_CODE) {
				return error(`${path}.${key}`, `is ${JSON.stringify(value)}, not an integer from 0 to 231 (0xE7) other than 3`);
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
