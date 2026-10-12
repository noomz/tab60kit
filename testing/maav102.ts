/**
 * Builds maav102 updater packages for tests. CI holds no vendor bytes, so its packages come from here.
 * `scramble` is written from R2's description, not from core/updater.ts's `unscramble`, so the two check each other.
 */
import { EXPECTED_LAYOUT } from "../core/device";
import { xorWords } from "../core/firmware";

export const TRAILER_BYTES = 0xb24;
export const LAYOUT_TABLE_AT = 0x848;
const VERSION_AT = 0x63e;
const SECTION_AT = 0x200;
const SECTION_BYTES = 0x400;

/** The inverse of `unscramble`: the form a section has inside the exe. */
export function scramble(section: Uint8Array): Uint8Array {
	const b = section.map((y) => ((y & 0x0f) << 4) | (((y >> 4) + 7) & 0x0f));
	const swap = (i: number, j: number) => {
		const held = b[i] ?? 0;
		b[i] = b[j] ?? 0;
		b[j] = held;
	};
	for (let i = 1; i < b.length; i += 2) swap(i - 1, i);
	for (let i = 4; i < b.length - 1; i += 5) swap(i - 4, i);
	return b;
}

export const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

export function utf16le(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < text.length; i++) view.setUint16(2 * i, text.charCodeAt(i), true);
	return bytes;
}

export interface PackageSpec {
	readonly title: string;
	readonly product: string;
	readonly version: string;
	readonly identityHex: string;
	readonly bootPid: number;
	readonly appPid: number;
	readonly writeBlockSize: number;
	readonly layoutName: string;
	readonly layoutId: number;
	/** The image before the XOR. */
	readonly plain: Uint8Array;
	/** The version block as the package stores it, before the updater's patch. */
	readonly versionBlock: Uint8Array;
}

/**
 * An image the extractor accepts with base 0x3200: a stack pointer in SRAM, a Thumb reset vector, and one Keil
 * reset stub at 0x40, where the reset vector points.
 */
export function syntheticImage(bytes = 1024): Uint8Array {
	const base = EXPECTED_LAYOUT.protocolBase + EXPECTED_LAYOUT.fwOffset;
	const image = Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + 7) & 0xff);
	const view = new DataView(image.buffer);
	image.fill(0, 0, 0x48);
	view.setUint32(0, 0x2000_1000, true);
	view.setUint32(4, (base + 0x40) | 1, true);
	view.setUint32(8, (base + 0x50) | 1, true);
	image.set([0x06, 0x48, 0x80, 0x47, 0x06, 0x48, 0x00, 0x47], 0x40);
	return image;
}

/** 180 bytes with the 0x5AA5 magic. The length word and the string are stale, as the updater patches both. */
export function syntheticVersionBlock(): Uint8Array {
	const block = Uint8Array.from({ length: EXPECTED_LAYOUT.versionBlockBytes }, (_, i) => (i * 13 + 1) & 0xff);
	new DataView(block.buffer).setUint32(0xb0, 0x001c_5aa5, true);
	return block;
}

export const SYNTHETIC: PackageSpec = {
	title: "Synthetic updater",
	product: "304",
	version: "V9.99.99",
	identityHex: EXPECTED_LAYOUT.identityHex,
	bootPid: 0x1304,
	appPid: 0x0304,
	writeBlockSize: EXPECTED_LAYOUT.writeChunkBytes,
	layoutName: "US Layout",
	layoutId: 0x0001,
	plain: syntheticImage(),
	versionBlock: syntheticVersionBlock(),
};

/** The version block after the updater's patch: length 0x1A, then 26 bytes of the trailer's version field. */
export function patchedVersionBlock(spec: PackageSpec): Uint8Array {
	const block = Uint8Array.from(spec.versionBlock);
	block.fill(0, 0, 4 + 0x1a);
	block[0] = 0x1a;
	block.set(utf16le(spec.version).subarray(0, 0x1a), 4);
	return block;
}

/** A minimal unsigned PE32 with one section, then the package in its overlay: firmware, version block, trailer. */
export function buildUpdater(spec: PackageSpec): Uint8Array {
	const trailer = new Uint8Array(TRAILER_BYTES);
	const t = new DataView(trailer.buffer);
	trailer.set(fromHex(spec.identityHex), 0);
	t.setUint32(0x14, 0x04d9, true);
	t.setUint32(0x18, spec.bootPid, true);
	t.setUint32(0x1c, 0x04d9, true);
	t.setUint32(0x20, spec.appPid, true);
	trailer[0x24] = spec.writeBlockSize;
	trailer.set(utf16le(spec.title), 0x026);
	trailer.set(utf16le(spec.product), 0x436);
	trailer.set(utf16le(spec.version), VERSION_AT);
	t.setUint32(LAYOUT_TABLE_AT, spec.plain.length, true);
	t.setUint32(LAYOUT_TABLE_AT + 4, spec.versionBlock.length, true);
	trailer.set(utf16le(spec.layoutName), LAYOUT_TABLE_AT + 8);
	t.setUint16(LAYOUT_TABLE_AT + 0x44, spec.layoutId, true);
	trailer.set(new TextEncoder().encode(".maaV102"), 0xb19);

	const header = new Uint8Array(SECTION_AT + SECTION_BYTES);
	const h = new DataView(header.buffer);
	const pe = 0x40;
	const optional = pe + 24;
	header.set([0x4d, 0x5a], 0);
	h.setUint32(0x3c, pe, true);
	header.set([0x50, 0x45, 0, 0], pe);
	h.setUint16(pe + 6, 1, true);
	h.setUint16(pe + 20, 0xe0, true);
	h.setUint16(optional, 0x10b, true);
	h.setUint32(optional + 92, 16, true);
	h.setUint32(optional + 0xe0 + 16, SECTION_BYTES, true);
	h.setUint32(optional + 0xe0 + 20, SECTION_AT, true);

	const parts = [header, scramble(xorWords(spec.plain)), scramble(spec.versionBlock), scramble(trailer)];
	const exe = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		exe.set(part, at);
		at += part.length;
	}
	return exe;
}
