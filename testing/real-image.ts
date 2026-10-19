/**
 * Plan U9's check on the vendor's own exe: every TAB60_KEYS `defaultUsage` against the ROM keymap at flash 0xB205.
 * The exe goes through core's own extractor (`readUpdater`, U3), which holds the image in wire form; `xorWords` gives
 * the plain image, the bytes R2's decoder writes. The exe is never committed, so this runs locally, not in `check`.
 *
 * Run: TAB60_EXE=<Tab60firmwareV1.01.13.exe> bun run real-image
 */
import { readFileSync } from "node:fs";
import { CATALOG, imageBytes, readUpdater, sha256, xorWords } from "../core/firmware";
import { TAB60_KEYS } from "../core/keymap";
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
/** Matrix cells that hold a usage but are not caps on the ANSI board (see TAB60_KEYS), with their ROM bytes. */
const NOT_CAPS: readonly [cell: number, usage: number, what: string][] = [
	[53, 0x32, "ISO #"],
	[57, 0x35, "Grave"],
	[71, 0x64, "ISO \\"],
	[79, 0xc9, "second Space position"],
];

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
	for (const [cell, want, what] of NOT_CAPS) {
		const byte = rom[cell];
		check(byte === want, `cell ${cell} (${what}, not a cap): ROM ${byte === undefined ? "none" : hex(byte)}, expected ${hex(want)}`);
	}
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
