/**
 * Live keymap editing on stock firmware.
 *
 * The board keeps its keymap in SRAM and rebuilds it from ROM at every boot (R4: the app has no flash-write
 * path). So the host document is the copy that persists, and applying it is another convergence: read what the
 * board holds, write the difference, read back. The board forgets the edits on any MCU reset. On 2x AAA power an
 * unplug may not reset the MCU (open question in design.md).
 *
 * Every config command is unreviewed under G1. `capabilities(clearance)` derives what is unlocked from COMMANDS and
 * the same `clears` the egress audit uses, so the editor's locks and the wire gate cannot disagree.
 */
import type { Job } from "./job";
import { COMMANDS, COMMAND_NAMES, type Clearance, type CommandName, type CommandSpec, clears, gateMessage } from "./protocol";
import { type Brand, notImplemented } from "./units";

/** R4: the layer index is checked below 4. Which index is the base layer is settled by U10. */
export type Layer = 0 | 1 | 2 | 3;

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
 * The TAB 60's keys, authored from the physical layout. The ROM stores the matrix in column pairs
 * (ESC, 1, TAB, Q, CAPS, A, LSHIFT, Z, then 2, 3, W, E, ...). U9's test compares every `defaultUsage` with the
 * keymap bytes at 0xB205 in the user's own extracted image, so this table and the firmware cannot drift.
 * The first eight entries below match those ROM bytes. TODO: the remaining keys.
 */
export const TAB60_KEYS: readonly KeyCap[] = [
	{ id: keyId(0), row: 0, x: 0, width: 1, defaultUsage: usage(0x29), legend: "Esc" },
	{ id: keyId(1), row: 0, x: 1, width: 1, defaultUsage: usage(0x1e), legend: "1" },
	{ id: keyId(2), row: 1, x: 0, width: 1.5, defaultUsage: usage(0x2b), legend: "Tab" },
	{ id: keyId(3), row: 1, x: 1.5, width: 1, defaultUsage: usage(0x14), legend: "Q" },
	{ id: keyId(4), row: 2, x: 0, width: 1.75, defaultUsage: usage(0x39), legend: "Caps" },
	{ id: keyId(5), row: 2, x: 1.75, width: 1, defaultUsage: usage(0x04), legend: "A" },
	{ id: keyId(6), row: 3, x: 0, width: 2.25, defaultUsage: usage(0xe1), legend: "Shift" },
	{ id: keyId(7), row: 3, x: 2.25, width: 1, defaultUsage: usage(0x1d), legend: "Z" },
];

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

/** Pure diff: the overrides whose usage differs from what the board reports. */
export function planKeymap(
	doc: KeymapDoc,
	observed: ReadonlyMap<Layer, ReadonlyMap<KeyId, Usage>>,
): readonly KeyWrite[] {
	return notImplemented(`planKeymap(${doc.overrides.size} layers, ${observed.size} observed)`);
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

/** Boundary parse for an imported file or stored JSON. Unknown keys, usages, or layers are errors, not dropped. */
export function parseKeymapDoc(json: unknown): KeymapDoc | { readonly error: string } {
	return notImplemented(`parseKeymapDoc(${typeof json})`);
}

export function serializeKeymapDoc(doc: KeymapDoc): string {
	return notImplemented(`serializeKeymapDoc(${doc.overrides.size})`);
}
