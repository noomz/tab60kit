/**
 * Plan U9's check on the vendor's own exe: every TAB60_KEYS `defaultUsage` against the ROM keymap at flash 0xB205.
 * Plan U10's: the factory layer 2 table, the OS key mode swaps, and the Fn and Pn cells against their ROM bytes, then
 * `predictLayers` for every mode and layer against a prediction computed from the ROM bytes alone.
 * The exe goes through core's own extractor (`readUpdater`, U3), which holds the image in wire form; `xorWords` gives
 * the plain image, the bytes R2's decoder writes. The exe is never committed, so this runs locally, not in `check`.
 *
 * Run: TAB60_EXE=<Tab60firmwareV1.01.13.exe> bun run real-image
 */
import { readFileSync } from "node:fs";
import { CATALOG, imageBytes, readUpdater, sha256, xorWords } from "../core/firmware";
import { FACTORY_LAYER2, LAYER_KEY_MARKERS, NON_CAP_CELLS, OS_KEY_MODES, type OsKeyMode, TAB60_KEYS, predictLayers, romKeymap } from "../core/keymap";
import type { OverrideEntry } from "../core/protocol";
import { parseMaav102 } from "../core/updater";

const exePath = process.env.TAB60_EXE;
if (!exePath) {
	console.error("FAIL TAB60_EXE (the V1.01.13 updater) must be set");
	process.exit(1);
}

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failures++;
}
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** R4: the firmware copies the 80-byte matrix keymap from here at boot. */
const KEYMAP_FLASH = 0xb205;
/** sub_4540: the factory (usage, code) pairs, ended by 0xD8; the Fn and Pn cells it copies to SRAM 0x20000E50/51. */
const FACTORY_FLASH = 0xb2d6;
const FN_PN_CELLS_FLASH = 0xaa14;
/** sub_5F4C: the swap pairs per OS key mode, and the markers it writes into the Fn and Pn cells. */
const SWAPS_FLASH: Readonly<Record<OsKeyMode, { readonly at: number; readonly pairs: number }>> = { windows: { at: 0, pairs: 0 }, mac: { at: 0xaa25, pairs: 4 }, "caps-ctrl": { at: 0xaa21, pairs: 2 } };
const MARKERS = [0xd8, 0xd9];
const ABSENT = 0x0003;
const DEFAULT = 0x00ff;
const wordOf = (entry: OverrideEntry | undefined) =>
	entry === undefined ? -1 : entry.kind === "default" ? DEFAULT : entry.kind === "absent" ? ABSENT : (entry.flags << 8) | entry.code;

const [entry] = CATALOG;
if (entry === undefined) throw new Error("the catalog is empty");
const exe = new Uint8Array(readFileSync(exePath));
const reading = await readUpdater(exe);
const admission = reading.kind === "read" ? reading.images[0]?.admission : undefined;
check(admission?.kind === "admitted" && admission.image.entry === entry, `readUpdater admits the ${entry.version} image`);
const contents = parseMaav102(exe);
const base = "code" in contents ? null : (contents.images[0]?.impliedBase ?? null);
check(base !== null, `the image's implied base is ${base === null ? "unknown" : `0x${base.toString(16)}`}`);

