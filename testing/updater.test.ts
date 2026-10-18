import { expect, test } from "bun:test";
import {
	CATALOG,
	CYKB_XOR_KEY,
	type CatalogEntry,
	type ImageCandidate,
	OPEN_FIRMWARE_PREREQUISITES,
	admit,
	crc32,
	imageBytes,
	readUpdater,
	sha256,
	sum32,
	xorWords,
} from "../core/firmware";
import { type UpdaterContents, parseMaav102, unscramble } from "../core/updater";
import { sha256Literal } from "../core/units";
import { SYNTHETIC, buildUpdater, fromHex, patchedVersionBlock, scramble } from "./maav102";
import { refusalCases, withImageByteFlipped, withTrailer } from "./updater-cases";

const exe = buildUpdater(SYNTHETIC);
const wire = xorWords(SYNTHETIC.plain);
const block = patchedVersionBlock(SYNTHETIC);

/** What readUpdater builds for the one image of a package, so a test can hand it to admit with its own catalog. */
async function candidateOf(updater: Uint8Array): Promise<ImageCandidate> {
	const [image] = (parseMaav102(updater) as UpdaterContents).images;
	if (image === undefined) throw new Error("the package holds no image");
	return {
		provenance: { kind: "vendor-package", exeSha256: await sha256(updater) },
		layoutName: image.layoutName,
		plainSha256: await sha256(xorWords(image.wire)),
		impliedBase: image.impliedBase,
		wire: { bytes: image.wire, sum32: sum32(image.wire), crc32: crc32(image.wire) },
		versionBlock: { bytes: image.versionBlock, sha256: await sha256(image.versionBlock), version: SYNTHETIC.version },
	};
}

async function syntheticCatalog(): Promise<readonly CatalogEntry[]> {
	return [
		{
			id: "synthetic",
			version: SYNTHETIC.version,
			layoutName: SYNTHETIC.layoutName,
			source: { url: "about:blank", exeSha256: await sha256(exe), exeBytes: exe.length },
			image: { bytes: wire.length, sha256: await sha256(SYNTHETIC.plain), wireSum32: sum32(wire), wireCrc32: crc32(wire) },
			versionBlock: { sha256: await sha256(block) },
			oracle: "testing/maav102.ts",
		},
	];
}

test("unscramble matches the oracle's output, with the 5-byte swap stopping early on a multiple of 5", () => {
	const input = (n: number) => Uint8Array.from({ length: n }, (_, i) => 0x10 + i);
	expect(unscramble(input(9))).toEqual(fromHex("a1d1c1b1e19101f111"));
	expect(unscramble(input(10))).toEqual(fromHex("a1d1c1b1e19101f12111"));
	expect(unscramble(input(11))).toEqual(fromHex("a1d1c1b1219101f1e11131"));
});

test("scramble and unscramble invert each other at every length up to 200", () => {
	for (let n = 0; n <= 200; n++) {
		const section = Uint8Array.from({ length: n }, (_, i) => (i * 73 + n) & 0xff);
		expect(unscramble(scramble(section))).toEqual(section);
		expect(scramble(unscramble(section))).toEqual(section);
	}
});

test("xorWords applies the 13-word key to little-endian words and inverts itself", () => {
	const key = new Uint8Array(56);
	const view = new DataView(key.buffer);
	for (let i = 0; i < 14; i++) view.setUint32(4 * i, CYKB_XOR_KEY[i % 13] ?? 0, true);
	expect(xorWords(new Uint8Array(56))).toEqual(key);
	expect(xorWords(wire)).toEqual(SYNTHETIC.plain);
	expect(() => xorWords(new Uint8Array(5))).toThrow(RangeError);
});

test("sum32 wraps at 32 bits and crc32 is zlib's", () => {
	expect(Number(sum32(fromHex("ffffffff02000000")))).toBe(1);
	expect(Number(sum32(fromHex("0100000000000080")))).toBe(0x8000_0001);
	expect(() => sum32(new Uint8Array(6))).toThrow(RangeError);
	expect(Number(crc32(new TextEncoder().encode("123456789")))).toBe(0xcbf4_3926);
	expect(Number(crc32(new Uint8Array(0)))).toBe(0);
});

test("parseMaav102 reads the synthetic package", () => {
	expect(parseMaav102(exe)).toEqual({
		title: SYNTHETIC.title,
		product: SYNTHETIC.product,
		version: SYNTHETIC.version,
		identityHex: SYNTHETIC.identityHex,
		bootPid: SYNTHETIC.bootPid,
		appPid: SYNTHETIC.appPid,
		writeBlockSize: SYNTHETIC.writeBlockSize,
		images: [
			{
				slot: 0,
				layoutName: SYNTHETIC.layoutName,
				layoutId: SYNTHETIC.layoutId,
				wire,
				versionBlock: block,
				impliedBase: 0x3200,
			},
		],
	});
});

