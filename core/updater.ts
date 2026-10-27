/**
 * The maav102 container inside the vendor updater exe. A pure port of tools/oracle/decode_updater.py (format: docs/updater-package.md).
 * The Python script stays the oracle: `bun run real-exe` runs both on the real exe and compares bytes.
 *
 * Reads bytes only. The exe is never executed (gate G2) and never leaves the user's machine.
 */
import { EXPECTED_LAYOUT } from "./device";
import { xorWords } from "./firmware";

/** Each reason the extractor refuses with (docs/updater-package.md "Refusals"), so the UI can explain it. */
export type UpdaterRefusal =
	| { readonly code: "not-pe"; readonly detail: string }
	| { readonly code: "not-pe32"; readonly magic: number }
	| { readonly code: "signed-exe" }
	| { readonly code: "overlay-too-small"; readonly bytes: number }
	| { readonly code: "no-maav102-signature" }
	| { readonly code: "bad-string-field" }
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
	/** From the vector table and the Keil reset stub of the plain image. null when no single base fits. */
	readonly impliedBase: number | null;
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

const TRAILER_BYTES = 0xb24;
const SIGNATURE_AT = 0xb19;
const SIGNATURE = ".maaV102\0\0";
const STRING_FIELD_BYTES = 0x208;
const TITLE_AT = 0x026;
const COMPANY_AT = 0x22e;
const PRODUCT_AT = 0x436;
const VERSION_AT = 0x63e;
const LAYOUT_TABLE_AT = 0x848;
const LAYOUT_SLOTS = 9;
const LAYOUT_RECORD_BYTES = 0x50;
const VERSION_MAGIC_AT = 0xb0;
const VERSION_MAGIC = 0x5aa5;
const VERSION_PATCH_BYTES = 0x1a;
const SRAM_START = 0x2000_0000;
const SRAM_END = 0x2001_0000;
const VECTOR_TABLE_MIN = 0x40;

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Removes the updater's scramble from one section. Positions restart at 0 in each section.
 * The 5-byte swap stops one group early when the length is a multiple of 5. pok3rtool does not stop early, so it
 * corrupts two bytes of such a section, the 180-byte version block among them.
 */
export function unscramble(section: Uint8Array): Uint8Array {
	const b = Uint8Array.from(section);
	const swap = (i: number, j: number) => {
		const held = b[i] ?? 0;
		b[i] = b[j] ?? 0;
		b[j] = held;
	};
	for (let i = 4; i < b.length - 1; i += 5) swap(i - 4, i);
	for (let i = 1; i < b.length; i += 2) swap(i - 1, i);
	return b.map((x) => (((x - 7) << 4) & 0xff) | (x >> 4));
}

/** The end of the last PE section, where the package starts. */
function overlayStart(exe: Uint8Array): number | UpdaterRefusal {
	const view = viewOf(exe);
	try {
		if (exe[0] !== 0x4d || exe[1] !== 0x5a) return { code: "not-pe", detail: "no MZ header" };
		const pe = view.getUint32(0x3c, true);
		if (view.getUint32(pe, true) !== 0x0000_4550) return { code: "not-pe", detail: "no PE signature" };
		const sections = view.getUint16(pe + 6, true);
		const optionalBytes = view.getUint16(pe + 20, true);
		const optional = pe + 24;
		const magic = view.getUint16(optional, true);
		if (magic !== 0x10b) return { code: "not-pe32", magic };
		const directories = view.getUint32(optional + 92, true);
		// Directory 4 is the certificate table. Known updaters are unsigned, and a certificate would sit in the overlay.
		if (directories > 4 && view.getUint32(optional + 96 + 4 * 8 + 4, true) !== 0) return { code: "signed-exe" };
		const table = optional + optionalBytes;
		let end = 0;
		for (let i = 0; i < sections; i++) {
			const at = table + 40 * i;
			end = Math.max(end, view.getUint32(at + 16, true) + view.getUint32(at + 20, true));
		}
		if (sections === 0 || end > exe.length) return { code: "not-pe", detail: "section table points past the end of the file" };
		return end;
	} catch (error) {
		if (error instanceof RangeError) return { code: "not-pe", detail: "truncated or malformed PE headers" };
		throw error;
	}
}

/** Throws a TypeError on bytes that are not UTF-16LE, as the oracle's decode does. */
function utf16z(field: Uint8Array): string {
	const text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(field);
	return text.split("\0", 1)[0] ?? "";
}

function impliedBaseOf(plain: Uint8Array): number | null | { readonly why: "sp-outside-sram" | "reset-not-thumb" } {
	const view = viewOf(plain);
	const sp = view.getUint32(0, true);
	const reset = view.getUint32(4, true);
	if (!(SRAM_START < sp && sp <= SRAM_END && sp % 4 === 0)) return { why: "sp-outside-sram" };
	if ((reset & 1) === 0) return { why: "reset-not-thumb" };
	const handlers = Array.from({ length: 15 }, (_, i) => view.getUint32(4 + 4 * i, true))
		.filter((vector) => vector !== 0 && vector !== 0xffff_ffff)
		.map((vector) => (vector & ~1) >>> 0);
	// Keil's reset stub: ldr r0,=SystemInit; blx r0; ldr r0,=__main; bx r0. The reset vector points at it.
	const stubs: number[] = [];
	for (let at = 0; at + 8 <= plain.length; ) {
		const isStub =
			plain[at + 1] === 0x48 &&
			plain[at + 2] === 0x80 &&
			plain[at + 3] === 0x47 &&
			plain[at + 5] === 0x48 &&
			plain[at + 6] === 0x00 &&
			plain[at + 7] === 0x47;
		if (isStub && at % 2 === 0) stubs.push(at);
		at += isStub ? 8 : 1;
	}
	const bases = stubs
		.map((at) => ((reset & ~1) >>> 0) - at)
		.filter((base) => base >= 0 && base % 0x100 === 0 && handlers.every((h) => base <= h && h < base + plain.length));
	const [base] = bases;
	return bases.length === 1 && base !== undefined ? base : null;
}

