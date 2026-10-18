/**
 * What a TAB 60 firmware image is, how it travels on the wire, which images are official, and which ones
 * this tool may write.
 *
 * Policy (user ruling, "vendor images only"): an image is flashable only when its SHA-256 is pinned in CATALOG.
 * A well-formed vendor-format exe with an unpinned image is refused too. The exe is unsigned, so its format proves
 * nothing about who made it. A new vendor release becomes flashable through a reviewed catalog entry built by
 * tools/catalog-entry.ts.
 *
 * Open firmware seam: `Provenance` has a "foreign" variant and `admit` refuses it with the unmet prerequisites.
 * Nothing in v1 produces a foreign candidate, and no setting flips the refusal.
 *
 * The catalog holds hashes and checksums only. The tool never ships vendor bytes, and UI code never reads them:
 * a FlashableImage is a handle whose bytes sit in module-private state (candidate A).
 */
import { EXPECTED_LAYOUT } from "./device";
import { type UpdaterRefusal, parseMaav102 } from "./updater";
import {
	type Crc32,
	type Sha256,
	type Sum32,
	crc32Literal,
	sha256Literal,
	sum32Literal,
} from "./units";

/** The CYKB firmware key (pok3rtool cykb.py:71). Word i of an image is XORed with KEY[i % 13]. */
export const CYKB_XOR_KEY: readonly number[] = [
	0xe7c29474, 0x79084b10, 0x53d54b0d, 0xfc1e8f32, 0x48e81a9b, 0x773c808e, 0xb7483552, 0xd9cb8c76, 0x2a8c8bc6,
	0x0967ada8, 0xd4520f5c, 0xd0c3279d, 0xeac091c5,
];

/** An image in the form the IAP receives and checksums: little-endian words XORed with the key. */
export interface WireImage {
	readonly bytes: Uint8Array;
	readonly sum32: Sum32;
	readonly crc32: Crc32;
}

/** The 180-byte version block, verbatim from the package. Never synthesized: both pok3rtool builds write a different block (R1). */
export interface VersionBlock {
	readonly bytes: Uint8Array;
	readonly sha256: Sha256;
	/** UTF-16LE string at offset 4, for display. */
	readonly version: string;
}

/** One official image, identified by facts about it. Built by tools/catalog-entry.ts and reviewed. */
export interface CatalogEntry {
	readonly id: string;
	readonly version: string;
	readonly layoutName: string;
	readonly source: { readonly url: string; readonly exeSha256: Sha256; readonly exeBytes: number };
	readonly image: {
		readonly bytes: number;
		readonly sha256: Sha256;
		readonly wireSum32: Sum32;
		readonly wireCrc32: Crc32;
	};
	readonly versionBlock: { readonly sha256: Sha256 };
	/** An independent confirmation of image.sha256, so the entry does not rest on our extractor alone. */
	readonly oracle: string;
}

export const CATALOG: readonly CatalogEntry[] = [
	{
		id: "tab60-v1.01.13-us",
		version: "V1.01.13",
		layoutName: "US Layout",
		source: {
			url: "https://cdn.shopify.com/s/files/1/0575/2278/2371/files/Tab60firmwareV1.01.13.exe?v=1646286433",
			exeSha256: sha256Literal("fc7ee18829eaccb2c3d56d76af0e24f739d7bbf8640221790fb9d39d716849dd"),
			exeBytes: 3_017_652,
		},
		image: {
			bytes: 34_268,
			sha256: sha256Literal("b77f3fe9d3dfe86e9326633d5edf6f4c1c092c9efa0550d60832a8f4d93d5f3d"),
			wireSum32: sum32Literal(0xf3d3dbd2),
			wireCrc32: crc32Literal(0xf1acb333),
		},
		versionBlock: { sha256: sha256Literal("ca529cf626ef0b18877dcced28a91cad6f58d085473bcc2330b6df845439d345") },
		oracle: "pok3rtool test_extract.sh:78 @ 7da3d51; pok3r_re_firmware disassemble/tab60/v1113/tab60_v1113.bin",
	},
];

declare const flashableBrand: unique symbol;

