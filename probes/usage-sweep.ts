// expect: none
// The drop-sweep call site from docs/design.md, compiled against the sketch's test modules.
import type { FlashableImage } from "../core/firmware";
import { createKit } from "../core/kit";
import { FakeTab60 } from "../testing/fake-tab60";

declare const image: FlashableImage;
declare const cleanRunPackets: number;
declare function expect<T>(actual: T): { toBe(expected: T): void; toEqual(expected: T): void };

async function sweep(rewrite: boolean): Promise<void> {
	const target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 };
	for (let packet = 0; packet < cleanRunPackets; packet++) {
		const board = new FakeTab60({ starting: "untrusted-image", target, loseLinkAtPacket: packet });
		const kit = createKit(board.port());
		const end = await kit.makeOfficial(image, { rewrite });
		expect(end.kind).toBe("finished");
		expect(board.violations).toEqual([]);
		expect(await board.bootTarget()).toEqual({ mode: "app", versionPageSha256: image.entry.versionBlock.sha256 });
	}
}
void sweep;
