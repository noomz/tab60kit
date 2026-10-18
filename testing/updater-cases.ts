/**
 * The twelve mutated updaters of tools/oracle/test_decode_updater.py, each with the refusal the extractor owes it.
 * They are built from any one-image package, so CI runs them on the synthetic package and testing/real-exe.ts runs
 * them on the vendor's exe.
 */
import { xorWords } from "../core/firmware";
import { type UpdaterRefusal, unscramble } from "../core/updater";
import { LAYOUT_TABLE_AT, TRAILER_BYTES, scramble } from "./maav102";

export interface RefusalCase {
	readonly label: string;
	readonly exe: Uint8Array;
	readonly refusal: Partial<UpdaterRefusal>;
}

type Mutate = (bytes: Uint8Array, view: DataView) => void;

/** Where the one image and its version block sit in `exe`, read from its trailer. */
export function sectionsOf(exe: Uint8Array) {
	const trailerAt = exe.length - TRAILER_BYTES;
	const trailer = new DataView(unscramble(exe.subarray(trailerAt)).buffer);
	const firmwareBytes = trailer.getUint32(LAYOUT_TABLE_AT, true);
	const versionBytes = trailer.getUint32(LAYOUT_TABLE_AT + 4, true);
	const versionAt = trailerAt - versionBytes;
	return { trailerAt, firmwareAt: versionAt - firmwareBytes, firmwareBytes, versionAt, versionBytes };
}

function splice(exe: Uint8Array, at: number, section: Uint8Array): Uint8Array {
	const out = Uint8Array.from(exe);
	out.set(section, at);
	return out;
}

function withSection(exe: Uint8Array, at: number, bytes: number, mutate: Mutate, xor = false): Uint8Array {
	const decoded = unscramble(exe.subarray(at, at + bytes));
	const open = xor ? xorWords(decoded) : decoded;
	mutate(open, new DataView(open.buffer));
	return splice(exe, at, scramble(xor ? xorWords(open) : open));
}

/** The same package with the last byte of its plain image changed: still well formed, no longer the same image. */
export function withImageByteFlipped(exe: Uint8Array): Uint8Array {
	const { firmwareAt, firmwareBytes } = sectionsOf(exe);
	return withSection(exe, firmwareAt, firmwareBytes, (image) => image.set([(image.at(-1) ?? 0) ^ 1], image.length - 1), true);
}

export function withTrailer(exe: Uint8Array, mutate: Mutate): Uint8Array {
	return withSection(exe, exe.length - TRAILER_BYTES, TRAILER_BYTES, mutate);
}

export function refusalCases(exe: Uint8Array): readonly RefusalCase[] {
	const { firmwareAt, firmwareBytes, versionAt, versionBytes } = sectionsOf(exe);
	const withImage = (mutate: Mutate) => withSection(exe, firmwareAt, firmwareBytes, mutate, true);

	const signed = Uint8Array.from(exe);
	const header = new DataView(signed.buffer);
	const certificateDirectory = header.getUint32(0x3c, true) + 24 + 96 + 4 * 8;
	header.setUint32(certificateDirectory, exe.length, true);
	header.setUint32(certificateDirectory + 4, 8, true);

	const appended = new Uint8Array(exe.length + 16);
	appended.set(exe);

	return [
		{ label: "text file", exe: new TextEncoder().encode("hello, not an exe\n".repeat(10)), refusal: { code: "not-pe" } },
		{ label: "PE headers only", exe: exe.subarray(0, 0x400), refusal: { code: "not-pe" } },
		{ label: "16 bytes appended", exe: appended, refusal: { code: "no-maav102-signature" } },
		{ label: "last byte cut", exe: exe.subarray(0, exe.length - 1), refusal: { code: "no-maav102-signature" } },
		{
			label: "signature byte changed",
			exe: withTrailer(exe, (t) => t.set(["x".charCodeAt(0)], 0xb1a)),
			refusal: { code: "no-maav102-signature" },
		},
		{
			label: "firmware size +52",
			exe: withTrailer(exe, (_, t) => t.setUint32(LAYOUT_TABLE_AT, firmwareBytes + 52, true)),
			refusal: { code: "sections-do-not-tile" },
		},
		{
			label: "no layouts",
			exe: withTrailer(exe, (_, t) => {
				t.setUint32(LAYOUT_TABLE_AT, 0, true);
				t.setUint32(LAYOUT_TABLE_AT + 4, 0, true);
			}),
			refusal: { code: "no-firmware" },
		},
		{
			label: "8-byte firmware",
			exe: withTrailer(exe, (_, t) => {
				t.setUint32(LAYOUT_TABLE_AT, 8, true);
				t.setUint32(LAYOUT_TABLE_AT + 4, firmwareBytes + versionBytes - 8, true);
			}),
			refusal: { code: "bad-firmware-size", slot: 0, bytes: 8 },
		},
		{ label: "authenticode dir set", exe: signed, refusal: { code: "signed-exe" } },
		{
			label: "image SP outside SRAM",
			exe: withImage((_, image) => image.setUint32(0, 0x1234_5678, true)),
			refusal: { code: "no-vector-table", slot: 0, why: "sp-outside-sram" },
		},
		{
			label: "image reset vector even",
			exe: withImage((_, image) => image.setUint32(4, 0x32c0, true)),
			refusal: { code: "no-vector-table", slot: 0, why: "reset-not-thumb" },
		},
		{
			label: "version magic broken",
			exe: withSection(exe, versionAt, versionBytes, (block) => block.set([0], 0xb0)),
			refusal: { code: "bad-version-block", slot: 0, why: "magic" },
		},
	];
}