test("parseMaav102 reports no base when the image holds no reset stub or two", () => {
	const base = (plain: Uint8Array) => (parseMaav102(buildUpdater({ ...SYNTHETIC, plain })) as UpdaterContents).images[0]?.impliedBase;
	const none = Uint8Array.from(SYNTHETIC.plain);
	none.fill(0, 0x40, 0x48);
	expect(base(none)).toBeNull();
	const two = Uint8Array.from(SYNTHETIC.plain);
	two.copyWithin(0x140, 0x40, 0x48);
	// A reset vector at 0x3340 fits base 0x3300 by the first stub and base 0x3200 by the second.
	new DataView(two.buffer).setUint32(4, 0x3341, true);
	new DataView(two.buffer).setUint32(8, 0, true);
	expect(base(SYNTHETIC.plain)).toBe(0x3200);
	expect(base(two)).toBeNull();
});

for (const { label, exe: mutated, refusal } of refusalCases(exe)) {
	test(`parseMaav102 refuses: ${label}`, () => {
		expect(parseMaav102(mutated)).toMatchObject(refusal);
	});
}

test("parseMaav102 refuses an updater for another board", () => {
	const identityHex = "00000000d904041240700404ffffffff";
	expect(parseMaav102(buildUpdater({ ...SYNTHETIC, identityHex }))).toEqual({ code: "different-board", identityHex });
});

test("parseMaav102 refuses a string field that is not UTF-16LE", () => {
	const loneSurrogate = withTrailer(exe, (trailer) => trailer.set([0x00, 0xd8, 0x41, 0x00], 0x026));
	expect(parseMaav102(loneSurrogate)).toEqual({ code: "bad-string-field" });
});

test("parseMaav102 refuses an overlay smaller than the trailer", () => {
	expect(parseMaav102(exe.subarray(0, 0x600 + 100))).toEqual({ code: "overlay-too-small", bytes: 100 });
});

test("readUpdater reads a well-formed package and refuses its image, which no catalog entry pins", async () => {
	const plainSha256 = await sha256(SYNTHETIC.plain);
	expect(await readUpdater(exe)).toEqual({
		kind: "read",
		exe: { sha256: await sha256(exe), bytes: exe.length },
		title: SYNTHETIC.title,
		version: SYNTHETIC.version,
		images: [
			{
				slot: 0,
				layoutName: SYNTHETIC.layoutName,
				plainSha256,
				bytes: wire.length,
				admission: { kind: "refused", refusal: { code: "not-in-catalog", plainSha256 } },
			},
		],
	});
	expect(await readUpdater(new Uint8Array(4))).toEqual({ kind: "refused", refusal: { code: "not-pe", detail: "no MZ header" } });
});

test("admit admits a pinned image, and imageBytes returns its own copy of the bytes", async () => {
	const catalog = await syntheticCatalog();
	const candidate = await candidateOf(exe);
	const admission = admit(candidate, catalog);
	if (admission.kind !== "admitted") throw new Error(`refused: ${admission.refusal.code}`);
	expect(admission.image.entry).toBe(catalog[0]!);
	candidate.wire.bytes.fill(0);
	candidate.versionBlock?.bytes.fill(0);
	const held = imageBytes(admission.image);
	expect(held.wire.bytes).toEqual(wire);
	expect(Number(held.wire.sum32)).toBe(Number(sum32(wire)));
	expect(held.versionBlock.bytes).toEqual(block);
	expect(held.versionBlock.version).toBe(SYNTHETIC.version);
});

test("admit refuses the same image with one byte flipped, by hash and by the bytes themselves", async () => {
	const catalog = await syntheticCatalog();
	const flipped = await candidateOf(withImageByteFlipped(exe));
	expect(admit(flipped, catalog)).toEqual({ kind: "refused", refusal: { code: "not-in-catalog", plainSha256: flipped.plainSha256 } });
	const lying = { ...flipped, plainSha256: await sha256(SYNTHETIC.plain) };
	expect(admit(lying, catalog)).toMatchObject({ kind: "refused", refusal: { code: "not-in-catalog" } });
	const otherBlock = await candidateOf(buildUpdater({ ...SYNTHETIC, version: "V9.99.98" }));
	expect(admit(otherBlock, catalog)).toMatchObject({ kind: "refused", refusal: { code: "not-in-catalog" } });
});

test("admit refuses a foreign image, a wrong base, and a missing version block", async () => {
	const catalog = await syntheticCatalog();
	const candidate = await candidateOf(exe);
	const foreign = admit({ ...candidate, provenance: { kind: "foreign" } }, catalog);
	expect(foreign).toEqual({ kind: "refused", refusal: { code: "foreign-image", missing: OPEN_FIRMWARE_PREREQUISITES } });
	expect(OPEN_FIRMWARE_PREREQUISITES).toHaveLength(4);
	for (const implied of [0x3000, null]) {
		expect(admit({ ...candidate, impliedBase: implied }, catalog)).toEqual({
			kind: "refused",
			refusal: { code: "wrong-base", implied, expected: 0x3200 },
		});
	}
	expect(admit({ ...candidate, versionBlock: null }, catalog)).toEqual({ kind: "refused", refusal: { code: "no-version-block" } });
});

test("the shipped catalog pins V1.01.13 by the sums the board answered in U1", () => {
	expect(CATALOG).toHaveLength(1);
	expect(CATALOG[0]).toMatchObject({
		version: "V1.01.13",
		image: { bytes: 34_268, sha256: sha256Literal("b77f3fe9d3dfe86e9326633d5edf6f4c1c092c9efa0550d60832a8f4d93d5f3d") },
	});
	expect(Number(CATALOG[0]?.image.wireSum32)).toBe(0xf3d3_dbd2);
});
