/**
 * The nine frames U1 may send, as a runtime allowlist in the lab page's link wrap. It is a second gate behind the
 * core's egress audit, and its literals never come from the codec: this file reaches core/ only for port.ts types
 * and what testing/transcript.ts pulls in (probes/boundaries.ts rule u1-frames-independence).
 */
import type { Link } from "../core/port";
import { type TranscriptEntry, hexOf, recording } from "../testing/transcript";

/** The nine frames U1 may send, byte for byte, written out instead of encoded so neither gate trusts the codec. */
export const U1_FRAMES: readonly string[] = [
	"12020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"12000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"12010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"12200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"12210000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"12220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"1d01000000020000dc85000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"11000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	"11010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
];

/** The lab refused a frame the core's audit passed, before it reached the transcript or the wire. */
export class FrameNotAllowed extends Error {
	override readonly name = "FrameNotAllowed";

	constructor(readonly hex: string) {
		super(`${hex} is not one of the nine U1 frames`);
	}
}

export function onlyU1Frames(link: Link): Link {
	return {
		mode: link.mode,
		lost: link.lost,
		async send(report) {
			const hex = hexOf(report);
			if (!U1_FRAMES.includes(hex)) throw new FrameNotAllowed(hex);
			await link.send(report);
		},
		next: (timeoutMs) => link.next(timeoutMs),
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	};
}

/** The lab's link wrap: the core sends through the allowlist, then the recording, then the WebHID link. */
export const u1Wrap =
	(sink: (entry: TranscriptEntry) => void, now?: () => number) =>
	(link: Link): Link =>
		onlyU1Frames(recording(link, sink, now));
