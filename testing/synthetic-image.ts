/**
 * A flashable image CI can hold: synthetic bytes at the real image's length, admitted against a one-entry catalog
 * built from them. The flash job recognizes the entry it writes (flash.ts makeOfficial), so this converges like V1.01.13.
 */
import { EXPECTED_LAYOUT } from "../core/device";
import { type CatalogEntry, type FlashableImage, admit, crc32, sha256, sum32, xorWords } from "../core/firmware";
import { syntheticImage, syntheticVersionBlock } from "./maav102";

export async function syntheticFlashable(bytes = 34_268): Promise<FlashableImage> {
	const plain = syntheticImage(bytes);
	const wire = xorWords(plain);
	const block = syntheticVersionBlock();
	const entry: CatalogEntry = {
		id: `synthetic-${bytes}`,
		version: "V9.99.99",
		layoutName: "US Layout",
		source: { url: "about:blank", exeSha256: await sha256(new Uint8Array(0)), exeBytes: 0 },
		image: { bytes, sha256: await sha256(plain), wireSum32: sum32(wire), wireCrc32: crc32(wire) },
		versionBlock: { sha256: await sha256(block) },
		oracle: "testing/synthetic-image.ts",
	};
	const admission = admit(
		{
			provenance: { kind: "vendor-package", exeSha256: entry.source.exeSha256 },
			layoutName: entry.layoutName,
			plainSha256: entry.image.sha256,
			impliedBase: EXPECTED_LAYOUT.protocolBase + EXPECTED_LAYOUT.fwOffset,
			wire: { bytes: wire, sum32: entry.image.wireSum32, crc32: entry.image.wireCrc32 },
			versionBlock: { bytes: block, sha256: entry.versionBlock.sha256, version: entry.version },
		},
		[entry],
	);
	if (admission.kind !== "admitted") throw new Error(`the synthetic image was refused: ${admission.refusal.code}`);
	return admission.image;
}
