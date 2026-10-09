/**
 * The maav102 container inside the vendor updater exe. A pure port of tools/oracle/decode_updater.py.
 * The Python script stays the oracle: docs/units.md U3 runs both on the real exe and compares bytes.
 *
 * Reads bytes only. The exe is never executed (gate G2) and never leaves the user's machine.
 */
import { EXPECTED_LAYOUT } from "./device";
import { notImplemented } from "./units";

/** Each reason R2's extractor refuses with, so the UI can explain it. */
export type UpdaterRefusal =
	| { readonly code: "not-pe"; readonly detail: string }
	| { readonly code: "not-pe32"; readonly magic: number }
	| { readonly code: "signed-exe" }
	| { readonly code: "overlay-too-small"; readonly bytes: number }
	| { readonly code: "no-maav102-signature" }
	| { readonly code: "sections-do-not-tile"; readonly packageStart: number; readonly overlayStart: number }
	| { readonly code: "no-firmware" }
	| { readonly code: "bad-firmware-size"; readonly slot: number; readonly bytes: number }
	| { readonly code: "bad-version-block"; readonly slot: number; readonly why: "size" | "magic" }
	| { readonly code: "no-vector-table"; readonly slot: number; readonly why: "sp-outside-sram" | "reset-not-thumb" }
	| { readonly code: "different-board"; readonly identityHex: string };

/** One layout slot that holds firmware. */
export interface PackagedImage {
	/** 0-based. The vendor's `bin:N` is slot + 1. */
	readonly slot: number;
	readonly layoutName: string;
	readonly layoutId: number;
	/** The firmware section after the package scramble is removed: the XORed form the updater sends. */
	readonly wire: Uint8Array;
	/** 180 bytes, after the updater's own version-string patch (a no-op for V1.01.13). */
	readonly versionBlock: Uint8Array;
}

export interface UpdaterContents {
	readonly title: string;
	readonly product: string;
	readonly version: string;
	readonly identityHex: string;
	readonly bootPid: number;
	readonly appPid: number;
	readonly writeBlockSize: number;
	/** Non-empty slots only. V1.01.13 has one: slot 0, "US Layout". */
	readonly images: readonly PackagedImage[];
}

/**
 * Parses the overlay of a PE32 updater. Pure and synchronous.
 * TODO, mirroring decode_updater.py step by step:
 *   overlay = end of the last PE section; refuse signed exes and overlays smaller than 0xB24 bytes
 *   trailer = unscramble(last 0xB24 bytes); require ".maaV102\0\0" at 0xB19
 *   walk slots 8 down to 0 from the trailer start: version block, then firmware; the walk must land on the overlay start
 *   unscramble(section), per section, with positions restarting at 0:
 *     1. for i = 4, 9, 14, ... while i <= n - 2: swap bytes i-4 and i      (pok3rtool's bound is wrong when n % 5 == 0)
 *     2. for i = 1, 3, 5, ... while i <= n - 1: swap bytes i-1 and i
 *     3. each byte x -> ((x - 7) << 4 | x >> 4) & 0xff
 *   refuse unless identityHex === EXPECTED_LAYOUT.identityHex (an updater for another board)
 *   per image: size % 4 == 0 and >= 64; version block 180 bytes with 0x5AA5 at 0xB0; vector table check on the plain image
 *   patch the version block: u32 0x1A at 0, then 26 bytes of the trailer's version string at 4
 */
export function parseMaav102(exe: Uint8Array): UpdaterContents | UpdaterRefusal {
	return notImplemented(`parseMaav102(${exe.length} bytes, expecting identity ${EXPECTED_LAYOUT.identityHex})`);
}