if (admission?.kind === "admitted" && base !== null) {
	const plain = xorWords(imageBytes(admission.image).wire.bytes);
	check((await sha256(plain)) === entry.image.sha256, "the plain image hashes to the catalog's image sha256 (R2's decoded file)");
	const at = KEYMAP_FLASH - base;
	const rom = plain.subarray(at, at + 80);
	check(rom.length === 80, `80 keymap bytes at image offset 0x${at.toString(16)}`);
	for (const cap of TAB60_KEYS) {
		const byte = rom[cap.id];
		check(byte === cap.defaultUsage, `cell ${cap.id} ${cap.legend}: table ${hex(cap.defaultUsage)}, ROM ${byte === undefined ? "none" : hex(byte)}`);
	}
	for (const { cell, usage: want, what } of NON_CAP_CELLS) {
		const byte = rom[cell];
		check(byte === want, `cell ${cell} (${what}, not a cap): ROM ${byte === undefined ? "none" : hex(byte)}, expected ${hex(want)}`);
	}
	const table = romKeymap();
	const differ = table.flatMap((want, cell) => (rom[cell] === want ? [] : [cell]));
	check(differ.length === 0, `romKeymap() equals all 80 ROM bytes${differ.length === 0 ? "" : `; cells ${differ.join(", ")} differ`}`);

	const flash = (address: number, length: number) => plain.subarray(address - base, address - base + length);
	const pairsAt = (address: number, count: number) => Array.from({ length: count }, (_, i) => [flash(address + 2 * i, 1)[0]!, flash(address + 2 * i + 1, 1)[0]!] as const);
	const factory = pairsAt(FACTORY_FLASH, FACTORY_LAYER2.length);
	const tableDiffers = FACTORY_LAYER2.flatMap(({ usage: k, code }, i) => (factory[i]![0] === k && factory[i]![1] === code ? [] : [i]));
	check(tableDiffers.length === 0, `FACTORY_LAYER2 equals the ${FACTORY_LAYER2.length} pairs at flash 0x${FACTORY_FLASH.toString(16)}${tableDiffers.length === 0 ? "" : `; pairs ${tableDiffers.join(", ")} differ`}`);
	const end = flash(FACTORY_FLASH + 2 * FACTORY_LAYER2.length, 1)[0];
	check(end === 0xd8, `the byte after the factory pairs is ${end === undefined ? "none" : hex(end)}, the 0xd8 that ends them`);
	for (const [mode, { at, pairs }] of Object.entries(SWAPS_FLASH) as [OsKeyMode, (typeof SWAPS_FLASH)[OsKeyMode]][]) {
		const romPairs = pairsAt(at, pairs).map(([a, b]) => `${hex(a)}>${hex(b)}`).join(" ");
		const table = OS_KEY_MODES[mode].swaps.map(([a, b]) => `${hex(a)}>${hex(b)}`).join(" ");
		check(romPairs === table, `OS key mode ${mode} (0x${OS_KEY_MODES[mode].byte.toString(16)}) swaps "${table}", ROM${at === 0 ? " has none" : ` 0x${at.toString(16)}`} "${romPairs}"`);
	}
	const cells = Array.from(flash(FN_PN_CELLS_FLASH, 2));
	const markerCells = LAYER_KEY_MARKERS.map(({ cell }) => cell);
	check(cells.join() === markerCells.join(), `Fn and Pn cells: table ${markerCells.join(", ")}, ROM 0x${FN_PN_CELLS_FLASH.toString(16)} ${cells.join(", ")}`);

	const reverseOf = (keymap: readonly number[]) => {
		const reverse = new Map<number, number>();
		for (let c = keymap.length - 1; c >= 0; c--) reverse.set(keymap[c]!, c);
		return reverse;
	};
	const activeFromRom = (mode: OsKeyMode) => {
		const keymap = Array.from(rom);
		const before = reverseOf(keymap);
		for (const [from, to] of pairsAt(SWAPS_FLASH[mode].at, SWAPS_FLASH[mode].pairs)) {
			const c = before.get(from);
			if (c !== undefined) keymap[c] = to;
		}
		cells.forEach((c, i) => {
			keymap[c] = MARKERS[i]!;
		});
		return keymap;
	};
	const atReset = reverseOf(activeFromRom("windows"));
	const layer2 = new Map<number, number>();
	for (const [k, code] of factory) {
		const c = atReset.get(k);
		if (c !== undefined) layer2.set(c, 0x100 | code);
	}
	for (const mode of Object.keys(SWAPS_FLASH) as OsKeyMode[]) {
		const now = reverseOf(activeFromRom(mode));
		const predicted = predictLayers(mode);
		for (const layer of [0, 1, 2] as const) {
			const differ = Array.from({ length: 256 }, (_, k) => k).filter((k) => {
				const c = now.get(k);
				const want = c === undefined ? ABSENT : layer === 2 ? (layer2.get(c) ?? DEFAULT) : DEFAULT;
				return wordOf(predicted.get(layer)?.get(k)) !== want;
			});
			const overrides = [...(predicted.get(layer)?.values() ?? [])].filter((entry) => entry.kind === "override").length;
			check(differ.length === 0, `predictLayers(${mode}) layer ${layer}: ${now.size} usages present, ${overrides} overrides${differ.length === 0 ? ", all 256 entries as the ROM says" : `; usages ${differ.map(hex).join(", ")} differ`}`);
		}
	}
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