/**
 * Parses the overlay of a PE32 updater. Pure and synchronous. It refuses in the oracle's order, and then an
 * updater for another board.
 */
export function parseMaav102(exe: Uint8Array): UpdaterContents | UpdaterRefusal {
	const overlay = overlayStart(exe);
	if (typeof overlay !== "number") return overlay;
	if (exe.length - overlay < TRAILER_BYTES) return { code: "overlay-too-small", bytes: exe.length - overlay };

	const trailerAt = exe.length - TRAILER_BYTES;
	const trailer = unscramble(exe.subarray(trailerAt));
	const view = viewOf(trailer);
	for (let i = 0; i < SIGNATURE.length; i++) {
		if (trailer[SIGNATURE_AT + i] !== SIGNATURE.charCodeAt(i)) return { code: "no-maav102-signature" };
	}
	const slots: { readonly slot: number; readonly name: string; readonly firmwareBytes: number; readonly versionBytes: number }[] = [];
	let title: string;
	let product: string;
	let version: string;
	try {
		const field = (at: number) => utf16z(trailer.subarray(at, at + STRING_FIELD_BYTES));
		title = field(TITLE_AT);
		field(COMPANY_AT);
		product = field(PRODUCT_AT);
		version = field(VERSION_AT);
		for (let slot = 0; slot < LAYOUT_SLOTS; slot++) {
			const at = LAYOUT_TABLE_AT + slot * LAYOUT_RECORD_BYTES;
			slots.push({
				slot,
				name: utf16z(trailer.subarray(at + 8, at + 0x44)),
				firmwareBytes: view.getUint32(at, true),
				versionBytes: view.getUint32(at + 4, true),
			});
		}
	} catch (error) {
		if (error instanceof TypeError) return { code: "bad-string-field" };
		throw error;
	}
	if (slots.every((slot) => slot.firmwareBytes === 0)) return { code: "no-firmware" };

	// The updater walks back from the trailer: slot 8 first, and in each slot the version block, then the firmware.
	const spans = new Map<number, { readonly firmwareAt: number; readonly versionAt: number }>();
	let at = trailerAt;
	for (const slot of [...slots].reverse()) {
		at -= slot.versionBytes;
		const versionAt = at;
		at -= slot.firmwareBytes;
		spans.set(slot.slot, { firmwareAt: at, versionAt });
	}
	if (at !== overlay) return { code: "sections-do-not-tile", packageStart: at, overlayStart: overlay };

	const identityHex = Array.from(trailer.subarray(0, 0x10), (b) => b.toString(16).padStart(2, "0")).join("");
	if (identityHex !== EXPECTED_LAYOUT.identityHex) return { code: "different-board", identityHex };

	const images: PackagedImage[] = [];
	for (const { slot, name, firmwareBytes, versionBytes } of slots) {
		const span = spans.get(slot);
		if (firmwareBytes === 0 || span === undefined) continue;
		if (firmwareBytes % 4 !== 0 || firmwareBytes < VECTOR_TABLE_MIN) return { code: "bad-firmware-size", slot, bytes: firmwareBytes };
		if (versionBytes !== EXPECTED_LAYOUT.versionBlockBytes) return { code: "bad-version-block", slot, why: "size" };
		const wire = unscramble(exe.subarray(span.firmwareAt, span.firmwareAt + firmwareBytes));
		const impliedBase = impliedBaseOf(xorWords(wire));
		if (impliedBase !== null && typeof impliedBase !== "number") return { code: "no-vector-table", slot, why: impliedBase.why };
		const versionBlock = unscramble(exe.subarray(span.versionAt, span.versionAt + versionBytes));
		const block = viewOf(versionBlock);
		if (block.getUint16(VERSION_MAGIC_AT, true) !== VERSION_MAGIC) return { code: "bad-version-block", slot, why: "magic" };
		// The updater overwrites the length word and the first 26 string bytes before it writes the block.
		block.setUint32(0, VERSION_PATCH_BYTES, true);
		versionBlock.set(trailer.subarray(VERSION_AT, VERSION_AT + VERSION_PATCH_BYTES), 4);
		images.push({
			slot,
			layoutName: name,
			layoutId: view.getUint16(LAYOUT_TABLE_AT + slot * LAYOUT_RECORD_BYTES + 0x44, true),
			wire,
			versionBlock,
			impliedBase,
		});
	}
	return {
		title,
		product,
		version,
		identityHex,
		bootPid: view.getUint32(0x18, true),
		appPid: view.getUint32(0x20, true),
		writeBlockSize: trailer[0x24] ?? 0,
		images,
	};
}