/**
 * A handle to an image this tool may write. Only `admit` builds one, and only for a catalog entry.
 * It carries the entry (hashes, version, layout name: public facts) and no bytes. The bytes sit in a module-private
 * WeakMap that only `imageBytes` reads, and neither package entry exports `imageBytes`, so UI code can hold, show,
 * and pass an image but cannot read, save, or upload its bytes. The page's CSP (`connect-src 'none'`) backs this:
 * even a bug cannot send anything off the machine.
 */
export interface FlashableImage {
	readonly [flashableBrand]: true;
	readonly entry: CatalogEntry;
}

/** What protocol.ts writes for a handle. */
export interface ImageBytes {
	readonly wire: WireImage;
	readonly versionBlock: VersionBlock;
}

/** Filled only by `admit`. A WeakMap, so a dropped handle frees its bytes. */
const BYTES = new WeakMap<FlashableImage, ImageBytes>();

/** For protocol.ts's writeImage and writeVersionBlock. A handle `admit` did not build fails loudly here, before any write. */
export function imageBytes(image: FlashableImage): ImageBytes {
	const bytes = BYTES.get(image);
	if (bytes === undefined) throw new Error(`no bytes for ${image.entry.id}: this handle was not built by admit()`);
	return bytes;
}

/** Where a candidate image came from. "foreign" is the open-firmware seam. */
export type Provenance = { readonly kind: "vendor-package"; readonly exeSha256: Sha256 } | { readonly kind: "foreign" };

export interface ImageCandidate {
	readonly provenance: Provenance;
	readonly layoutName: string;
	readonly plainSha256: Sha256;
	/** From the vector table and the Keil reset stub, as R2 computes it. null when no single base fits. */
	readonly impliedBase: number | null;
	readonly wire: WireImage;
	/** Foreign images carry none. */
	readonly versionBlock: VersionBlock | null;
}

/**
 * What open firmware needs before a non-vendor image may be written. `met` is the literal type `false`:
 * marking one met is a type change that review will see, not a data edit.
 */
export interface OpenFirmwarePrerequisite {
	readonly id: "swd-probe-and-recovery-drill" | "iap-bootloader-backup" | "mcu-identified-and-unlocked" | "qmk-target";
	readonly met: false;
	readonly why: string;
}

export const OPEN_FIRMWARE_PREREQUISITES: readonly OpenFirmwarePrerequisite[] = [
	{
		id: "swd-probe-and-recovery-drill",
		met: false,
		why: "A non-vendor image that hard-faults at boot cannot be replaced over USB (qmk_pok3r README).",
	},
	{
		id: "iap-bootloader-backup",
		met: false,
		why: "Unlocking needs a mass erase, which also erases the CYKB bootloader; no TAB 60 bootloader dump exists.",
	},
	{
		id: "mcu-identified-and-unlocked",
		met: false,
		why: "The MCU marking (likely HT32F52352) and its flash-security state are unknown with the case closed.",
	},
	{ id: "qmk-target", met: false, why: "No QMK or Vial target exists for the HT32F52352 TAB boards." },
];

export type AdmissionRefusal =
	| { readonly code: "not-in-catalog"; readonly plainSha256: Sha256 }
	| { readonly code: "foreign-image"; readonly missing: readonly OpenFirmwarePrerequisite[] }
	| { readonly code: "wrong-base"; readonly implied: number | null; readonly expected: number }
	| { readonly code: "no-version-block" };

export type Admission =
	| { readonly kind: "admitted"; readonly image: FlashableImage }
	| { readonly kind: "refused"; readonly refusal: AdmissionRefusal };

/**
 * The single flashability decision. `catalog` is CATALOG for every shipped caller; a test passes its own to admit a
 * synthetic image, because CI holds no vendor bytes.
 *
 * The bytes are checked against the entry's length, sum, and CRC-32 here, so the handle never rests on the
 * candidate's claimed hash alone, and they are copied, so a caller cannot change them after admission.
 */
