/**
 * Plan U9's check on the vendor's own exe: every TAB60_KEYS `defaultUsage` against the ROM keymap at flash 0xB205.
 * Plan U10's: the clean-store prediction from the table against one computed from the ROM bytes alone, frame by frame,
 * in the reply format of predict.py.
 * The exe goes through core's own extractor (`readUpdater`, U3), which holds the image in wire form; `xorWords` gives
 * the plain image, the bytes R2's decoder writes. The exe is never committed, so this runs locally, not in `check`.
 *
 * Run: TAB60_EXE=<Tab60firmwareV1.01.13.exe> bun run real-image
 */
import { readFileSync } from "node:fs";
import { CATALOG, imageBytes, readUpdater, sha256, xorWords } from "../core/firmware";
import { NON_CAP_CELLS, TAB60_KEYS, activeKeymap, predictCleanLayer, romKeymap } from "../core/keymap";
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
/** sub_5F4C's Fn and Pn markers and their default cells, written out here so the ROM-side prediction owes nothing to keymap.ts. */
const ROM_MARKERS: readonly [cell: number, usage: number][] = [
	[0x3c, 0xd8],
	[0x36, 0xd9],
];
const ABSENT = 0x0003;
const DEFAULT = 0x00ff;
const wordOf = (entry: OverrideEntry | undefined) => (entry?.kind === "default" ? DEFAULT : entry?.kind === "absent" ? ABSENT : -1);
const replyHex = (a: number, words: readonly number[]) =>
	`52 21 ${a.toString(16).padStart(2, "0")} 00 ${words.flatMap((w) => [w & 0xff, w >>> 8]).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`;

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

	const fromRom = Array.from(rom);
	for (const [cell, marker] of ROM_MARKERS) fromRom[cell] = marker;
	const present = new Set(fromRom);
	const predicted = predictCleanLayer(activeKeymap());
	for (let a = 0; a < 16; a++) {
		const usages = Array.from({ length: 16 }, (_, i) => 16 * a + i);
		const want = usages.map((k) => (present.has(k) ? DEFAULT : ABSENT));
		const got = usages.map((k) => wordOf(predicted.get(k)));
		check(got.every((w, i) => w === want[i]), `clean layer 0, frame ${a}: ${replyHex(a, got)}${got.every((w, i) => w === want[i]) ? "" : `; ROM says ${replyHex(a, want)}`}`);
	}
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