export function admit(candidate: ImageCandidate, catalog: readonly CatalogEntry[] = CATALOG): Admission {
	const refused = (refusal: AdmissionRefusal): Admission => ({ kind: "refused", refusal });
	if (candidate.provenance.kind === "foreign") return refused({ code: "foreign-image", missing: OPEN_FIRMWARE_PREREQUISITES });
	const expected = EXPECTED_LAYOUT.protocolBase + EXPECTED_LAYOUT.fwOffset;
	if (candidate.impliedBase !== expected) return refused({ code: "wrong-base", implied: candidate.impliedBase, expected });
	const { wire, versionBlock } = candidate;
	if (versionBlock === null) return refused({ code: "no-version-block" });
	const entry = catalog.find(
		(e) =>
			e.image.sha256 === candidate.plainSha256 &&
			e.versionBlock.sha256 === versionBlock.sha256 &&
			e.image.bytes === wire.bytes.length &&
			e.image.wireSum32 === sum32(wire.bytes) &&
			e.image.wireCrc32 === crc32(wire.bytes),
	);
	if (entry === undefined) return refused({ code: "not-in-catalog", plainSha256: candidate.plainSha256 });
	const image = { entry } as FlashableImage;
	BYTES.set(image, {
		wire: { ...wire, bytes: Uint8Array.from(wire.bytes) },
		versionBlock: { ...versionBlock, bytes: Uint8Array.from(versionBlock.bytes) },
	});
	return { kind: "admitted", image };
}

export type UpdaterReading =
	| { readonly kind: "refused"; readonly refusal: UpdaterRefusal }
	| {
			readonly kind: "read";
			readonly exe: { readonly sha256: Sha256; readonly bytes: number };
			readonly title: string;
			readonly version: string;
			readonly images: readonly {
				readonly slot: number;
				readonly layoutName: string;
				readonly plainSha256: Sha256;
				readonly bytes: number;
				readonly admission: Admission;
			}[];
	  };

/** The public entry for the user's exe: parse, hash, and admit each image. Runs in the page; nothing is uploaded. */
export async function readUpdater(exe: Uint8Array): Promise<UpdaterReading> {
	const contents = parseMaav102(exe);
	if ("code" in contents) return { kind: "refused", refusal: contents };
	const exeSha256 = await sha256(exe);
	const images = await Promise.all(
		contents.images.map(async (packaged) => {
			const plainSha256 = await sha256(xorWords(packaged.wire));
			const block = packaged.versionBlock;
			const stringBytes = new DataView(block.buffer, block.byteOffset, block.byteLength).getUint32(0, true);
			const admission = admit({
				provenance: { kind: "vendor-package", exeSha256 },
				layoutName: packaged.layoutName,
				plainSha256,
				impliedBase: packaged.impliedBase,
				wire: { bytes: packaged.wire, sum32: sum32(packaged.wire), crc32: crc32(packaged.wire) },
				versionBlock: {
					bytes: block,
					sha256: await sha256(block),
					version: new TextDecoder("utf-16le").decode(block.subarray(4, 4 + stringBytes)).split("\0", 1)[0] ?? "",
				},
			});
			return { slot: packaged.slot, layoutName: packaged.layoutName, plainSha256, bytes: packaged.wire.length, admission };
		}),
	);
	return { kind: "read", exe: { sha256: exeSha256, bytes: exe.length }, title: contents.title, version: contents.version, images };
}

function words(bytes: Uint8Array): DataView {
	if (bytes.length % 4 !== 0) throw new RangeError(`${bytes.length} bytes is not a whole number of 32-bit words`);
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** XOR with CYKB_XOR_KEY. Its own inverse: plain to wire and wire to plain. */
export function xorWords(bytes: Uint8Array): Uint8Array {
	const from = words(bytes);
	const out = new Uint8Array(bytes.length);
	const to = new DataView(out.buffer);
	for (let at = 0; at < bytes.length; at += 4) {
		to.setUint32(at, from.getUint32(at, true) ^ (CYKB_XOR_KEY[(at / 4) % CYKB_XOR_KEY.length] ?? 0), true);
	}
	return out;
}

/** Wrapping sum of little-endian u32 words: the vendor updater's check (routine 0x402B00). */
export function sum32(wire: Uint8Array): Sum32 {
	const view = words(wire);
	let sum = 0;
	for (let at = 0; at < wire.length; at += 4) sum = (sum + view.getUint32(at, true)) >>> 0;
	return sum32Literal(sum);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
	return c;
});

/** zlib CRC-32: pok3rtool's second check. */
export function crc32(wire: Uint8Array): Crc32 {
	let c = 0xffff_ffff;
	for (const byte of wire) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	return crc32Literal((c ^ 0xffff_ffff) >>> 0);
}

export async function sha256(bytes: Uint8Array): Promise<Sha256> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	return sha256Literal(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
}
